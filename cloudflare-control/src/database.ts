/**
 * The D1 database a request (or an organization's Durable Object) works against.
 *
 * Production binds `DB`. Tests and local development opt in to an ephemeral
 * in-memory database with `ALLOW_LOCAL_DB=1`; one instance per isolate, shared
 * by the Worker and the local stand-in for OrgHub so both see the same rows.
 * A deployment with no binding fails loudly rather than silently running on
 * storage that disappears when the isolate recycles.
 */

import { Env } from "./types";
import { createLocalD1Database } from "./d1_adapter";

let localDbInstance: D1Database | null = null;

export function getDatabase(env: Env): D1Database {
  if (env.DB) return env.DB;
  if (env.ALLOW_LOCAL_DB !== "1") {
    throw new Error(
      "No D1 database bound. Bind `DB` in wrangler.jsonc, or set ALLOW_LOCAL_DB=1 to use the ephemeral in-memory database for local development."
    );
  }
  if (!localDbInstance) {
    localDbInstance = createLocalD1Database();
  }
  return localDbInstance;
}

/** Local development and tests, where missing bindings are replaced by in-process stand-ins. */
export function isLocalEnvironment(env: Env): boolean {
  return env.ALLOW_LOCAL_DB === "1";
}
