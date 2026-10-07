/**
 * RemoteRelay: Remote Control without a tunnel. One Durable Object per
 * workstation, named `<organization id>:<workstation id>`, joins two WebSockets
 * and passes VNC bytes between them:
 *
 *   console   noVNC in an operator's browser, on the organization's own console
 *             address (`GET /api/console/remote`, session cookie, Workstations
 *             permission);
 *   device    the workstation's agent, which pipes its loopback x11vnc
 *             (127.0.0.1:5900) into it (`GET /api/devices/remote`, device token).
 *
 * A session starts when the console asks for one (`POST /api/clients/remote-session`):
 * the Worker opens it here with the SHA-256 of a random token, and the
 * organization's OrgHub tells the workstation, over the connection it already
 * holds, to join with that token. Either side may arrive first; the workstation
 * is told `ready` only once the console is there, because a VNC server speaks
 * first and noVNC must hear its greeting.
 *
 * Nothing about a workstation is exposed: no listener, DNS record, tunnel or
 * Cloudflare Access application, and the workstation only ever connects out.
 * x11vnc's per-boot password still guards the screen, typed by noVNC from the
 * console's live status, as before.
 *
 * Rules this code keeps (as OrgHub, cloudflare-control/AGENTS.md Rule 2d): no
 * timers, only the alarm; sockets are accepted with the hibernation API; state
 * that must survive hibernation is in SQLite or on the socket attachment.
 */

import { Env } from "./types";

/** Text either side sends to keep an idle session open; answered without waking this object. */
export const RELAY_PING = '{"type":"ping"}';
export const RELAY_PONG = '{"type":"pong"}';
/** Sent to the workstation once noVNC is connected: start talking to x11vnc now. */
export const RELAY_READY = '{"type":"ready"}';

/** Both sides must arrive within this long of the session being opened. */
export const RELAY_JOIN_SECONDS = 60;
/** A session ends after this long, however busy; the operator opens a new one. */
export const RELAY_MAX_SECONDS = 4 * 60 * 60;

export const CLOSE_RELAY_REPLACED = 4000;
export const CLOSE_RELAY_PEER_GONE = 4004;
export const CLOSE_RELAY_EXPIRED = 4008;

const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);

export type RelaySide = "console" | "device";

interface RelayAttachment {
  side: RelaySide;
  tokenHash: string;
}

