# Security Model

What Lab Kiosk defends, how, and what it explicitly does not defend. A security page that claims completeness is worse than one that states its limits.

---

## Threat model

| Adversary | Goal | Primary defence |
| :--- | :--- | :--- |
| **A curious student at the keyboard** | Escape the kiosk into a shell or an unapproved site | Layered lockdown → [Kiosk Hardening](Kiosk-Hardening) |
| **A hostile website the student visits** | Reach the local agent, remove the nav bar, or evade the lock curtain | Extension architecture, closed Shadow DOM, loopback origin checks |
| **Another school's administrator** | Read or control this school's fleet | Tenant scoping on every query and every route |
| **An unauthenticated internet caller** | Post telemetry, drain a command queue, read an allowlist | Device bearer tokens, guards on every route |
| **A cross-site attacker** | Make a signed-in teacher's browser act on their behalf | Origin guard on cookie-authenticated mutations |
| **Someone with physical access to a workstation** | Boot something else, or edit the kernel command line | Boot-menu password, firmware password. → [limits](#what-is-not-defended) |

---

## Control plane

### Authentication

| Property | Value |
| :--- | :--- |
| Algorithm | PBKDF2-HMAC-SHA256 via `crypto.subtle` |
| Iterations | 100 000 |
| Salt | 32 cryptographically random bytes per user |
| Derived key | 256 bits, hex-encoded |
| Session token | 32 random bytes, hex; **only its SHA-256 is stored** |
| Cookie | `HttpOnly; Secure; SameSite=Lax`, scoped to the parent domain |
| Comparison | `timingSafeEqual()` |

There are **zero runtime npm dependencies**. No auth framework, no routing library, no ORM. Every primitive is a Web API, which removes the supply-chain surface entirely and keeps cold start under 10 ms.

Password changes go through one path — `POST /api/auth/change-password` — which verifies the current password and **revokes the account's other sessions**, so a stolen cookie does not outlive a password change.

### Tenant isolation

Two rules, both asserted by the test suite:

1. **Every query touching devices, commands, sessions, or portal apps filters by `tenant_id`.**
2. **Every route carries a guard.** A route without one is a security defect, not an oversight.

| Guard | Enforces |
| :--- | :--- |
| `resolveTenant()` | The school comes from the `Host` header, authoritatively |
| `requireTenantAdmin()` | The session owns *this* tenant — `401` anonymous, `403` wrong school |
| `requireSuperAdmin()` | Platform-level routes |
| `requireDevice()` | A valid, unrevoked device token |
| `rejectCrossSiteMutation()` | Cookie-authenticated `POST`/`DELETE` prove their origin |

`X-Forwarded-Host` is **never** read. Only the `Host` header says where a request arrived; trusting a caller-supplied header to build a URL handed back to a workstation would let an attacker redirect a whole lab.

`?tenant=` and `X-Tenant` are honoured only on a dev host, for a super admin, for a session that already owns that tenant, or on an explicitly public route.

### Device identity

A workstation's identity comes from its bearer token and nothing else. `/api/telemetry` **ignores any `clientId` or tenant the payload claims**.

Tokens are issued by exchanging the school's enrollment key, stored only as SHA-256 hashes, and revoked instantly by decommissioning. Before device tokens existed (migration 0002), anyone who guessed a subdomain could post screenshots and drain that school's command queue.

### Output escaping

Tenant data is attacker-controlled from the platform's perspective: school names, admin emails, portal card titles, and URLs all arrive through registration or the teacher console.

| Context | Required |
| :--- | :--- |
| HTML text | `escapeHtml()` |
| HTML attribute | `escapeAttr()` |
| Inside a `<script>` block | `escapeJson()` |
| Navigable or `href` URL | `safeHttpUrl()` |
| Client-side DOM | Build nodes and assign `textContent`. **Never** concatenate into `innerHTML`. |

`escapeJson()` also escapes U+2028 and U+2029, which are valid JSON but terminate a JavaScript line.

### Content Security Policy

Every HTML response is built with `buildHtmlHeaders(nonce, …)`:

```text
Content-Security-Policy: … 'nonce-<random>' …
Strict-Transport-Security: …            (HTTPS only)
X-Frame-Options: DENY                   + frame-ancestors 'none'
Permissions-Policy: …
Cross-Origin-Opener-Policy: same-origin
X-Content-Type-Options: nosniff
Cache-Control: no-store                 (API responses)
```

**No inline event handlers anywhere.** No `onclick=`, `onsubmit=`, `onmouseover=`. Use a `data-action` attribute with a delegated listener. The CSP blocks inline handlers, so one silently breaks the feature — the test suite renders every page and fails if any script lacks a nonce or any `on*=` attribute appears.

### Rate limiting

- **Sign-in:** exponential back-off per identifier via `login_attempts`, answered `429`.
- **Registration and failed enrolment:** throttled per source address.
- **Reserved slugs:** `www`, `super`, `labkiosk`, `api`, `admin`, `portal`, `status`, `mail`, `app`, `kiosk`, `root` — neither registerable nor resolvable.

### Fail closed

| Condition | Behaviour |
| :--- | :--- |
| No D1 binding | `getDatabase()` throws, unless `ALLOW_LOCAL_DB=1` (tests and local dev only) |
| Super-admin secrets unset | `bootstrap()` refuses to serve |
| Migrations unapplied | `assertSchemaCurrent()` refuses to serve; tables are never created at runtime |
| A build pin unset or wrong | Warns, or fails the build |

Missing configuration is an error, never a reason to fall back to something weaker.

---

## Client workstation

→ [Kiosk Hardening](Kiosk-Hardening) for the full detail. In summary:

| Layer | Defends against |
| :--- | :--- |
| `overlayroot="tmpfs"` | Persistence of anything — malware, cached credentials, saved files |
| Locked root, masked gettys, no SSH | Any route to a shell |
| `DontVTSwitch`, `DontZap`, empty Openbox keybindings | Escaping the X session |
| sysctl hardening, no core dumps | Kernel information disclosure |
| Chromium deny-all `URLBlocklist` + allowlist | Unapproved browsing |
| `AllowFileSelectionDialogs: false` | A file-picker used as a file manager |
| Closed Shadow DOM + capture-phase event swallowing | A page tampering with the kiosk UI or evading the curtain |
| GRUB `--unrestricted` + install-time password | Editing the kernel command line |

### The loopback boundary

The agent binds **only** to `127.0.0.1:8888` and every request must satisfy both a loopback `Host` check and a loopback `Origin` check. The single exception is the kiosk extension's own origin (`chrome-extension://hfjmbeplebjipenkfabncgkpadnjmmoe`, pinned by the `key` in `manifest.json`): Chromium attaches it to the service worker's `POST` to `/api/admin/verify`. A web page cannot set `Origin`, and no other extension can hold that id.

The extension's service worker owns the `host_permissions` grant for that origin, so `content.js` never fetches the agent directly. This is why the agent can refuse cross-origin callers outright — it used to answer `Access-Control-Allow-Origin: *`, which meant **any site a student visited could talk to it**.

Mutating endpoints (`/api/install`, `/api/reboot`, `/api/setup`) re-validate their inputs inside the agent *and* inside the installer, because the sudoers rule lets `kiosk` invoke the installer directly. The agent is not a trust boundary.

---

## Known limits

### What is not defended

**Physical disassembly.** Anyone who can remove the drive can read it. Nothing on it is secret except an enrolment token, which is revocable from the dashboard in one click.

**A compromised control plane.** The client trusts its control plane by design. `safe_navigable_url()` restricts navigation to `http(s)`, so a hostile response cannot inject `javascript:` or `file:` — but a compromised control plane can point a lab at anything the allowlist permits.

**An unprotected tunnel.** `websockify` serves the full noVNC UI on the tunnel hostname. Without a Cloudflare Access policy, an 8-character RFB secret — about 32 bits, capped by the RFB protocol — is all that stands between the internet and a live classroom desktop. → [Remote Control](Remote-Control#cloudflare-access-is-mandatory)

**Screen content in transit and at rest.** Thumbnails are base64 JPEGs stored in D1 and served to authenticated teachers over HTTPS. They are not end-to-end encrypted. Anyone with database access can see the latest frame from every workstation.

**A malicious teacher.** A school admin can broadcast anything, read every screen, and take remote control. That is the product working as intended; the audit log records it, it does not prevent it.

### Deliberate choices that look like gaps

| Choice | Reason |
| :--- | :--- |
| `kiosk` has an **empty**, not locked, password | A locked account deadlocked nodm's PAM stack into a black screen. No login path exists to use it — every getty is masked and no SSH server is installed. |
| No blanket `ExtensionInstallBlocklist` | It makes Chromium refuse `--load-extension` entirely, silently removing the kiosk's own nav bar and lock curtain. |
| Camera and microphone are **not** blocked | Language labs and video lessons need them. |
| `grub.pin` is empty in the repository | A committed hash is one password shared by every customer, unrotatable and permanent in git history. |
| `--unrestricted` on every GRUB entry, unconditionally | Otherwise an installed disk gets `set superusers` with no unrestricted entry, and every workstation stops at a password prompt on every boot. |

---

## Reporting a vulnerability

**Do not open a public GitHub issue.** Use GitHub Security Advisories: the repository's **Security** tab → **Report a vulnerability**.

Particularly wanted:

- **Kiosk breakout** — escaping the locked Chromium session into a shell or the Openbox desktop.
- **Tenant isolation bypass** — reading or writing across school boundaries in D1 or the telemetry cache.
- **Authentication bypass** — flaws in the PBKDF2 implementation, session token generation, or cookie handling.
- **Remote code execution** in `agent.py` or its loopback API.
- **Device impersonation** — posting telemetry, draining a command queue, or reading an allowlist without a token issued through enrolment.
- **Supervision suppression** — a visited page removing or disabling the nav bar or lock curtain, or keeping a locked workstation usable.

**Response targets:** acknowledgement within 48 hours, triage within 5 business days, critical patches within 14 days with an advisory.

---

## Hardening recommendations for schools

1. **Firmware password** on every workstation, with USB and network booting disabled.
2. **Boot-menu password** set at install time, unique per site.
3. **Cloudflare Access** in front of every tunnel hostname, before the first tunnel goes live.
4. **Student VLAN** isolated from administrative networks.
5. **Rotate the enrollment key** when it has been shared outside IT staff, and when a technician leaves.
6. **Review the audit log** periodically — it records every command and settings change with the acting user.
7. **Decommission promptly.** A retired workstation with a live token is a valid telemetry source until it is revoked.

→ [Kiosk Hardening](Kiosk-Hardening) · [Control Plane Internals](Control-Plane-Internals) · [Remote Control](Remote-Control)
