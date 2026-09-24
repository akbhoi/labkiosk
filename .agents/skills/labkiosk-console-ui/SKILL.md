---
name: labkiosk-console-ui
description: Lab Kiosk pages rendered by the Cloudflare Worker — the organization admin console (Workstations, Apps & Web, Staff, Settings), the super admin console, the public landing page, the User Portal, the organization homepage and the legal pages (cloudflare-control/src/ui*.ts). Covers CSP nonces, escaping, declared CSS classes and design tokens, the left-rail/context-panel architecture, wording rules, and how to verify a page in a browser. Use for any change to what these pages show or how their client scripts behave.
---

# Lab Kiosk — Worker-rendered pages

Authoritative detail: `cloudflare-control/AGENTS.md` Rules 4–5g and the root `AGENTS.md`.

## Security rules (tests enforce most of them)

- Every `<script>` carries `nonce="${escapeAttr(nonce)}"`; **no inline handlers** (`onclick=` …) —
  use `data-action` + delegated listeners or `addEventListener`. The CSP blocks anything else.
- Server side: every interpolation through `escapeHtml()` / `escapeJson()` (the latter for
  anything inside `<script>`); URLs through `safeHttpUrl()`.
- Client side: build nodes with `textContent`, `dataset`, `new Option()`, `replaceChildren()`.
  **`escapeHtml`/`escapeAttr` exist only on the server** — inside a template's client script (an
  escaped `\${…}`) they are a runtime `ReferenceError`; a test rejects them.
- Client API calls go through `window.labkioskApi(path)`, never bare `fetch("/api/…")` (it carries
  `?tenant=` on dev hosts).

## Structure

- **One module per admin page**: `ui_admin_workstations.ts`, `ui_admin_apps_web.ts`,
  `ui_admin_staff.ts`, `ui_admin_settings.ts`, each exporting `build<Page>Page(): AdminPageParts`
  (markup + context panel + client script). `ui.ts` only picks the builder; `ui_admin_shared.ts`
  holds `renderApiScopeScript` and `renderSubPanelScripts`. `test/dump_admin_html.ts` renders all
  four pages for byte-diffing a refactor.
- **Rail (72 px)**: exactly four modules — Workstations, Apps & Web, Staff, Settings — plus the
  bottom-left profile menu (sign-out lives there, not in the header).
- **Context panel (272 px)**: every control must do something. A `data-filter` / `data-density`
  control works when the page defines `window.labkioskApplyFilter` / `labkioskApplyDensity`;
  `renderSubPanelScripts()` disables it otherwise (decide by what the page provides, never by
  page name). Panel commands click the page's own button — one code path per action. Header
  counters are filled on every page.
- Tabs: Apps & Web (`broadcast | portal | whitelist`) and Settings (`general | domains | homepage |
  security`) switch client-side through `window.labkioskSwitchTab()` (panel buttons use
  `data-action="tab-<id>"`) and deep-link with `?tab=`; reloading onto a tab replaces `tab`
  with `url.searchParams.set`, never appends.
- Other surfaces: `ui_super.ts` (`/super/organizations|approvals|catalogs|system`, one pane
  rendered), `ui_landing.ts`, `ui_portal.ts` (`/home`, User Portal), `ui_org_home.ts` (`/`),
  `ui_legal.ts`.

## Design language

`ui_tokens.ts` is the only place a colour, radius, easing or panel width is defined; every surface
renders `rootTokensCss()` and `FONT_LINKS` and never opens its own `:root`. **A class a page renders
must be declared in `ui_layout.ts`** (a test fails otherwise): use `.form-input/.form-select/
.form-textarea`, `.form-checkbox(-label)`, `.grid-2col`, `.tab-pane`, `.table-scrollable`
(480 px, sticky `th`). Keep `--text-subtle` at `#808fa6` (WCAG AA contrast).

## Wording

- Say **organization, operator/staff, user, User Portal, page/broadcast**; never school, teacher,
  student, lesson, classroom or instructor. A test renders every console page, the User Portal and
  the organization homepage and fails on those words. The landing page (with an Education audience)
  and legal pages are exempt.
- **License statements must match `LICENSE`**: free only for accredited educational institutions and
  non-commercial evaluation up to 45 computers; commercial or subscriber license for everyone else.
  Never write "free for organizations", "$0" or "open source".
- Mechanical find-and-replace across prose produces nonsense ("approved approved", "Organization
  organization", "a `org_admin`"); read the rendered result.

## Verify in a browser — tests check markup, not behaviour

1. `pnpm --prefix cloudflare-control run typecheck && pnpm --prefix cloudflare-control test`
   (renders every page: nonces, no `on*=`, declared classes, inline scripts parse, vocabulary).
2. Drive the page: `cd cloudflare-control && pnpm dev`, or for signed-in pages a small Node harness
   that runs the Worker on the in-memory D1 (as `test/dev_server.ts` does), seeds an organization
   through the API and attaches its session cookie server-side — so no password is ever typed into
   a form by an automation tool. Exercise the control (create/move/delete/filter), then read the
   browser console for errors and take a screenshot. Restart a Node harness after edits (no reload).
3. Check narrow widths (1024 px): the landing nav once overflowed.
