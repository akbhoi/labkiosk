---
name: labkiosk-console-ui
description: Lab Kiosk pages rendered by the Cloudflare Worker — the organization admin console (Workstations, Apps & Web, Staff, Settings), the super admin console, the public landing page, the User Portal, the organization homepage and the legal pages (cloudflare-control/src/ui*.ts). Covers CSP nonces, escaping, declared CSS classes and design tokens, the icon-only navigation rail, wording rules, and how to verify a page in a browser. Use for any change to what these pages show or how their client scripts behave.
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
  (markup + client script). `ui.ts` only picks the builder; `ui_admin_shared.ts`
  holds `renderApiScopeScript` and `renderHeaderCountersScript`. `test/dump_admin_html.ts` renders all
  four pages for byte-diffing a refactor.
- **Icon rail (68 px)**: `.nav-sidebar` (`--sidebar-width`) holds navigation only: exactly four modules — Workstations, Apps & Web, Staff, Settings — as icons, each named by a `.rail-tooltip` on hover or keyboard focus (and by `aria-label`; no native `title`), plus the bottom-left profile menu (sign-out lives there, not in the header). At ≤ 1024 px it is a `--drawer-width` drawer with the names written out. **There is no context panel**: a page's view tabs, filters and actions live in its canvas (`.segmented-nav`, `.filter-chips`, a labelled `.chip-row`, a button in `.page-head`). Never put page controls in the rail.
- **Strict View-Switching Tabs**: Top tabs (`.segmented-nav` / `.page-tabs`) in all consoles strictly swap view panes, updating `?tab=...` via `history.replaceState` without page or anchor jumping.
- **Every control does something, and says when it is working.** The shell and the public pages emit `BUSY_SCRIPT` (`ui_tokens.ts`): the control whose click or form submit starts a non-GET `fetch` gets `.is-loading` (a spinner, `aria-busy`) until the answer arrives, a confirmation dialog hands the mark back to the button that opened it, and a second click on a working control is dropped. Handlers need no code for it; `window.lkBusy(control, on)` is for work that is not a request. Header counters are filled on every page (`renderHeaderCountersScript`).
- Tabs: Apps & Web (`broadcast | portal | whitelist`) and Settings (`general | domains | homepage | security | two-factor | issues`; `two-factor` is the account's own sign-in, the only tab an account without `settings` gets) switch client-side through `window.labkioskSwitchTab()` and deep-link with `?tab=`; reloading onto a tab updates `tab` with `history.replaceState`, never appends or jumps.
- **Settings → Errors & Warnings** (`issues`) lists what workstations reported (`GET /api/workstation-issues`); the audit log ("Recent activity", `security`) stays what people did — never show a workstation problem there. The bug-report opt-in is shown only from that route's `bugReports` state: disabled with a hint when the platform has no repository, and turning it on (or re-accepting a new terms version) needs the terms checkbox linking `/terms/bug-reports`. A reported row shows "New bug report #N" or "Already reported #N", a status badge and, for an open PR, "View PR" (only `https://github.com/` links).
- **Public & Documentation Pages**: Split into dedicated routes: `/` (high-converting homepage), `/features` (deep dive into capabilities), `/specs` (hardware requirements), `/pricing` (transparent tiers & education grant), `/download` (the latest release's ISO and its published checksum, linked by GitHub's `releases/latest` address: never a version number, checksum or changelog written into the page; 3-step guide), and `/docs` (the repository's `wiki/` rendered page by page at `/docs/<page>`; edit the wiki, run `pnpm --prefix cloudflare-control run docs`, commit both; `/wiki/<Page>` 301 redirects to its `/docs` address). Their styles are `SITE_CSS`, served once at `/assets/site-<hash>.css`. State no figure on these pages that was not measured (a test lists the patterns).
- **Super console views**: `viewsByTab` in `ui_super.ts` is the one list the view tabs render from; Mail's tabs are its folders (`data-inbox-filter`, `?view=`) with `New message` (`data-inbox-compose`), and the type and mailbox filters are `.chip-row`s above the list, in `ui_super_inbox.ts`. The header counters stay centred (`.canvas-header` grid): never put page-specific content in that row.
- Other surfaces: `ui_super.ts` (`/super/organizations|tasks|mail|catalogs|system`, one tab rendered), `ui_portal.ts` (`/home`, User Portal), `ui_org_home.ts` (`/`), `ui_legal.ts` (`/privacy`, `/terms`, `/terms/bug-reports`; no scripts). The Privacy Policy names every Cloudflare product the Worker binds, GitHub and Google Fonts, and a test holds that list: a new binding or outside service goes into both. Changing the bug report terms text means a new `BUG_REPORT_TERMS_VERSION`.

## Design language

Calm and neutral, in **light and dark** (details: `cloudflare-control/AGENTS.md` Rule 5c).

- `ui_tokens.ts` is the only place a colour, radius, easing or panel width is defined. `PALETTE`
  holds every colour as a `[light, dark]` pair; every surface renders `rootTokensCss()`,
  `FONT_LINKS` (Inter + JetBrains Mono) and, where it has a nonce, `themeHeadHtml(nonce)`. Never
  open a `:root` of your own; a new token needs both values.
- **No literal colours** in markup, stylesheets or SVGs (`currentColor` for icons): a test rejects
  them. Another test measures `PALETTE` contrast in both themes, so a token change that fails WCAG AA
  fails the suite.
- **A class a page renders must be declared in `ui_layout.ts`** (a test fails otherwise): buttons
  (`.btn-primary` once per view, `.btn-secondary`, `.btn-ghost`, `.btn-danger`), `.form-input/
  .form-select/.form-textarea`, `.form-checkbox(-label)`, `.grid-2col`, `.grid-sidebar`,
  `.tab-pane`, `.segmented-nav/.segmented-tab` (in-canvas pill navigation), `.controls-bar`,
  `.filter-chips/.filter-chip`, `.chip-badge`, `.density-toggle/.density-btn`, `.hidden`,
  `.card`/`.card-flush`/`.card-head`, `.table-container` (+ `.table-scrollable`),
  `.callout(-success|-warning|-danger)`, `.badge-*`, `.stat-grid/.stat-tile`, `.kv-list`,
  `.toolbar`, `.menu-popover/.menu-item` (popover menus, placed by the shell), and the text helpers
  (`.text-muted`, `.mono`, `.truncate`…). Prefer these to inline `style`.
- **Container queries & responsive shell**: `.app-canvas` defines `container-type: inline-size; container-name: canvas;` allowing container queries to adapt `.grid-2col`, `.controls-bar`, and card actions based on actual canvas width. Mobile drawer auto-dismisses on `.rail-item`, `.segmented-tab`, and `.filter-chip` clicks.
- The theme switch is `data-action="toggle-theme"`; the shell and the landing page wire it.

## Wording

- Say **organization, operator/staff, user, User Portal, page/broadcast**; never school, teacher,
  student, lesson, classroom or instructor — nor "educational", FERPA/COPPA, "Enter the Lab" or
  "Lab Activity/Configuration". A test renders every console page (all four super tabs), the User
  Portal and the organization homepage and fails on those, and on a doubled noun ("Organizations &
  Organizations"). The landing page (with an Education audience) and legal pages are exempt.
- **License statements must match `LICENSE`**: free only for accredited educational institutions and
  non-commercial evaluation up to 45 computers; commercial or subscriber license for everyone else.
  Never write "free for organizations", "$0" or "open source".
- Mechanical find-and-replace across prose produces nonsense ("approved approved", "Organization
  organization", "a `org_admin`", "begin your page"); read the rendered result.
- Phone width: a grid column floor must be `minmax(min(Npx, 100%), 1fr)` and a `nowrap` line needs a
  shrinkable (`min-width: 0`) parent, or the page renders zoomed out. Check `innerWidth === 375` under
  mobile emulation — a page that overflows widens the layout viewport instead of scrolling.

## Verify in a browser — tests check markup, not behaviour

1. `pnpm --prefix cloudflare-control run typecheck && pnpm --prefix cloudflare-control test`
   (renders every page: nonces, no `on*=`, declared classes, inline scripts parse, vocabulary).
2. Drive the page: `cd cloudflare-control && pnpm dev`, or for signed-in pages a small Node harness
   that runs the Worker on the in-memory D1 (as `test/dev_server.ts` does), seeds an organization
   through the API and attaches its session cookie server-side — so no password is ever typed into
   a form by an automation tool. Exercise the control (create/move/delete/filter), then read the
   browser console for errors and take a screenshot. Restart a Node harness after edits (no reload).
3. Check narrow widths (1024 px): the landing nav once overflowed. Check **both themes**
   (`resize_window colorScheme`, or headless Edge with `--blink-settings=preferredColorScheme=0|1`).
