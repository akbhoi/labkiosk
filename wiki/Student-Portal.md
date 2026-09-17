# Student Portal

The Student Learning Portal is what a student sees when a workstation is idle: a grid of application cards curated by their teacher, served from their school's own subdomain.

It is rendered by `src/ui_portal.ts` at `/` on a tenant host, and at `/portal` explicitly.

---

## What a student sees

```text
+---------------------------------------------------------------+
|  Digital Learning Lab                          [portal_title] |
|  Select an approved lesson to begin         [portal_subtitle] |
|                                                               |
|  Math & Science                                    [category] |
|  +-------------+  +-------------+  +-------------+            |
|  |  🎓          |  |  🔬          |  |  📐          |            |
|  | Khan Academy|  |  PhET Sims  |  |  GeoGebra   |            |
|  +-------------+  +-------------+  +-------------+            |
|                                                               |
|  Computer Science                                             |
|  +-------------+  +-------------+                             |
|  |  🐱          |  |  💻          |                             |
|  |   Scratch   |  |  Code.org   |                             |
|  +-------------+  +-------------+                             |
|                                                               |
|  For technical assistance, raise your hand.    [portal_footer]|
+---------------------------------------------------------------+
```

Cards are grouped by category and ordered by `order_index`. Everything on the page — title, subtitle, description, footer — is per-school copy the teacher controls.

There is no search box, no address bar, and no way to reach anything that is not on this page or on the allowlist.

---

## Where the cards come from

`GET /api/portal-sites` is **public**, scoped to the host tenant. A card is:

| Field | Purpose |
| :--- | :--- |
| `title` | The card's label |
| `url` | Where it goes |
| `domain` | Derived from the URL; feeds the effective allowlist |
| `category` | Groups the cards |
| `icon` | An emoji |
| `thumbnail_url` | Optional card image |
| `order_index` | Display order |
| `is_active` | Whether it renders |

Teachers manage them under **Portal Apps** in the dashboard. → [Teacher Dashboard Guide](Teacher-Dashboard-Guide#the-student-portal)

---

## Adding a card authorises its domain

This is the part worth understanding. The allowlist a workstation enforces is not just the permanent list a teacher typed in — it is that list **unioned with every portal app's host**, computed per heartbeat by `buildEffectiveWhitelist()`.

```text
tenant_whitelist rows        khanacademy.org, yourschool.edu
      +
portal_sites.domain          scratch.mit.edu, phet.colorado.edu
      +
active broadcast host        (when one is active)
      =
effective allowlist          delivered in every telemetry response
```

So a teacher who adds a Scratch card does not also have to add `scratch.mit.edu` to the allowlist. A card that appeared but did not work would be an obvious and constant support burden, and this removes it.

---

## Navigation from the portal

Clicking a card navigates **top-level, natively**. It is not an iframe — Khan Academy, YouTube, and Scratch all enforce `X-Frame-Options: SAMEORIGIN` and would fail with `ERR_BLOCKED_BY_RESPONSE`.

Once on the site, the kiosk's own chrome comes from the browser extension: an auto-hiding 44 px bar with Home, Back, Forward, Reload, and a status shield, injected into a closed Shadow DOM.

**Home** returns to the portal. That is the student's only reliable route back, which is why the bar exists at all.

→ [Browser Extension](Browser-Extension)

---

## When a broadcast is active

A broadcast overrides the portal. Workstations navigate to the teacher's URL and **stay** there: the URL is stored on the tenant row, so a machine that reboots mid-lesson rejoins the same page.

At the broadcast root the extension suppresses `Alt+Left` and `Backspace`, so a student cannot reverse out of it. The teacher's **Reset to portal** clears the broadcast and returns everyone to the launcher.

---

## `single_url` mode

A school can skip the portal entirely. In `single_url` mode workstations go to one destination — an LMS, an exam platform, a library catalogue — and there is no launcher at all.

Use `portal` mode when students choose among approved resources; `single_url` when they should be in exactly one place.

---

## Customisation

| Setting | Where it appears |
| :--- | :--- |
| `portal_title` | The main heading |
| `portal_subtitle` | Under the heading |
| `portal_description` | Room or context label, e.g. "Computer Science Lab 304" |
| `portal_footer` | Bottom of the page, e.g. "For technical assistance, raise your hand." |
| School name | Throughout |

Set under **Settings → Customization**.

---

## Escaping

Every one of those strings, and every card title and URL, is **attacker-controlled** from the platform's perspective: it arrives through registration or the teacher console.

- Server-side, each interpolation goes through `escapeHtml()` or `escapeJson()`.
- Client-side, DOM nodes are built and `textContent` assigned — never concatenation into `innerHTML`.
- URLs pass `safeHttpUrl()`; a card whose URL is not `http(s)` is rejected on creation.

The test suite renders the portal with a hostile app title and asserts it comes back inert.

---

## Privacy

A student's session leaves nothing behind. `overlayroot="tmpfs"` sends every write to RAM: browser profile, cache, history, downloads, and any file they saved. At power-off it is all gone, and the next student gets a genuinely fresh machine.

What the school *does* see is a screen thumbnail every three seconds while a workstation is powered on, visible to any teacher admin of that school, plus the currently active URL. That is the supervision the product exists to provide — worth being explicit about in a lab's acceptable-use policy.

→ [Teacher Dashboard Guide](Teacher-Dashboard-Guide) · [Kiosk Hardening](Kiosk-Hardening) · [Control Plane Internals](Control-Plane-Internals)
