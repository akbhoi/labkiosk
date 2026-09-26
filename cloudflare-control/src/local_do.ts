/**
 * In-process stand-ins for the OrgHub Durable Object's runtime: a namespace,
 * per-object state with SQLite storage and one alarm, and hibernatable
 * WebSockets.
 *
 * They exist for the test suite and for Node-based local development, the same
 * way `d1_adapter.ts` stands in for D1. `wrangler dev` and production use the
 * real runtime, and a production deployment without an `ORG_HUB` binding refuses
 * to start (see `requiredBindingsProblem` in hub.ts).
 *
 * A WebSocket upgrade cannot be answered here -- Node's Response has no status
 * 101 -- so tests connect sockets with `connectDevice` / `connectConsole`, which
 * go through the same `acceptDevice` / `acceptConsole` the upgrade path uses.
 */

import { Env } from "./types";
import { OrgHub, DeviceMeta, ConsoleMeta, HUB_PING, HUB_PONG } from "./org_hub";

type Row = Record<string, string | number | null>;

function openSqlite(): { prepare(sql: string): { all(...params: unknown[]): Row[] } } {
  const proc = (globalThis as { process?: { getBuiltinModule?(name: string): unknown } }).process;
  const mod = proc?.getBuiltinModule?.("node:sqlite") as { DatabaseSync?: new (path: string) => unknown } | undefined;
  if (!mod?.DatabaseSync) throw new Error("node:sqlite is not available in the current runtime.");
  return new mod.DatabaseSync(":memory:") as { prepare(sql: string): { all(...params: unknown[]): Row[] } };
}

class LocalCursor<T extends Row> {
  constructor(private readonly rows: T[]) {}
  toArray(): T[] {
    return this.rows;
  }
  one(): T {
    if (this.rows.length !== 1) throw new Error(`Expected exactly one row, got ${this.rows.length}`);
    return this.rows[0];
  }
  [Symbol.iterator](): Iterator<T> {
    return this.rows[Symbol.iterator]();
  }
}

/** One socket as the Durable Object sees it, with helpers to act as the far end. */
export class LocalSocket {
  readonly sent: string[] = [];
  readyState = 1;
  closedWith: { code: number; reason: string } | null = null;
  private attachment: unknown = null;

  constructor(private readonly entry: LocalHubEntry) {}

  // ---- the WebSocket surface OrgHub uses
  send(text: string): void {
    if (this.readyState !== 1) throw new Error("WebSocket is closed");
    this.sent.push(text);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.entry.state.detach(this);
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value === null || value === undefined ? null : structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment === null ? null : structuredClone(this.attachment);
  }

  // ---- the far end
  /** Send a message as the client would. The runtime's auto-response is honoured. */
  async fromClient(message: unknown): Promise<void> {
    const text = typeof message === "string" ? message : JSON.stringify(message);
    if (this.entry.state.autoResponse && text === this.entry.state.autoResponse.request) {
      this.sent.push(this.entry.state.autoResponse.response);
      this.entry.state.autoResponseAt.set(this, new Date());
      return;
    }
    await this.entry.hub.webSocketMessage(this as unknown as WebSocket, text);
  }

  /** Close the connection from the client's side. */
  async closeFromClient(code = 1000, reason = ""): Promise<void> {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.entry.state.detach(this);
    await this.entry.hub.webSocketClose(this as unknown as WebSocket, code, reason, true);
  }

  /** Every message the Durable Object sent, decoded. */
  messages(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

class LocalHubState {
  readonly sockets = new Map<LocalSocket, string[]>();
  readonly autoResponseAt = new Map<LocalSocket, Date>();
  autoResponse: { request: string; response: string } | null = null;
  alarmAt: number | null = null;
  private readonly db = openSqlite();

  readonly storage = {
    sql: {
      exec: <T extends Row>(query: string, ...bindings: unknown[]) =>
        new LocalCursor<T>(this.db.prepare(query).all(...bindings) as T[])
    },
    getAlarm: async (): Promise<number | null> => this.alarmAt,
    setAlarm: async (when: number | Date): Promise<void> => {
      this.alarmAt = typeof when === "number" ? when : when.getTime();
    },
    deleteAlarm: async (): Promise<void> => {
      this.alarmAt = null;
    }
  };

  acceptWebSocket(ws: LocalSocket, tags: string[] = []): void {
    this.sockets.set(ws, tags);
  }

  getWebSockets(tag?: string): LocalSocket[] {
    return [...this.sockets.entries()].filter(([, tags]) => !tag || tags.includes(tag)).map(([ws]) => ws);
  }

  setWebSocketAutoResponse(pair?: { request: string; response: string }): void {
    this.autoResponse = pair ? { request: pair.request, response: pair.response } : null;
  }

  getWebSocketAutoResponseTimestamp(ws: LocalSocket): Date | null {
    return this.autoResponseAt.get(ws) ?? null;
  }

  detach(ws: LocalSocket): void {
    this.sockets.delete(ws);
  }
}

interface LocalHubEntry {
  hub: OrgHub;
  state: LocalHubState;
}

/** A Durable Object namespace holding one OrgHub per organization, in this process. */
export class LocalHubNamespace {
  private readonly entries = new Map<string, LocalHubEntry>();

  constructor(private readonly env: Env) {}

  idFromName(name: string): DurableObjectId {
    return { name, toString: () => name, equals: (other: DurableObjectId) => other.toString() === name } as DurableObjectId;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const entry = this.entry(id.toString());
    return {
      id,
      name: id.toString(),
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        entry.hub.fetch(input instanceof Request ? input : new Request(String(input), init))
    } as unknown as DurableObjectStub;
  }

  private entry(name: string): LocalHubEntry {
    let entry = this.entries.get(name);
    if (!entry) {
      const state = new LocalHubState();
      const hub = new OrgHub(state as unknown as DurableObjectState, this.env);
      entry = { hub, state };
      this.entries.set(name, entry);
    }
    return entry;
  }

  /** Connect a workstation's socket to its organization's hub, as an upgrade would. */
  async connectDevice(meta: DeviceMeta): Promise<LocalSocket> {
    const entry = this.entry(meta.tenantId);
    if (!entry.hub.bind(meta.tenantId)) throw new Error("This hub belongs to another organization");
    const socket = new LocalSocket(entry);
    await entry.hub.acceptDevice(socket as unknown as WebSocket, meta);
    return socket;
  }

  /** Connect a console's socket to an organization's hub, as an upgrade would. */
  async connectConsole(meta: ConsoleMeta): Promise<LocalSocket> {
    const entry = this.entry(meta.tenantId);
    if (!entry.hub.bind(meta.tenantId)) throw new Error("This hub belongs to another organization");
    const socket = new LocalSocket(entry);
    await entry.hub.acceptConsole(socket as unknown as WebSocket, meta);
    return socket;
  }

  /** Run an organization's alarm now, as the runtime would when it is due. */
  async runAlarm(tenantId: string): Promise<void> {
    const entry = this.entries.get(tenantId);
    if (!entry) return;
    entry.state.alarmAt = null;
    await entry.hub.alarm();
  }

  /** When an organization's alarm is due, or null. */
  alarmAt(tenantId: string): number | null {
    return this.entries.get(tenantId)?.state.alarmAt ?? null;
  }

  /** Pretend the runtime last answered this socket's ping at `when`. */
  setLastPing(socket: LocalSocket, when: Date): void {
    for (const entry of this.entries.values()) {
      if (entry.state.sockets.has(socket)) entry.state.autoResponseAt.set(socket, when);
    }
  }
}

export { HUB_PING, HUB_PONG };
