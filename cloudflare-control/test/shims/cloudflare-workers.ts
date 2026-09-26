/**
 * Node stand-in for the Workers runtime's `cloudflare:workers` module.
 *
 * Only the base classes the Worker extends are needed: tests never run a
 * Workflow through the runtime (they call `runCustomHostnameJob` directly), but
 * importing index.ts evaluates the class that extends WorkflowEntrypoint.
 */
export class WorkflowEntrypoint {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
