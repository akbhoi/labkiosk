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
- **Remote Code Execution:** Vulnerabilities in the client Python agent (`agent.py`) or local wrapper API.

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
