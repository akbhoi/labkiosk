# GitHub Copilot Instructions — Lab Kiosk

These instructions guide GitHub Copilot when assisting contributors on the Lab Kiosk codebase.

## Subsystem Architecture
- **Client OS & Distro (`distro-builder/`)**: Debian 12 Live ISO, Openbox, Python daemon (`agent.py`), disk installer (`labkiosk-install`), Manifest V3 Chrome extension. Read `distro-builder/AGENTS.md`.
- **Control Plane (`cloudflare-control/`)**: Cloudflare Workers edge SaaS, D1 SQLite database, native Web Crypto PBKDF2 authentication, nonce-based CSP. Read `cloudflare-control/AGENTS.md`.

## Mandatory Coding Invariants
1. **0 Runtime NPM Dependencies in Worker**: Always use native `crypto.subtle` (Web Crypto API) for cryptographic operations (`PBKDF2-HMAC-SHA256`, 100k iterations, 32-byte salt).
2. **100% RAM Overlay**: The client operating system must never write dynamic files to disk; all writes divert to `overlayroot="tmpfs"`.
3. **Top-Level Navigation Only**: Never load external learning sites inside `<iframe>`. Load as native top-level browser pages with the MV3 extension shadow root header.
4. **Multi-Tenant Filtering**: All queries in `cloudflare-control/src/db.ts` must filter by `tenant_id`.
5. **Two Homes for Database Schema**: When adding/modifying tables, always add a new migration in `cloudflare-control/migrations/` AND update `SCHEMA_SQL` in `cloudflare-control/src/db.ts`.
6. **No Inline Event Handlers**: Strict CSP disallows `onclick=`, `onsubmit=`, etc. Use `data-action` attributes and event listeners.
7. **Installer Output Separation**: In `distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`, all logs must print to `file=sys.stderr`. `sys.stdout` must only output valid JSON.

## Verification Commands
- `pnpm --prefix cloudflare-control run typecheck`
- `pnpm --prefix cloudflare-control test`
- `python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install`
- `node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js`
