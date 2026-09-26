/**
 * OrgHub: one Durable Object per organization, named by the organization's id.
 *
 * It holds everything about an organization's workstations that changes by the
 * second -- who is online, which page each shows, whether it is locked, its
 * latest screen -- and the queue of commands waiting for them. None of that is
 * written to D1 per heartbeat any more: a heartbeat used to cost about eight D1
 * queries and a row rewrite carrying a screenshot, and every open console read
 * all of those screenshots back every three seconds.
 *
 * Workstations connect over WebSockets accepted with the hibernation API, so an
 * idle organization costs nothing: pings are answered by the runtime without
 * waking this object, and a workstation sends a message only when something
 * changes. Screens are captured only while a console is looking at them, and a
 * frame is relayed to that console, never stored. Agents installed before the
 * WebSocket transport keep using `POST /api/telemetry`, which the Worker hands to
 * `/heartbeat` here and which answers exactly as the old route did.
 *
 * D1 stays the record: the organization, its settings and allowlist, the
 * workstation registry (with groups and last-known state) and the audit log.
 * This object reads that configuration when it needs it, caches it, and is told
 * by the Worker whenever an administrator changes it.
 *
 * Rules this code keeps (see cloudflare-control/AGENTS.md, Rule 2d):
 * - No setTimeout/setInterval: they prevent hibernation. Timed work is an alarm.
 * - State that must survive hibernation rides on the socket attachment (16 KB)
 *   or in this object's SQLite; screen frames are never persisted.
 * - The organization is whatever the Worker bound this object to, and a request
 *   naming another one is refused.
 */

import { Env, Tenant } from "./types";
import { getDatabase } from "./database";
import {
  findTenantById,
  buildEffectiveWhitelist,
  listDeviceBroadcasts,
  upsertDeviceRegistry,
  setTenantOnlineCount,
  DeviceRegistryRow
} from "./db";
import { safeHttpUrl, cleanCustomDomain } from "./escape";
import { PortalContext, isPortalContext, portalUrlFromContext } from "./portal_url";

/** Text a workstation sends to prove it is alive; answered without waking the object. */
export const HUB_PING = '{"type":"ping"}';
export const HUB_PONG = '{"type":"pong"}';

/** A WebSocket workstation with no ping or message for this long is offline. */
const SOCKET_STALE_MS = 75_000;
/** An HTTP-heartbeat workstation (older agents, every 3 s) is offline after this. */
const HTTP_ONLINE_MS = 12_000;
/** Longest a cached copy of the organization's settings is trusted without a reload. */
const CONFIG_TTL_MS = 5 * 60_000;
/** How long an undelivered command waits for an offline workstation. */
const COMMAND_TTL_SECONDS = 60;
/** Delay before changed workstation state is written back to D1. */
const FLUSH_DELAY_MS = 20_000;
/** While a console is open, how often offline machines are swept and counts refreshed. */
const CONSOLE_SWEEP_MS = 30_000;
/** A last-seen time in D1 is refreshed at most this often for an unchanged workstation. */
const REGISTRY_REFRESH_MS = 5 * 60_000;
/** How long a polling console's interest in a screen lasts without being renewed. */
const POLL_WATCH_LEASE_MS = 10_000;
/** Seconds between frames a watched workstation sends. */
export const FRAME_INTERVAL_SECONDS = 3;
/** Largest screen frame accepted (a base64 data URL). */
export const MAX_FRAME_BYTES = 256 * 1024;
const MAX_WATCHED = 500;
const MAX_VNC_PASSWORD_LENGTH = 64;
const CLIENT_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;

/** Close codes a workstation acts on. 4001 and 4003 match HTTP 401 and 403. */
export const CLOSE_REMOVED = 4001;
export const CLOSE_INACTIVE = 4003;
export const CLOSE_REPLACED = 4000;
export const CLOSE_STALE = 4008;
/** Close codes a peer reports but no endpoint may send (RFC 6455, 7.4.1). */
const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);

type CommandAction = "lock" | "unlock" | "navigate" | "reload" | "reboot" | "shutdown" | "clear-session" | "mute";

export interface DeviceMeta {
  tenantId: string;
  clientId: string;
  ip: string;
  portal: PortalContext;
}

export interface ConsoleMeta {
  tenantId: string;
  userId: string;
}

interface DeviceAttachment {
  kind: "device";
  tenantId: string;
  clientId: string;
  clientNum: number;
  activeUrl: string;
  isLocked: boolean;
  ip: string;
  vncPassword?: string;
  remoteHost?: string;
  portal: PortalContext;
  connectedAt: number;
  /** Whether this workstation has been asked to send frames. */
  streaming: boolean;
  /** Its registry row in D1 is behind. */
  dirty: boolean;
  /** When its registry row was last written. */
  writtenAt: number;
}

interface ConsoleAttachment {
  kind: "console";
  tenantId: string;
  userId: string;
  watch: string[];
}

