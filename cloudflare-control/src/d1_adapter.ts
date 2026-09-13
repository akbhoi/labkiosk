/**
 * SQLite / D1 Compatibility Adapter
 * Wraps Node.js 22+ native `node:sqlite` to provide a full D1Database interface
 * for local testing, development, and fallback execution.
 */

export function createLocalD1Database(): D1Database {
  const proc = (globalThis as any).process;
  const req = (globalThis as any).require || (proc && proc.getBuiltinModule?.bind(proc));
  const { DatabaseSync } = typeof req === "function" ? req("node:sqlite") : { DatabaseSync: null };

  if (!DatabaseSync) {
    throw new Error("node:sqlite is not available in the current runtime.");
  }

  const sqlite = new DatabaseSync(":memory:");

  class LocalD1PreparedStatement {
    statement: string;
    params: any[];

    constructor(statement: string, params: any[] = []) {
      this.statement = statement;
      this.params = params;
    }

    bind(...values: any[]) {
      return new LocalD1PreparedStatement(this.statement, values);
    }

    async first<T = unknown>(colName?: string): Promise<T | null> {
      try {
        const stmt = sqlite.prepare(this.statement);
        const row = stmt.get(...this.params) as any;
        if (!row) return null;
        if (colName) return row[colName] ?? null;
        return row as T;
      } catch (err) {
        console.error("[D1Adapter] first() error:", err, "SQL:", this.statement, "Params:", this.params);
        throw err;
      }
    }

    async all<T = unknown>(): Promise<D1Result<T>> {
      try {
        const stmt = sqlite.prepare(this.statement);
        const rows = stmt.all(...this.params) as T[];
        return {
          results: rows,
          success: true,
          meta: {} as any
        };
      } catch (err) {
        console.error("[D1Adapter] all() error:", err, "SQL:", this.statement, "Params:", this.params);
        throw err;
      }
    }

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      try {
        const stmt = sqlite.prepare(this.statement);
        const result = stmt.run(...this.params);
        return {
          results: [] as T[],
          success: true,
          meta: {
            changes: result.changes,
            last_row_id: Number(result.lastInsertRowid),
            duration: 0,
            rows_read: 0,
            rows_written: result.changes,
            size_after: 0
          } as any
        };
      } catch (err) {
        console.error("[D1Adapter] run() error:", err, "SQL:", this.statement, "Params:", this.params);
        throw err;
      }
    }

    async raw<T = unknown>(): Promise<T[]> {
      const res = await this.all<T>();
      return res.results || [];
    }
  }

  const d1Mock = {
    prepare(query: string) {
      return new LocalD1PreparedStatement(query);
    },
    async exec(query: string): Promise<D1ExecResult> {
      sqlite.exec(query);
      return { count: 1, duration: 0 };
    },
    async batch<T = unknown>(statements: any[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    }
  };

  return d1Mock as unknown as D1Database;
}
