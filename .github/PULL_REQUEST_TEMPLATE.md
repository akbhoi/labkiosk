## Description
A brief summary of what this pull request changes and the motivation behind it.

## Related Issues
Closes #(issue_number)

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix or feature causing existing behavior to change)
- [ ] Security fix
- [ ] Documentation update

## AI Co-Development Notice
- [ ] This pull request was authored or co-developed with an AI assistant (e.g. Antigravity, Claude, Copilot, ChatGPT).
  - *Model/Agent used:* (specify if applicable)

## Verification Checklist
- [ ] Typecheck passes (worker **and** tests): `pnpm --prefix cloudflare-control run typecheck`
- [ ] All automated tests pass: `pnpm --prefix cloudflare-control test`
- [ ] Zero placeholders: no `// TODO`s, stubs, empty catch blocks, or invented constants
      (a checksum or URL you cannot verify becomes a required input that fails loudly, not a
      plausible-looking default)

### If you added or changed an API route
- [ ] It calls `requireTenantAdmin()`, `requireSuperAdmin()` or `requireDevice()` from `src/guard.ts`
- [ ] It resolves its tenant through `resolveTenant()`, never by reading the host or query itself
- [ ] A **negative test** covers it: anonymous access and, where relevant, cross-tenant access

### If you changed anything rendered to a browser
- [ ] Server-side values go through `escapeHtml()` / `escapeJson()`; URLs through `safeHttpUrl()`
- [ ] Client-side rendering uses `textContent` and event listeners, not `innerHTML` or inline `onclick=`
- [ ] Every `<script>` carries the response nonce and no `on*=` attribute was added (the CSP test
      renders every page and fails otherwise)

### If you changed the database schema
- [ ] Added a **new** numbered file in `migrations/` (no edits to an already-applied one)
- [ ] Made the matching change to `SCHEMA_SQL` in `src/db.ts` (the drift test compares them)

### If you changed the client OS, agent, or extension
- [ ] No new listener on `0.0.0.0`; the agent API and `websockify` stay on loopback
- [ ] Chromium is not launched with `--disable-web-security` (`--no-sandbox` only in the simulator)
- [ ] RAM overlay safety: no persistent disk writes added; runtime data goes to `/tmp`
- [ ] No blanket extension block added to the Chromium policy (it disables `--load-extension` and
      silently removes the nav bar and lock curtain)
- [ ] Extension changes keep the agent `fetch` in the service worker, not the content script
- [ ] Telemetry contract changes (new fields the agent sends) are reflected in `/api/telemetry`, the
      README API table and `AGENTS.md`
- [ ] Verified in the Docker simulator with a **screenshot** — a log line saying the command ran is
      not evidence that anything appeared on screen — and described how in the Description above