interface HttpClient {
  clientNum: number;
  activeUrl: string;
  isLocked: boolean;
  ip: string;
  vncPassword?: string;
  remoteHost?: string;
  portal: PortalContext;
  lastSeen: number;
  dirty: boolean;
  writtenAt: number;
}

/** What a console and `/api/clients` see of one workstation. */
export interface LiveStatus {
  clientId: string;
  clientNum: number;
  activeUrl: string;
  isLocked: boolean;
  ip: string;
  vncPassword?: string;
  remoteHost?: string;
  online: boolean;
  lastSeen: number;
  transport: "websocket" | "http";
  thumbnail?: string;
}

interface HubConfig {
  tenant: Tenant;
  whitelist: string[];
  deviceBroadcasts: Map<string, { url: string | null; epoch: number }>;
  loadedAt: number;
}

export interface WorkstationConfig {
  whitelist: string[];
  mode: string;
  targetUrl: string;
  broadcastUrl: string;
  broadcastEpoch: number;
}

export interface QueuedCommand {
  id: string;
  target: string;
  action: CommandAction;
  url?: string;
  message?: string;
  epoch?: number;
  timestamp: number;
}

export interface HeartbeatInput {
  clientId: string;
  ip: string;
  portal: PortalContext;
  payload: {
    clientNum?: unknown;
    activeUrl?: unknown;
    isLocked?: unknown;
    thumbnail?: unknown;
    vncPassword?: unknown;
    remoteHost?: unknown;
  };
}

export interface EnqueueInput {
  targets: string[];
  action: CommandAction;
  url?: string;
  message?: string;
  epoch?: number;
  portal?: boolean;
  /** The organization's broadcast changed with this command; reload before delivering. */
  reloadConfig?: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A frame is a JPEG or PNG data URL inside the size budget, or nothing. */
export function acceptableFrame(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("data:image/jpeg;base64,") && !value.startsWith("data:image/png;base64,")) return null;
  if (value.length > MAX_FRAME_BYTES) return null;
  return value;
}

function autoResponsePair(): WebSocketRequestResponsePair {
  const Pair = (globalThis as { WebSocketRequestResponsePair?: typeof WebSocketRequestResponsePair }).WebSocketRequestResponsePair;
  if (Pair) return new Pair(HUB_PING, HUB_PONG);
  // The local stand-in used by tests reads the same two fields.
  return { request: HUB_PING, response: HUB_PONG } as WebSocketRequestResponsePair;
}

export class OrgHub {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private tenantId: string | null;
  private config: HubConfig | null = null;
  private readonly http = new Map<string, HttpClient>();
  private readonly frames = new Map<string, string>();
  private readonly lastMessage = new Map<string, number>();
  private readonly pollWatch = new Map<string, number>();
  /** Sockets whose departure was already handled, so a late close event is not counted twice. */
  private readonly departed = new WeakSet<WebSocket>();
  private flushedOnline: number;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_commands_target ON commands(target, expires_at)");
    sql.exec(`CREATE TABLE IF NOT EXISTS deliveries (
      command_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      PRIMARY KEY (command_id, client_id)
    )`);
    sql.exec("CREATE TABLE IF NOT EXISTS revoked (client_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.tenantId = this.readMeta("tenantId");
    this.flushedOnline = Number(this.readMeta("flushedOnline") ?? "-1");
    ctx.setWebSocketAutoResponse(autoResponsePair());
  }