interface SessionRow {
  token_hash: string;
  user_id: string;
  join_by: number;
  ends_at: number;
  [key: string]: string | number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function autoResponsePair(): WebSocketRequestResponsePair {
  const Pair = (globalThis as { WebSocketRequestResponsePair?: typeof WebSocketRequestResponsePair }).WebSocketRequestResponsePair;
  if (Pair) return new Pair(RELAY_PING, RELAY_PONG);
  return { request: RELAY_PING, response: RELAY_PONG } as WebSocketRequestResponsePair;
}

/** The relay's name for one workstation: bound to the organization the Worker authenticated. */
export function relayName(tenantId: string, clientId: string): string {
  return `${tenantId}:${clientId}`;
}

/** Hex SHA-256 of a session token: only the hash is stored or passed to the relay. */
export async function hashRelayToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh session token: 32 random bytes, hex. */
export function newRelayToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const RELAY_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export class RemoteRelay {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS binding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token_hash TEXT NOT NULL,
      user_id TEXT NOT NULL,
      join_by INTEGER NOT NULL,
      ends_at INTEGER NOT NULL
    )`);
    ctx.setWebSocketAutoResponse(autoResponsePair());
  }

  // ------------------------------------------------------------------ routing

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = request.headers.get("x-labkiosk-relay") || "";
    if (!this.bind(name)) return json({ error: "This relay belongs to another workstation" }, 409);
    try {
      if (url.pathname === "/open" && request.method === "POST") {
        const body = (await request.json()) as { tokenHash?: unknown; userId?: unknown };
        const tokenHash = typeof body.tokenHash === "string" ? body.tokenHash : "";
        const userId = typeof body.userId === "string" ? body.userId : "";
        if (!RELAY_TOKEN_PATTERN.test(tokenHash) || !userId) return json({ error: "Missing session" }, 400);
        await this.open(tokenHash, userId, Math.floor(Date.now() / 1000));
        return json({ status: "ok", joinSeconds: RELAY_JOIN_SECONDS });
      }
      if (url.pathname === "/console" || url.pathname === "/device") {
        return await this.upgrade(request, url.pathname === "/console" ? "console" : "device");
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(`[RemoteRelay ${name}] ${url.pathname} failed:`, err);
      return json({ error: "The Remote Control relay could not complete this request" }, 500);
    }
  }

  /** An object serves the workstation it was first used for, and only that one. */
  bind(name: string): boolean {
    if (!name) return false;
    const bound = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM binding WHERE id = 1").toArray();
    if (bound.length) return bound[0].name === name;
    this.ctx.storage.sql.exec("INSERT INTO binding (id, name) VALUES (1, ?)", name);
    return true;
  }

  private async upgrade(request: Request, side: RelaySide): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected a WebSocket upgrade" }, 426);
    }
    const tokenHash = request.headers.get("x-labkiosk-session-hash") || "";
    const userId = request.headers.get("x-labkiosk-user") || "";
    const refusal = this.joinRefusal(side, tokenHash, userId, Math.floor(Date.now() / 1000));
    if (refusal) return json({ error: refusal.message }, refusal.status);
    const Pair = (globalThis as { WebSocketPair?: typeof WebSocketPair }).WebSocketPair;
    if (!Pair) return json({ error: "WebSocket upgrades need the Workers runtime" }, 501);
    const pair = new Pair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    await this.accept(server, side, tokenHash);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ----------------------------------------------------------------- sessions

  /** Start a session, ending any other one for this workstation. */
  async open(tokenHash: string, userId: string, now: number): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      this.closeQuietly(ws, CLOSE_RELAY_REPLACED, "Another Remote Control session was opened for this workstation");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO session (id, token_hash, user_id, join_by, ends_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, user_id = excluded.user_id,
         join_by = excluded.join_by, ends_at = excluded.ends_at`,
      tokenHash,
      userId,
      now + RELAY_JOIN_SECONDS,
      now + RELAY_MAX_SECONDS
    );
    await this.ctx.storage.setAlarm((now + RELAY_JOIN_SECONDS) * 1000);
  }

  private session(): SessionRow | null {
    const rows = this.ctx.storage.sql.exec<SessionRow>("SELECT token_hash, user_id, join_by, ends_at FROM session WHERE id = 1").toArray();
    return rows[0] ?? null;
  }

  /** This session's socket on one side; a replaced session's sockets may still be closing. */
  private current(side: RelaySide, tokenHash: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(side)) {
      const a = ws.deserializeAttachment() as RelayAttachment | null;
      if (a?.tokenHash === tokenHash) return ws;
    }
    return null;
  }

  private endSession(): void {
    this.ctx.storage.sql.exec("DELETE FROM session WHERE id = 1");
  }

  /** Why a side may not join now, or null. Public so tests can ask without an upgrade. */
  joinRefusal(side: RelaySide, tokenHash: string, userId: string, now: number): { status: number; message: string } | null {
    const session = this.session();
    if (!session || !RELAY_TOKEN_PATTERN.test(tokenHash) || session.token_hash !== tokenHash) {
      return { status: 403, message: "This Remote Control session is not open" };
    }
    if (side === "console" && session.user_id !== userId) {
      return { status: 403, message: "This Remote Control session was opened by someone else" };
    }
    if (now > Number(session.join_by)) {
      return { status: 410, message: "This Remote Control session has expired; open it again" };
    }
    if (this.current(side, tokenHash)) {
      return { status: 409, message: `This Remote Control session already has its ${side}` };
    }
    return null;
  }

  /** Accept one side's socket. Public so tests can connect without an HTTP upgrade. */
  async accept(server: WebSocket, side: RelaySide, tokenHash: string): Promise<void> {
    this.ctx.acceptWebSocket(server, [side]);
    const attachment: RelayAttachment = { side, tokenHash };
    server.serializeAttachment(attachment);
    const device = this.current("device", tokenHash);
    if (device && this.current("console", tokenHash)) {
      device.send(RELAY_READY);
      const session = this.session();
      if (session) await this.ctx.storage.setAlarm(Number(session.ends_at) * 1000);
    }
  }

  // ------------------------------------------------------------------ traffic

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as RelayAttachment | null;
    const session = this.session();
    if (!attachment || !session || session.token_hash !== attachment.tokenHash) {
      this.closeQuietly(ws, CLOSE_RELAY_EXPIRED, "This Remote Control session has ended");
      return;
    }
    // VNC is binary. The only text either side sends is the keepalive, which
    // the runtime answers before this handler would see it.
    if (typeof message === "string") return;
    const other = this.current(attachment.side === "console" ? "device" : "console", attachment.tokenHash);
    if (!other) return;
    try {
      other.send(message);
    } catch (err) {
      console.warn("[RemoteRelay] Could not pass data on; ending the session:", err);
      this.closeAll(CLOSE_RELAY_PEER_GONE, "The other side of the session is gone");
      this.endSession();
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    this.departed(ws);
    try {
      ws.close(RESERVED_CLOSE_CODES.has(code) ? 1000 : code, reason);
    } catch (err) {
      console.warn("[RemoteRelay] Close handshake after close:", err);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.warn("[RemoteRelay] Socket error:", error);
    this.departed(ws);
  }

  /** When either side leaves, the session is over: the other is closed and cannot rejoin. */
  private departed(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as RelayAttachment | null;
    const session = this.session();
    if (!attachment || !session || session.token_hash !== attachment.tokenHash) return;
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) this.closeQuietly(other, CLOSE_RELAY_PEER_GONE, "The other side ended the session");
    }
    this.endSession();
  }

  async alarm(): Promise<void> {
    const session = this.session();
    if (!session) return;
    const now = Math.floor(Date.now() / 1000);
    const joined = Boolean(this.current("console", session.token_hash) && this.current("device", session.token_hash));
    if (now >= Number(session.ends_at)) {
      this.closeAll(CLOSE_RELAY_EXPIRED, "The Remote Control session reached its time limit");
      this.endSession();
    } else if (!joined && now >= Number(session.join_by)) {
      this.closeAll(CLOSE_RELAY_EXPIRED, "The workstation did not join the Remote Control session");
      this.endSession();
    } else {
      await this.ctx.storage.setAlarm((joined ? Number(session.ends_at) : Number(session.join_by)) * 1000);
    }
  }

  private closeAll(code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets()) this.closeQuietly(ws, code, reason);
  }

  private closeQuietly(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch (err) {
      console.warn("[RemoteRelay] Closing a socket that was already closed:", err);
    }
  }
}

