# labkiosk-email-routing

The Email Routing destination Worker for every address on the platform's domain (the catch-all).
It keeps each message in R2 and hands it to `labkiosk-controller`, which files it under
Super Admin → **Mail**. Parsing, threading and the database stay in the controller
(`cloudflare-control/src/inbox.ts`); this Worker has no runtime dependencies.

1. The original goes to `mail/<id>.eml` in the `labkiosk-audit-archive` bucket, with an empty marker
   at `mail-pending/<id>` that carries the envelope sender and recipient.
2. `CONTROLLER.file(id, from, to)`, the controller's `MailIntake` entrypoint over a Service Binding,
   files the message and removes the marker.
3. With `SUPPORT_FORWARD_TO` set, the owner gets a copy of every message that is not a loop.

If step 2 fails, the marker stays and the controller's hourly run files the message. If step 1
fails, the copy to `SUPPORT_FORWARD_TO` is the fallback; without one the message bounces.

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm exec wrangler deploy   # after labkiosk-controller, whose MailIntake the binding names
```

Then point the catch-all at it: Dashboard → the domain → Email → Email Routing → Routing rules →
*Catch-all address* → *Send to a Worker* → `labkiosk-email-routing`. See `docs/DEPLOYMENT.md`, "Email".
