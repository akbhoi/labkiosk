# Security Policy

The Lab Kiosk maintainers and contributors are committed to protecting organizations, operators, and users. We take all security vulnerabilities seriously.

---

## Supported Versions

Only the latest release and the current `main` branch receive security updates:

| Component | Supported Version | Status |
| :--- | :--- | :--- |
| Cloudflare Control Plane | `v2.x` / `main` | :white_check_mark: Actively Supported |
| Debian 12 Kiosk Distro | `v2.x` / `main` | :white_check_mark: Actively Supported |
| Legacy Single-Organization Controller | `v1.x` | :x: End-of-Life (Upgrade Recommended) |

---

## Reporting a Vulnerability

If you discover a potential vulnerability in Lab Kiosk—such as:
- **Kiosk Breakout:** A method allowing a user to escape the locked Chromium session into an interactive bash shell or Openbox desktop.
- **Tenant Isolation Bypass:** An unauthorized read or write across organization tenant boundaries in Cloudflare D1 or an organization's OrgHub Durable Object.
- **Authentication Bypass:** Flaws in the PBKDF2 Web Crypto implementation, session token generation, or cookie security.
- **Remote Code Execution:** Vulnerabilities in the client Python agent (`agent.py`) or its local
  loopback API.
- **Device Impersonation:** Any way to post telemetry, drain a command queue, or read an organization's
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

## Hardening Recommendations for Organizations

1. **BIOS / UEFI Password:** Always set an administrative password in the Thin Client BIOS/UEFI and disable booting from unauthorized USB drives after installation.
2. **Network Isolation:** Where possible, place user thin clients on a dedicated user VLAN isolated from administrative organization networks.
3. **Grant `workstations` Deliberately:** Remote Control is opened by any operator signed in with the `workstations` permission for the organization; that sign-in, not the VNC password, is what protects a live desktop. Give the permission only to staff who need it.
4. **Change the Super Admin Credentials:** Set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` as
   Wrangler secrets before your first deploy; the worker will not serve a bound database without
   them (see item 9).
5. **Protect the Enrollment Key:** It is the only thing standing between a stranger and your
   users' screens. Rotate it from **Settings -> Workstation Enrollment Key** if a workstation or
   USB drive goes missing; workstations already enrolled keep working.
6. **Set a GRUB Boot-Menu Password:** Without one a user can edit the kernel command line at boot
   and obtain a root shell, which defeats every protection above it. Set it per installation in the
   setup wizard's **Install to Hard Disk** step: it is written to `boot/grub/labkiosk-password.cfg`
   on `LABKIOSK_ROOT`, outside every system image, so image updates and rollbacks keep it. To lock the
   live USB menu as well, build a per-customer ISO with `LABKIOSK_GRUB_PBKDF2` (or `grub.pin` for a
   single organization's own image); see `distro-builder/README.md`. Booting never prompts: only
   editing an entry or opening the GRUB shell asks for the password.
7. **Keep noVNC Pinned:** The console serves the Remote Control viewer from the exactly pinned
   `@novnc/novnc` devDependency in `cloudflare-control/package.json`. Do not relax this to a version
   range or an unpinned "latest" download.
8. **Keep the Remote Control Ports Off the LAN:** On the real image `x11vnc` runs behind a per-boot
   random password and listens on `127.0.0.1` only; Remote Control reaches it through the agent's
   outbound connection to the console's relay, and the image has no websockify or noVNC. Publishing
   port 5900 — or the agent's port 8888 — on `0.0.0.0` hands anyone on the organization Wi-Fi
   keyboard and mouse control of a user workstation. The Docker simulator publishes its own noVNC
   on the host's `127.0.0.1:6080` for development and is not a deployment target. The VNC password is reported to the
   control plane over the workstation's authenticated telemetry and stored per device; it is shown
   only to that organization's operators, carries the same sensitivity as the live screen thumbnails, and
   changes on every reboot.
9. **Set the Super Admin Secrets Before the First Deploy:** with a D1 database bound, the worker
   refuses to start until `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` are both set. There is no
   default account in production. Change the password from the `/super` console afterwards; doing so
   signs out every other browser holding the account.
10. **Browser-side defences are part of the design:** every page ships a nonce-based
    Content-Security-Policy with no inline event handlers, HSTS and `frame-ancestors 'none'`; a
    cookie-authenticated mutation is refused when its `Origin` is another site. Keep new templates
    and routes inside those rules (see `AGENTS.md`).
11. **Do Not "Harden" the Extension Policy:** Adding `ExtensionInstallBlocklist: ["*"]` to the Chromium
   managed policy looks like a tightening and is in fact a supervision outage: Chromium then refuses
   `--load-extension` and the workstation loses its navigation bar and lock curtain while continuing
   to report healthy telemetry. The policy file carries a comment explaining this; please read it
   before editing. Users cannot install extensions in any case.
12. **Automatic Bug Reports Are Opt-In:** an organization's workstation errors are filed as GitHub
    issues only when the deployment has set the `AI` binding, the `GITHUB_ISSUES_TOKEN` secret and
    the `GITHUB_ISSUES_REPO` variable, **and** that organization's administrator has turned the option
    on in **Settings → Errors & Warnings** after accepting the Automatic Bug Report Terms. Addresses,
    host names and identifiers are masked before anything leaves the control plane, but issues in a
    public repository are public: point `GITHUB_ISSUES_REPO` at a private repository if that matters,
    and give the token access to that one repository only (`docs/DEPLOYMENT.md`).