// --- How the Worker reaches a relay -----------------------------------------

function relayStub(env: Env, tenantId: string, clientId: string): DurableObjectStub {
  if (!env.REMOTE_RELAY) throw new Error("No REMOTE_RELAY Durable Object binding. Declare it in wrangler.jsonc.");
  return env.REMOTE_RELAY.get(env.REMOTE_RELAY.idFromName(relayName(tenantId, clientId)));
}

/** Open a session for one workstation; returns false when the relay refused. */
export async function openRelaySession(env: Env, tenantId: string, clientId: string, tokenHash: string, userId: string): Promise<boolean> {
  const res = await relayStub(env, tenantId, clientId).fetch(
    new Request("https://remote-relay/open", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-labkiosk-relay": relayName(tenantId, clientId) },
      body: JSON.stringify({ tokenHash, userId })
    })
  );
  if (!res.ok) console.error(`[RemoteRelay] Opening ${relayName(tenantId, clientId)} answered HTTP ${res.status}`);
  return res.ok;
}

/** Hand one side's WebSocket upgrade to the workstation's relay, with an identity only the Worker can set. */
export function relayUpgrade(
  env: Env,
  tenantId: string,
  clientId: string,
  side: RelaySide,
  tokenHash: string,
  userId = ""
): Promise<Response> {
  return relayStub(env, tenantId, clientId).fetch(
    new Request(`https://remote-relay/${side}`, {
      headers: {
        Upgrade: "websocket",
        "x-labkiosk-relay": relayName(tenantId, clientId),
        "x-labkiosk-session-hash": tokenHash,
        "x-labkiosk-user": userId
      }
    })
  );
}
