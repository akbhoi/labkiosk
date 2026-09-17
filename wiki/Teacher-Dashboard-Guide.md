# Teacher Dashboard Guide

The Teacher Lab Dashboard is at `https://<your-school>.labkiosk.<platform-domain>/admin`, or `/admin` on your school's custom domain.

Sign in with the account created when your school registered. Everything below is scoped to your school alone — a teacher at one school receives `403` for another school's console, clients, and commands.

---

## The fleet grid

Every enrolled workstation appears as a card, refreshed from `/api/clients`:

| Shown | Meaning |
| :--- | :--- |
| **Thumbnail** | A JPEG capture from the last heartbeat, at most three seconds old |
| **Online indicator** | Derived from `last_seen`; a machine that stops heartbeating goes stale |
| **Active URL** | Where that workstation currently is |
| **Lock state** | Whether the curtain is up |
| **Remote Control** | Enabled when the workstation has reported a tunnel host |

A workstation that has never completed a heartbeat since boot has no thumbnail and no VNC password yet. Give it three seconds.

> Thumbnails are dropped, not shrunk, when a frame would exceed 256 KB encoded. A momentarily missing thumbnail on a busy screen is expected behaviour, not a fault.

---

## Screen lock — "eyes to the front"

**Lock all screens** raises a full-screen curtain on every workstation, across every open tab, with your message.

- Type a message, or leave it blank to use the school's default lock message from Settings.
- Messages are truncated to 280 characters.
- While the curtain is up, the page underneath sees no clicks, keystrokes, scrolls, or touches — they are swallowed in the capture phase before reaching it.
- The console updates immediately rather than waiting a heartbeat, because lock and unlock also update the server's telemetry cache on dispatch.

**Unlock** drops the curtain everywhere. You can also lock a single workstation from its card.

> The curtain is a DOM-level block. Browser and window-level escapes are covered by other layers — Chromium's kiosk switches and Openbox's emptied keybinding table. → [Kiosk Hardening](Kiosk-Hardening)

---

## Broadcast — push a lesson to the whole lab

Enter a URL and broadcast. Every workstation navigates there at once and **stays** there: the URL is written to your school's tenant row, so a machine that reboots mid-lesson rejoins the same page, and a machine in a different Cloudflare colo sees the same answer.

**Reset to portal** clears the broadcast and returns the lab to the Student Portal.

### Broadcast presets

Save the URLs you use repeatedly — today's worksheet, the exam platform, the reading list — as one-click shortcuts. Managed under Settings, stored per school.

### What a broadcast actually is

There is no `broadcast` command action. A broadcast is `navigate` to `target: "all"`, plus a monotonic `broadcastEpoch` written to the tenant row. The epoch is what lets a workstation tell a *new* broadcast from the one it already obeyed, so it navigates exactly once rather than every three seconds.

A student cannot reverse out of it: at the broadcast root the extension suppresses `Alt+Left` and `Backspace`, and the epoch is kept in extension storage where page script cannot reach it.

---

## Per-workstation commands

From any card:

| Command | Effect |
| :--- | :--- |
| **Navigate** | Send that one machine to a URL |
| **Reload** | Refresh the current page |
| **Reboot** | Restart the workstation |
| **Shutdown** | Power it off |
| **Mute** | Silence audio output |
| **Remote Control** | Open an interactive session → [Remote Control](Remote-Control) |
| **Decommission** | Remove it and revoke its device token |

Reboot and shutdown reach logind through a polkit rule granting the kiosk user exactly those two actions. A workstation that boots back up re-enrols nothing — it keeps its token and rejoins the grid.

**Decommission** is the one destructive action here. The machine's next heartbeat gets `401` and it disappears from the grid. Re-adding it means running the setup wizard again with a valid enrollment key.

---

## Two modes

Under **Settings → Mode**:

### `portal` — the app launcher

Workstations land on your Student Learning Portal: a grid of cards you curate. Students pick a lesson.

### `single_url` — total lockdown

Workstations go to one destination and nothing else — an LMS, an exam platform, a catalogue. No launcher at all.

```text
Single-Site URL:  canvas.yourschool.edu
```

A scheme-less domain is fine; `safeHttpUrl()` prepends `https://`.

---

## The Student Portal

Add application cards under **Portal Apps**:

