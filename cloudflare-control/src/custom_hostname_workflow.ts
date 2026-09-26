/**
 * The Workflow that provisions custom domains (Cloudflare for SaaS).
 *
 * The work itself is `runCustomHostnameJob` in custom_hostnames.ts; this class
 * only gives it durable, retried steps. It is exported from index.ts so
 * wrangler can bind it as CUSTOM_HOSTNAMES.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { CustomHostnameParams, Env } from "./types";
import { runCustomHostnameJob } from "./custom_hostnames";

export class CustomHostnameWorkflow extends WorkflowEntrypoint<Env, CustomHostnameParams> {
  async run(event: WorkflowEvent<CustomHostnameParams>, step: WorkflowStep): Promise<string> {
    // Every step returns plain JSON (ids, status strings, booleans), which is
    // what a Workflow step may persist; the cast only drops the generic bound.
    const durableDo = step.do.bind(step) as unknown as <T>(
      name: string,
      config: { retries: { limit: number; delay: string; backoff: "exponential" } },
      callback: () => Promise<T>
    ) => Promise<T>;
    return runCustomHostnameJob(this.env, event.payload, {
      do: (name, callback) =>
        durableDo(name, { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" } }, callback),
      sleep: (name, duration) => step.sleep(name, duration as Parameters<WorkflowStep["sleep"]>[1])
    });
  }
}
