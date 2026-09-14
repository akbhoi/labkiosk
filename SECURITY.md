# Security Policy

The Lab Kiosk maintainers and contributors are committed to protecting schools, teachers, and students. We take all security vulnerabilities seriously.

---

## Supported Versions

Only the latest release and the current `main` branch receive security updates:

| Component | Supported Version | Status |
| :--- | :--- | :--- |
| Cloudflare Control Plane | `v2.x` / `main` | :white_check_mark: Actively Supported |
| Debian 12 Kiosk Distro | `v2.x` / `main` | :white_check_mark: Actively Supported |
| Legacy Single-School Controller | `v1.x` | :x: End-of-Life (Upgrade Recommended) |

---

## Reporting a Vulnerability

If you discover a potential vulnerability in Lab Kiosk—such as:
- **Kiosk Breakout:** A method allowing a student to escape the locked Chromium session into an interactive bash shell or Openbox desktop.
- **Tenant Isolation Bypass:** An unauthorized read or write across school tenant boundaries in Cloudflare D1 or the telemetry cache.
- **Authentication Bypass:** Flaws in the PBKDF2 Web Crypto implementation, session token generation, or cookie security.
- **Remote Code Execution:** Vulnerabilities in the client Python agent (`agent.py`) or its local
  loopback API.
- **Device Impersonation:** Any way to post telemetry, drain a command queue, or read a school's
  allowlist without a valid device token issued through enrolment.
- **Supervision Suppression:** A way for a visited page to remove or disable the injected navigation
  bar or lock curtain, or to keep a locked workstation usable.

### How to Report
Please **DO NOT** report security vulnerabilities in public GitHub issues.

Instead, please submit your findings privately via GitHub Security Advisories:
1. Navigate to the **Security** tab of the GitHub repository.
2. Click **Report a vulnerability**.
3. Provide detailed reproduction steps, potential impact, and suggested remediation if available.

### Response Timeline
- **Acknowledgment:** Within 48 hours of receipt.
- **Triage & Assessment:** Within 5 business days.
- **Patch & Advisory Release:** Critical vulnerabilities will be patched within 14 days and accompanied by a security advisory.

---

## Hardening Recommendations for Schools

1. **BIOS / UEFI Password:** Always set an administrative password in the Thin Client BIOS/UEFI and disable booting from unauthorized USB drives after installation.
2. **Network Isolation:** Where possible, place student thin clients on a dedicated student VLAN isolated from administrative school networks.
3. **Cloudflare Tunnel Secrets:** Store Cloudflare Tunnel tokens securely in environment variables; never commit raw credentials into public configuration files.
4. **Change the Super Admin Credentials:** Set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` as
   Wrangler secrets before your first deploy; the worker will not serve a bound database without
   them (see item 9).
5. **Protect the Enrollment Key:** It is the only thing standing between a stranger and your
   students' screens. Rotate it from **Settings -> Workstation Enrollment Key** if a workstation or
   USB drive goes missing; workstations already enrolled keep working.
6. **Set a GRUB Password Before Building:** Record a `grub-mkpasswd-pbkdf2` hash in
   `distro-builder/config/includes.chroot/usr/share/labkiosk/grub.pin`. Without it a student can edit
   the kernel command line at boot and obtain a root shell, which defeats every protection above it.
   The build warns when no password is pinned.
7. **Pin cloudflared:** The build installs the Cloudflare Tunnel binary only from a version and
   SHA-256 recorded in `cloudflared.pin`, and fails on a mismatch. Do not relax this to an unpinned
   "latest" download.
8. **Keep the Remote Control Ports Off the LAN:** On the real image `x11vnc` runs behind a per-boot
   random password and `websockify` binds to `127.0.0.1`, so remote control is reachable only through
   the Cloudflare Tunnel. Publishing port 6080 — or the agent's port 8888 — on `0.0.0.0` hands anyone
   on the school Wi-Fi keyboard and mouse control of a student workstation. The Docker simulator
   publishes 6080 deliberately and is not a deployment target. The VNC password is reported to the
   control plane over the workstation's authenticated telemetry and stored per device; it is shown
   only to that school's teachers, carries the same sensitivity as the live screen thumbnails, and
   changes on every reboot.
9. **Set the Super Admin Secrets Before the First Deploy:** with a D1 database bound, the worker
   refuses to start until `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` are both set. There is no
   default account in production. Change the password from the `/super` console afterwards; doing so
   signs out every other browser holding the account.
10. **Browser-side defences are part of the design:** every page ships a nonce-based
    Content-Security-Policy with no inline event handlers, HSTS and `frame-ancestors 'none'`; a
    cookie-authenticated mutation is refused when its `Origin` is another site. Keep new templates
    and routes inside those rules (see `AGENTS.md`).
9. **Do Not "Harden" the Extension Policy:** Adding `ExtensionInstallBlocklist: ["*"]` to the Chromium
   managed policy looks like a tightening and is in fact a supervision outage: Chromium then refuses
   `--load-extension` and the workstation loses its navigation bar and lock curtain while continuing
   to report healthy telemetry. The policy file carries a comment explaining this; please read it
   before editing. Students cannot install extensions in any case.