| Field | Notes |
| :--- | :--- |
| **Title** | Shown on the card |
| **URL** | Where the card goes |
| **Category** | Groups cards, e.g. "Math & Science" |
| **Icon** | An emoji |
| **Thumbnail URL** | Optional card image |

**Adding a card authorises its domain automatically.** The effective allowlist a workstation receives is the permanent allowlist unioned with every portal app's host — so you never add a site in two places.

→ [Student Portal](Student-Portal)

---

## The allowlist

Under **Settings → Allowed Sites**. Chromium on every workstation blocks *everything* by default and re-permits only these domains plus your portal apps.

```text
khanacademy.org
scratch.mit.edu
yourschool.edu
```

Subdomains of a listed domain are matched by Chromium's policy patterns. Do **not** add ports or wildcards — `http://localhost:*` and `127.0.0.1:*` are invalid patterns Chromium discards with an error. Use the bare host; omitting the port matches all ports.

Changes reach workstations on their next heartbeat, within three seconds. If a site was blocked and you have just allowed it, the agent restarts the browser so Chromium picks up the new policy.

---

## Customisation

Under **Settings → Customization**:

| Setting | Appears |
| :--- | :--- |
| **School name** | Throughout the consoles and portal |
| **Default lock message** | On the curtain when a lock carries no message |
| **Portal title / subtitle / description / footer** | On the Student Portal |

Useful for labelling a specific room — *"Computer Science Lab 304"*, *"For technical assistance, raise your hand."*

---

## Workstation enrollment key

Under **Settings → Workstation Enrollment Key**.

- Schools start with an **empty** key, and an empty key authenticates nothing. Generate one before enrolling anything.
- The key is what a new workstation exchanges for its own persistent device token.
- **Rotating it does not affect enrolled workstations** — they hold their own tokens. Rotation only stops *new* enrolments with the old key.
- Rotate it if the key has been shared outside your IT staff, and after a technician leaves.
- Failed enrolment attempts from an address are throttled.

---

## Custom domain

Under **Settings → Custom Domain**, request a domain your institution owns — `kiosk.yourschool.edu`.

1. You request it; status becomes `pending`.
2. You create a `CNAME` pointing to the platform apex.
3. A platform super admin approves it.
4. Cloudflare routes it to the worker, and `resolveTenant()` recognises it from the `Host` header.

Workstations can then enrol against the custom domain instead of the platform subdomain.

---

## Audit log

Every administrative action writes a row: command dispatches (`command.lock`, `command.navigate`, …), settings changes, enrolments, and decommissions, with the acting user and a details string.

The log survives the tenant it belongs to — `tenant_id` is `ON DELETE SET NULL` rather than cascading — so a deleted school does not erase its own history.

---

## Account security

**Change password** verifies your current password and **revokes the account's other sessions**, so a stolen cookie does not survive a password change. That is the only path by which a password changes.

Repeated failed sign-ins back off exponentially and are answered with `429`.

---

## Classroom recipes

**Starting an exam**

1. Switch to `single_url` pointed at the exam platform.
2. Broadcast it, so machines already on something else move immediately.
3. Lock all screens with your instructions while you hand out materials.
4. Unlock when everyone is ready.

**Recovering a wandering class**

Broadcast the lesson URL. Every machine returns at once, and a student cannot navigate back out of the broadcast root.

**End of the day**

Shutdown all. Every workstation resets completely at power-off — the RAM overlay discards browser profiles, caches, and any file a student saved.

---

## When something is wrong

| Symptom | Likely cause |
| :--- | :--- |
| Workstation missing from the grid | Not enrolled, or its token was revoked. Re-run the wizard with the current key. |
| Thumbnails frozen | That machine stopped heartbeating. Check its screen; the agent's supervisor loop restarts it within ~2 s of any crash. |
| "This page is blocked" | The domain is not on the effective allowlist, or Chromium has not reloaded policy yet. |
| Remote Control disabled | No tunnel host reported. → [Remote Control](Remote-Control) |
| A button does nothing | Report it — an inline `on*=` handler would be blocked by the CSP, and the test suite is supposed to catch that before release. |

→ [Troubleshooting](Troubleshooting) · [Super Admin Guide](Super-Admin-Guide) · [REST API Reference](REST-API-Reference)