  // ------------------------------------------------------------------ routing

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tenantId = request.headers.get("x-labkiosk-tenant") || "";
    if (!this.bind(tenantId)) {
      return json({ error: "This organization hub belongs to another organization" }, 409);
    }
    try {
      switch (url.pathname) {
        case "/device-ws":
          return await this.upgrade(request, "device");
        case "/console-ws":
          return await this.upgrade(request, "console");
        case "/heartbeat":
          return await this.handleHeartbeat((await request.json()) as HeartbeatInput);
        case "/enqueue":
          return json({ commandIds: await this.enqueue((await request.json()) as EnqueueInput) });
        case "/live": {
          const body = request.method === "POST" ? ((await request.json()) as { watch?: unknown }) : {};
          await this.leasePollWatch(body.watch);
          return json({ clients: this.liveClients(true) });
        }
        case "/config-changed":
          await this.configChanged();
          return json({ status: "ok" });
        case "/remove-device":
          await this.removeDevice(String(((await request.json()) as { clientId?: unknown }).clientId || ""));
          return json({ status: "ok" });
        case "/device-enrolled":
          this.deviceEnrolled(String(((await request.json()) as { clientId?: unknown }).clientId || ""));
          return json({ status: "ok" });
        default:
          return json({ error: "Not found" }, 404);
      }
    } catch (err) {
      console.error(`[OrgHub ${this.tenantId}] ${url.pathname} failed:`, err);
      return json({ error: "The organization hub could not complete this request" }, 500);
    }
  }

  /** An object serves the organization it was first bound to, and only that one. */
  bind(tenantId: string): boolean {
    if (!tenantId) return false;
    if (this.tenantId) return this.tenantId === tenantId;
    this.tenantId = tenantId;
    this.writeMeta("tenantId", tenantId);
    return true;
  }

  private async upgrade(request: Request, kind: "device" | "console"): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected a WebSocket upgrade" }, 426);
    }
    const raw = request.headers.get("x-labkiosk-meta");
    let meta: unknown = null;
    try {
      meta = raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error("[OrgHub] Unreadable connection metadata:", err);
    }
    const Pair = (globalThis as { WebSocketPair?: typeof WebSocketPair }).WebSocketPair;

    if (kind === "device") {
      const device = this.parseDeviceMeta(meta);
      if (!device) return json({ error: "Missing workstation identity" }, 400);
      // Refused before anything else, as a plain 401/403 the agent reads like the HTTP heartbeat's.
      const refusal = await this.refusalFor(device.clientId);
      if (refusal) return json({ error: refusal.message }, refusal.status);
      if (!Pair) return json({ error: "WebSocket upgrades need the Workers runtime" }, 501);
      const pair = new Pair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      await this.acceptDevice(server, device);
      return new Response(null, { status: 101, webSocket: client });
    }

    const consoleMeta = this.parseConsoleMeta(meta);
    if (!consoleMeta) return json({ error: "Missing console identity" }, 400);
    if (!Pair) return json({ error: "WebSocket upgrades need the Workers runtime" }, 501);
    const pair = new Pair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    await this.acceptConsole(server, consoleMeta);
    return new Response(null, { status: 101, webSocket: client });
  }

  private parseDeviceMeta(meta: unknown): DeviceMeta | null {
    if (!meta || typeof meta !== "object") return null;
    const m = meta as Record<string, unknown>;
    const clientId = String(m.clientId || "");
    if (!CLIENT_ID_PATTERN.test(clientId) || !isPortalContext(m.portal)) return null;
    return { tenantId: this.tenantId!, clientId, ip: String(m.ip || ""), portal: m.portal };
  }

  private parseConsoleMeta(meta: unknown): ConsoleMeta | null {
    if (!meta || typeof meta !== "object") return null;
    const userId = String((meta as Record<string, unknown>).userId || "");
    return userId ? { tenantId: this.tenantId!, userId } : null;
  }

  // ---------------------------------------------------------- configuration

  private async loadConfig(force = false): Promise<HubConfig | null> {
    if (!force && this.config && Date.now() - this.config.loadedAt < CONFIG_TTL_MS) return this.config;
    const db = getDatabase(this.env);
    const tenant = await findTenantById(db, this.tenantId!);
    if (!tenant) {
      this.config = null;
      return null;
    }
    const [whitelist, broadcasts] = await Promise.all([
      buildEffectiveWhitelist(db, tenant.id),
      listDeviceBroadcasts(db, tenant.id)
    ]);
    this.config = { tenant, whitelist, deviceBroadcasts: broadcasts, loadedAt: Date.now() };
    return this.config;
  }

  /** Why a workstation may not connect or heartbeat right now, or null. */
  private async refusalFor(clientId: string): Promise<{ status: 401 | 403; message: string } | null> {
    if (this.isRevoked(clientId)) return { status: 401, message: "This workstation has been removed" };
    const config = await this.loadConfig();
    if (!config || config.tenant.status !== "active") {
      return { status: 403, message: "This organization is not active" };
    }
    return null;
  }

  /** What one workstation is told: its allowlist, where to be, and the live broadcast. */
  private configFor(config: HubConfig, clientId: string, portal: PortalContext): WorkstationConfig & { portalUrl: string } {
    const tenant = config.tenant;
    const own = config.deviceBroadcasts.get(clientId) ?? { url: null, epoch: 0 };
    const organizationEpoch = Number(tenant.broadcast_epoch) || 0;
    // The newer of the organization-wide and the per-workstation broadcast wins;
    // a winner with no URL is a reset, and the workstation gets its portal.
    const winner = own.epoch > organizationEpoch ? own : { url: tenant.broadcast_url ?? null, epoch: organizationEpoch };
    const validated = winner.url ? safeHttpUrl(winner.url) : null;
    const active = validated ? { url: validated, epoch: winner.epoch } : null;

    const whitelist = [...config.whitelist];
    if (active) {
      const host = new URL(active.url).hostname.toLowerCase();
      if (host && !whitelist.includes(host)) {
        whitelist.push(host);
        whitelist.sort();
      }
    }
    const portalUrl = portalUrlFromContext(tenant, portal);
    return {
      whitelist,
      mode: tenant.mode,
      targetUrl: active?.url || portalUrl,
      broadcastUrl: active?.url || "",
      broadcastEpoch: active?.epoch || 0,
      portalUrl
    };
  }

  /** The Worker saved a change a workstation must hear about. */
  async configChanged(): Promise<void> {
    const config = await this.loadConfig(true);
    const devices = this.ctx.getWebSockets("device");
    if (!config || config.tenant.status !== "active") {
      for (const ws of devices) ws.close(CLOSE_INACTIVE, "This organization is not active");
      return;
    }
    for (const ws of devices) {
      const a = this.deviceAttachment(ws);
      if (!a) continue;
      const { portalUrl: _portal, ...update } = this.configFor(config, a.clientId, a.portal);
      this.sendTo(ws, { type: "config", ...update });
    }
  }

  // ------------------------------------------------------------- workstations

  /** Accept a workstation's socket. Public so the local stand-in can connect without an HTTP upgrade. */
  async acceptDevice(server: WebSocket, meta: DeviceMeta): Promise<void> {
    for (const old of this.ctx.getWebSockets(`device:${meta.clientId}`)) {
      old.close(CLOSE_REPLACED, "Replaced by a newer connection");
    }
    this.ctx.acceptWebSocket(server, ["device", `device:${meta.clientId}`]);
    const now = Date.now();
    const previous = this.http.get(meta.clientId);
    const attachment: DeviceAttachment = {
      kind: "device",
      tenantId: meta.tenantId,
      clientId: meta.clientId,
      clientNum: previous?.clientNum ?? 1,
      activeUrl: previous?.activeUrl ?? "",
      isLocked: previous?.isLocked ?? false,
      ip: meta.ip,
      vncPassword: previous?.vncPassword,
      remoteHost: previous?.remoteHost,
      portal: meta.portal,
      connectedAt: now,
      streaming: false,
      dirty: false,
      writtenAt: now
    };
    this.http.delete(meta.clientId);
    this.lastMessage.set(meta.clientId, now);
    server.serializeAttachment(attachment);

    // A new workstation appears in the console straight away.
    await this.writeRegistry([this.registryRow(attachment, now)]);

    const config = await this.loadConfig();
    if (config) {
      const { portalUrl, ...update } = this.configFor(config, meta.clientId, meta.portal);
      this.sendTo(server, { type: "config", ...update, commands: this.pendingFor(meta.clientId, portalUrl) });
    }
    this.updateStreaming();
    this.notifyConsoles({ type: "status", client: this.statusOf(attachment, now) });
    this.recordEvent("connect", meta.clientId);
    await this.ensureAlarm(FLUSH_DELAY_MS);
  }

  private async handleHeartbeat(input: HeartbeatInput): Promise<Response> {
    const clientId = String(input?.clientId || "");
    if (!CLIENT_ID_PATTERN.test(clientId) || !isPortalContext(input.portal)) {
      return json({ error: "Missing workstation identity" }, 400);
    }
    const refusal = await this.refusalFor(clientId);
    if (refusal) return json({ error: refusal.message, refused: refusal.status }, refusal.status);

    const now = Date.now();
    const payload = input.payload || {};
    const previous = this.http.get(clientId);
    const status = this.normalizeStatus(payload, previous);
    const changed =
      !previous ||
      previous.activeUrl !== status.activeUrl ||
      previous.isLocked !== status.isLocked ||
      previous.clientNum !== status.clientNum ||
      previous.ip !== String(input.ip || "") ||
      previous.vncPassword !== status.vncPassword ||
      previous.remoteHost !== status.remoteHost;
    const client: HttpClient = {
      ...status,
      ip: String(input.ip || ""),
      portal: input.portal,
      lastSeen: now,
      dirty: Boolean(previous?.dirty) || changed || now - (previous?.writtenAt ?? 0) > REGISTRY_REFRESH_MS,
      writtenAt: previous?.writtenAt ?? 0
    };
    this.http.set(clientId, client);

    const frame = acceptableFrame(payload.thumbnail);
    if (frame) this.relayFrame(clientId, frame);

    if (!previous) {
      // First contact since this object woke: the registry row exists at once.
      client.writtenAt = now;
      client.dirty = false;
      await this.writeRegistry([this.registryRow({ clientId, ...client }, now)]);
      this.recordEvent("connect", clientId);
    }
    if (changed) this.notifyConsoles({ type: "status", client: this.httpStatus(clientId, client, now) });
    if (client.dirty) await this.ensureAlarm(FLUSH_DELAY_MS);

    const config = (await this.loadConfig())!;
    const { portalUrl, ...update } = this.configFor(config, clientId, input.portal);
    return json({ status: "ok", commands: this.pendingFor(clientId, portalUrl), ...update });
  }

  /** Workstation-reported state, validated; unset fields keep what was known. */
  private normalizeStatus(
    payload: Record<string, unknown>,
    previous?: { clientNum: number; activeUrl: string; isLocked: boolean; vncPassword?: string; remoteHost?: string }
  ) {
    const clientNum = Number(payload.clientNum);
    const vncPassword =
      typeof payload.vncPassword === "string" && payload.vncPassword.trim()
        ? payload.vncPassword.trim().slice(0, MAX_VNC_PASSWORD_LENGTH)
        : previous?.vncPassword;
    const remoteHost =
      typeof payload.remoteHost === "string" ? cleanCustomDomain(payload.remoteHost) || previous?.remoteHost : previous?.remoteHost;
    return {
      clientNum: Number.isInteger(clientNum) && clientNum > 0 && clientNum < 100_000 ? clientNum : previous?.clientNum ?? 1,
      activeUrl: safeHttpUrl(payload.activeUrl) || previous?.activeUrl || "",
      isLocked: typeof payload.isLocked === "boolean" ? payload.isLocked : previous?.isLocked ?? false,
      vncPassword,
      remoteHost
    };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(message);
    } catch (err) {
      console.warn("[OrgHub] Ignoring a message that is not JSON:", err);
      return;
    }
    const attachment = ws.deserializeAttachment() as DeviceAttachment | ConsoleAttachment | null;
    if (!attachment) return;
    if (attachment.kind === "console") {
      if (data.type === "watch") this.setConsoleWatch(ws, attachment, data.clientIds);
      return;
    }

    const now = Date.now();
    this.lastMessage.set(attachment.clientId, now);
    if (data.type === "ping") {
      ws.send(HUB_PONG);
    } else if (data.type === "status") {
      const next = this.normalizeStatus(data, attachment);
      const changed =
        next.activeUrl !== attachment.activeUrl ||
        next.isLocked !== attachment.isLocked ||
        next.clientNum !== attachment.clientNum ||
        next.vncPassword !== attachment.vncPassword ||
        next.remoteHost !== attachment.remoteHost;
      if (changed) {
        const updated: DeviceAttachment = { ...attachment, ...next, dirty: true };
        ws.serializeAttachment(updated);
        this.notifyConsoles({ type: "status", client: this.statusOf(updated, now) });
        await this.ensureAlarm(FLUSH_DELAY_MS);
      }
    } else if (data.type === "frame") {
      const frame = acceptableFrame(data.thumbnail);
      if (frame) this.relayFrame(attachment.clientId, frame);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    await this.socketGone(ws);
    // Completing the close handshake is safe even when the runtime already did.
    // 1005, 1006 and 1015 only describe a close; none may be sent in one.
    try {
      ws.close(RESERVED_CLOSE_CODES.has(code) ? 1000 : code, reason);
    } catch (err) {
      console.warn("[OrgHub] Close handshake after close:", err);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.warn("[OrgHub] Socket error:", error);
    await this.socketGone(ws);
  }

  private async socketGone(ws: WebSocket): Promise<void> {
    if (this.departed.has(ws)) return;
    this.departed.add(ws);
    const attachment = ws.deserializeAttachment() as DeviceAttachment | ConsoleAttachment | null;
    if (!attachment) return;
    if (attachment.kind === "console") {
      this.updateStreaming(ws);
      return;
    }
    // A replaced socket is not an offline workstation: the new one is already here.
    const current = this.ctx.getWebSockets(`device:${attachment.clientId}`).filter((other) => other !== ws);
    if (current.length) return;
    const now = Date.now();
    this.frames.delete(attachment.clientId);
    this.lastMessage.delete(attachment.clientId);
    if (!this.isRevoked(attachment.clientId)) {
      await this.writeRegistry([this.registryRow(attachment, now)]);
    }
    this.notifyConsoles({ type: "status", client: { ...this.statusOf(attachment, now), online: false } });
    this.recordEvent("disconnect", attachment.clientId, now, ws);
    await this.ensureAlarm(FLUSH_DELAY_MS);
  }

  async removeDevice(clientId: string): Promise<void> {
    if (!CLIENT_ID_PATTERN.test(clientId)) return;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO revoked (client_id, revoked_at) VALUES (?, ?)",
      clientId,
      Math.floor(Date.now() / 1000)
    );
    for (const ws of this.ctx.getWebSockets(`device:${clientId}`)) ws.close(CLOSE_REMOVED, "This workstation has been removed");
    this.http.delete(clientId);
    this.frames.delete(clientId);
    this.lastMessage.delete(clientId);
    this.notifyConsoles({ type: "removed", clientId });
  }

  deviceEnrolled(clientId: string): void {
    if (!CLIENT_ID_PATTERN.test(clientId)) return;
    this.ctx.storage.sql.exec("DELETE FROM revoked WHERE client_id = ?", clientId);
  }

  private isRevoked(clientId: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 AS hit FROM revoked WHERE client_id = ?", clientId).toArray().length > 0;
  }

  // ----------------------------------------------------------------- commands

  async enqueue(input: EnqueueInput): Promise<string[]> {
    const targets = Array.isArray(input.targets) ? input.targets.map(String).filter(Boolean) : [];
    if (!targets.length) return [];
    if (input.reloadConfig) await this.loadConfig(true);

    const now = Math.floor(Date.now() / 1000);
    const payloadJson = JSON.stringify({
      url: input.url,
      message: input.message,
      epoch: input.epoch,
      ...(input.portal ? { portal: true } : {})
    });
    const ids: string[] = [];
    for (const target of targets) {
      const id = crypto.randomUUID();
      ids.push(id);
      this.ctx.storage.sql.exec(
        "INSERT INTO commands (id, target, action, payload_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        target,
        input.action,
        payloadJson,
        now,
        now + COMMAND_TTL_SECONDS
      );
    }

    // Deliver now to every workstation that is connected; the rest get it on
    // their next connection or heartbeat, until it expires.
    const addressed = targets.includes("all")
      ? this.ctx.getWebSockets("device")
      : targets.flatMap((t) => this.ctx.getWebSockets(`device:${t}`));
    const config = await this.loadConfig();
    for (const ws of addressed) {
      const a = this.deviceAttachment(ws);
      if (!a || !config) continue;
      const commands = this.pendingFor(a.clientId, this.configFor(config, a.clientId, a.portal).portalUrl);
      if (commands.length) this.sendTo(ws, { type: "commands", commands });
    }

    // The console shows a lock at once rather than when the machine reports it.
    if (input.action === "lock" || input.action === "unlock") {
      const locked = input.action === "lock";
      for (const ws of addressed) {
        const a = this.deviceAttachment(ws);
        if (a && a.isLocked !== locked) {
          const updated = { ...a, isLocked: locked, dirty: true };
          ws.serializeAttachment(updated);
          this.notifyConsoles({ type: "status", client: this.statusOf(updated, Date.now()) });
        }
      }
      for (const [clientId, client] of this.http) {
        if (targets.includes("all") || targets.includes(clientId)) client.isLocked = locked;
      }
    }
    await this.ensureAlarm(FLUSH_DELAY_MS);
    return ids;
  }

  /**
   * Commands this workstation has not received yet, marked delivered.
   * An organization-wide command stays queued until it expires so a machine that
   * was offline still gets it, but each machine gets it once; a command for one
   * machine is retired as soon as it is delivered.
   */
  private pendingFor(clientId: string, portalUrl: string): QueuedCommand[] {
    const now = Math.floor(Date.now() / 1000);
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec(
        `SELECT id, target, action, payload_json, created_at FROM commands c
         WHERE (c.target = 'all' OR c.target = ?) AND c.expires_at > ?
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.command_id = c.id AND d.client_id = ?)
         ORDER BY c.created_at ASC`,
        clientId,
        now,
        clientId
      )
      .toArray() as Array<{ id: string; target: string; action: string; payload_json: string | null; created_at: number }>;

    const commands: QueuedCommand[] = [];
    for (const row of rows) {
      let payload: { url?: string; message?: string; epoch?: number; portal?: boolean } = {};
      try {
        payload = row.payload_json ? JSON.parse(row.payload_json) : {};
      } catch (err) {
        console.warn(`[OrgHub] Discarding a malformed payload for command ${row.id}:`, err);
      }
      commands.push({
        id: row.id,
        target: row.target,
        action: row.action as CommandAction,
        // A reset carries no URL: it is this workstation's own portal.
        url: payload.portal ? portalUrl : payload.url,
        message: payload.message,
        epoch: payload.epoch,
        timestamp: row.created_at
      });
      if (row.target === clientId) {
        sql.exec("DELETE FROM commands WHERE id = ?", row.id);
      } else {
        sql.exec("INSERT OR IGNORE INTO deliveries (command_id, client_id) VALUES (?, ?)", row.id, clientId);
      }
    }
    return commands;
  }

  private purgeExpiredCommands(): void {
    const now = Math.floor(Date.now() / 1000);
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM deliveries WHERE command_id IN (SELECT id FROM commands WHERE expires_at <= ?)", now);
    sql.exec("DELETE FROM commands WHERE expires_at <= ?", now);
  }

  // ------------------------------------------------------------------ consoles

  /** Accept a console's socket. Public so the local stand-in can connect without an HTTP upgrade. */
  async acceptConsole(server: WebSocket, meta: ConsoleMeta): Promise<void> {
    this.ctx.acceptWebSocket(server, ["console"]);
    const attachment: ConsoleAttachment = { kind: "console", tenantId: meta.tenantId, userId: meta.userId, watch: [] };
    server.serializeAttachment(attachment);
    this.sendTo(server, { type: "snapshot", clients: this.liveClients(false), frameIntervalSeconds: FRAME_INTERVAL_SECONDS });
    await this.ensureAlarm(CONSOLE_SWEEP_MS);
  }

  private setConsoleWatch(ws: WebSocket, attachment: ConsoleAttachment, raw: unknown): void {
    const watch = Array.isArray(raw)
      ? Array.from(new Set(raw.map((id) => String(id)).filter((id) => CLIENT_ID_PATTERN.test(id)))).slice(0, MAX_WATCHED)
      : [];
    ws.serializeAttachment({ ...attachment, watch });
    // The latest frame of a newly watched screen, if there is one, arrives at once.
    for (const id of watch) {
      if (!attachment.watch.includes(id)) {
        const frame = this.frames.get(id);
        if (frame) this.sendTo(ws, { type: "frame", clientId: id, thumbnail: frame });
      }
    }
    this.updateStreaming();
  }

  private async leasePollWatch(raw: unknown): Promise<void> {
    if (!Array.isArray(raw)) return;
    const until = Date.now() + POLL_WATCH_LEASE_MS;
    for (const id of raw.slice(0, MAX_WATCHED)) {
      const clientId = String(id);
      if (CLIENT_ID_PATTERN.test(clientId)) this.pollWatch.set(clientId, until);
    }
    this.updateStreaming();
    await this.ensureAlarm(POLL_WATCH_LEASE_MS + 1000);
  }

  /** Which screens someone is looking at, across every console. */
  private watchedIds(excluding?: WebSocket): Set<string> {
    const watched = new Set<string>();
    for (const ws of this.ctx.getWebSockets("console")) {
      if (ws === excluding) continue;
      const a = ws.deserializeAttachment() as ConsoleAttachment | null;
      for (const id of a?.watch || []) watched.add(id);
    }
    const now = Date.now();
    for (const [id, until] of this.pollWatch) {
      if (until > now) watched.add(id);
      else this.pollWatch.delete(id);
    }
    return watched;
  }

  /** Tell each connected workstation whether to send frames. Nobody watching means none. */
  private updateStreaming(closingConsole?: WebSocket): void {
    const watched = this.watchedIds(closingConsole);
    for (const ws of this.ctx.getWebSockets("device")) {
      const a = this.deviceAttachment(ws);
      if (!a) continue;
      const want = watched.has(a.clientId);
      if (a.streaming !== want) {
        ws.serializeAttachment({ ...a, streaming: want });
        this.sendTo(ws, { type: "frames", on: want, intervalSeconds: FRAME_INTERVAL_SECONDS });
      }
      if (!want) this.frames.delete(a.clientId);
    }
  }

  private relayFrame(clientId: string, frame: string): void {
    this.frames.set(clientId, frame);
    const message = JSON.stringify({ type: "frame", clientId, thumbnail: frame });
    for (const ws of this.ctx.getWebSockets("console")) {
      const a = ws.deserializeAttachment() as ConsoleAttachment | null;
      if (a?.watch.includes(clientId)) this.sendRaw(ws, message);
    }
  }

  private notifyConsoles(message: unknown): void {
    const consoles = this.ctx.getWebSockets("console");
    if (!consoles.length) return;
    const text = JSON.stringify(message);
    for (const ws of consoles) this.sendRaw(ws, text);
  }

  // ------------------------------------------------------------ live status

  private deviceAttachment(ws: WebSocket): DeviceAttachment | null {
    const a = ws.deserializeAttachment() as DeviceAttachment | ConsoleAttachment | null;
    return a && a.kind === "device" ? a : null;
  }

  private lastSeenOf(ws: WebSocket, a: DeviceAttachment): number {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return Math.max(a.connectedAt, pinged, this.lastMessage.get(a.clientId) ?? 0);
  }

  private statusOf(a: DeviceAttachment, lastSeen: number, online = true): LiveStatus {
    return {
      clientId: a.clientId,
      clientNum: a.clientNum,
      activeUrl: a.activeUrl,
      isLocked: a.isLocked,
      ip: a.ip,
      vncPassword: a.vncPassword,
      remoteHost: a.remoteHost,
      online,
      lastSeen,
      transport: "websocket"
    };
  }

  private httpStatus(clientId: string, c: HttpClient, now: number): LiveStatus {
    return {
      clientId,
      clientNum: c.clientNum,
      activeUrl: c.activeUrl,
      isLocked: c.isLocked,
      ip: c.ip,
      vncPassword: c.vncPassword,
      remoteHost: c.remoteHost,
      online: now - c.lastSeen < HTTP_ONLINE_MS,
      lastSeen: c.lastSeen,
      transport: "http"
    };
  }

  /** Every workstation this object knows to be connected, with its latest frame when asked for. */
  liveClients(withFrames: boolean): Record<string, LiveStatus> {
    const now = Date.now();
    const clients: Record<string, LiveStatus> = {};
    for (const ws of this.ctx.getWebSockets("device")) {
      const a = this.deviceAttachment(ws);
      if (!a) continue;
      const lastSeen = this.lastSeenOf(ws, a);
      clients[a.clientId] = this.statusOf(a, lastSeen, now - lastSeen < SOCKET_STALE_MS);
    }
    for (const [clientId, c] of this.http) {
      if (!clients[clientId]) clients[clientId] = this.httpStatus(clientId, c, now);
    }
    if (withFrames) {
      for (const [clientId, frame] of this.frames) {
        if (clients[clientId]?.online) clients[clientId].thumbnail = frame;
      }
    }
    return clients;
  }

  // -------------------------------------------------------- write-back to D1

  private registryRow(
    a: { clientId: string; clientNum: number; ip: string; isLocked: boolean; activeUrl: string; vncPassword?: string; remoteHost?: string },
    lastSeenMs: number
  ): DeviceRegistryRow {
    return {
      tenantId: this.tenantId!,
      clientId: a.clientId,
      clientNum: a.clientNum,
      ip: a.ip,
      isLocked: a.isLocked,
      activeUrl: a.activeUrl || null,
      vncPassword: a.vncPassword ?? null,
      remoteHost: a.remoteHost ?? null,
      lastSeen: Math.floor(lastSeenMs / 1000)
    };
  }

  private async writeRegistry(rows: DeviceRegistryRow[]): Promise<void> {
    const wanted = rows.filter((row) => !this.isRevoked(row.clientId));
    if (wanted.length) await upsertDeviceRegistry(getDatabase(this.env), wanted);
  }

  /** Write changed workstation rows and the online count back to D1. */
  private async flush(): Promise<void> {
    const now = Date.now();
    const rows: DeviceRegistryRow[] = [];
    for (const ws of this.ctx.getWebSockets("device")) {
      const a = this.deviceAttachment(ws);
      if (!a) continue;
      if (a.dirty || now - a.writtenAt > REGISTRY_REFRESH_MS) {
        rows.push(this.registryRow(a, this.lastSeenOf(ws, a)));
        ws.serializeAttachment({ ...a, dirty: false, writtenAt: now });
      }
    }
    for (const [clientId, c] of this.http) {
      if (c.dirty) {
        rows.push(this.registryRow({ clientId, ...c }, c.lastSeen));
        c.dirty = false;
        c.writtenAt = now;
      }
      // An old agent that stopped heartbeating is forgotten once it is written back.
      if (now - c.lastSeen > HTTP_ONLINE_MS && !c.dirty) {
        this.http.delete(clientId);
        this.frames.delete(clientId);
        this.notifyConsoles({ type: "status", client: { ...this.httpStatus(clientId, c, now), online: false } });
        this.recordEvent("disconnect", clientId, now);
      }
    }
    await this.writeRegistry(rows);

    const online = Object.values(this.liveClients(false)).filter((c) => c.online).length;
    if (online !== this.flushedOnline) {
      await setTenantOnlineCount(getDatabase(this.env), this.tenantId!, online);
      this.flushedOnline = online;
      this.writeMeta("flushedOnline", String(online));
    }
  }

  /** Close sockets that stopped pinging: their machine lost power or network without closing. */
  private async sweepStale(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets("device")) {
      const a = this.deviceAttachment(ws);
      if (a && now - this.lastSeenOf(ws, a) > SOCKET_STALE_MS) {
        ws.close(CLOSE_STALE, "No ping received");
        await this.socketGone(ws);
      }
    }
  }

  async alarm(): Promise<void> {
    if (!this.tenantId) return;
    await this.sweepStale();
    this.updateStreaming();
    await this.flush();
    this.purgeExpiredCommands();

    const busy =
      this.ctx.getWebSockets("console").length > 0 ||
      this.http.size > 0 ||
      this.pollWatch.size > 0 ||
      this.ctx.getWebSockets("device").some((ws) => this.deviceAttachment(ws)?.dirty);
    const pending =
      (this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM commands").one() as { n: number }).n > 0;
    if (busy || pending) {
      await this.ctx.storage.setAlarm(Date.now() + (this.ctx.getWebSockets("console").length ? CONSOLE_SWEEP_MS : FLUSH_DELAY_MS));
    }
  }

  /** Schedule the alarm no later than `delayMs` from now. Each setAlarm is a billed row write. */
  private async ensureAlarm(delayMs: number): Promise<void> {
    const due = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > due) await this.ctx.storage.setAlarm(due);
  }

  // ------------------------------------------------------------------- helpers

  private recordEvent(event: string, clientId: string, now = Date.now(), leaving?: WebSocket): void {
    const dataset = this.env.FLEET_METRICS;
    if (!dataset) return;
    const online = Object.values(this.liveClients(false)).filter((c) => c.online && c.clientId !== (leaving ? clientId : "")).length;
    dataset.writeDataPoint({
      indexes: [this.tenantId!],
      blobs: [event, clientId],
      doubles: [online, now]
    });
  }

  private sendTo(ws: WebSocket, message: unknown): void {
    this.sendRaw(ws, JSON.stringify(message));
  }

  private sendRaw(ws: WebSocket, text: string): void {
    try {
      ws.send(text);
    } catch (err) {
      console.warn("[OrgHub] Could not send to a socket that is closing:", err);
    }
  }

  private readMeta(key: string): string | null {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray() as Array<{ value: string }>;
    return rows.length ? rows[0].value : null;
  }

  private writeMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }
}
