# labkiosk-email-routing

The platform's email Worker. It has no runtime dependencies, no route and no workers.dev address.

**Receiving.** It is the Email Routing destination for every address on the platform's domain (the
catch-all). It keeps each message in R2 and hands it to `labkiosk-controller`, which files it under
Super Admin → **Mail**. Parsing, threading and the database stay in the controller
(`cloudflare-control/src/inbox.ts`), because that is where the console reads them.

1. The original goes to `mail/<id>.eml` in the `labkiosk-audit-archive` bucket, with an empty marker
   at `mail-pending/<id>` that carries the envelope sender and recipient.
2. `CONTROLLER.file(id, from, to)`, the controller's `MailIntake` entrypoint over a Service Binding,
   files the message and removes the marker.
3. With `SUPPORT_FORWARD_TO` set, the owner gets a copy of every message that is not a loop.

If step 2 fails, the marker stays and the controller's hourly run files the message. If step 1
fails, the copy to `SUPPORT_FORWARD_TO` is the fallback; without one the message bounces.

**Sending.** The controller hands every outgoing message to `POST /send` over its `MAILER` Service
Binding (`src/send.ts`): who it is from and to, the subject, the plain text, and which template. This
Worker renders the HTML part and sends both through its `EMAIL` send_email binding. Only a Service
Binding can reach it. It refuses a template it does not have, any header but the threading and
auto-reply ones, and any value that could start a new header. If it does not answer, the controller
renders the same template itself and sends through its own binding.

**Templates** (`src/templates/`). One scaffold, `layout.ts`, is around every message: the wordmark
and what kind of message it is, the body, and a footer with the reply address, the site and why the
message arrived. Tables and inline styles only, no images, a dark theme and a phone layout where the
mail client honours them. Every value is escaped, and only an http(s) address becomes a link.

| Template | For |
| :--- | :--- |
| `code` | A one-time code: confirming an address at registration, the second step of a sign-in |
| `receipt` | "We received it", with the tracking ID: a registration, a Remote Control request, a new email |
| `reply` | A reply a person wrote in the console, signed, with the tracking ID |
| `decision` | A request approved or declined, with the next step as a button |
| `letter` | A formal letter to a company: date, addressee, subject line, signature |
| `alert` | A security notice about the recipient's own account |
| `notice` | Plain text in the scaffold: what anything without its own template goes out as |

To add one: a file beside the others exporting its data type and `render…()`, its case in
`templates/index.ts`, and a sample in `test/samples.ts` (a test fails without one). To see them:

```bash
pnpm run preview            # writes previews/*.html; open previews/index.html
```

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm exec wrangler deploy   # after labkiosk-controller, whose MailIntake the binding names
                            # (first install: see docs/DEPLOYMENT.md, "Email", for the order)
```

Then point the catch-all at it: Dashboard → the domain → Email → Email Routing → Routing rules →
*Catch-all address* → *Send to a Worker* → `labkiosk-email-routing`. See `docs/DEPLOYMENT.md`, "Email".
