# LabKiosk — AI Agent Instructions & Contributor Guide

Welcome to **Lab Kiosk**. This repository is an open, production-grade platform co-developed through human-AI pair programming.

To ensure consistency, security, and architectural integrity, all AI agents and human contributors must follow the invariants and procedures outlined below.

---

## 🧭 Repository Orientation

The repository is partitioned into two independent subsystems:

1. **Client Operating System & Distro Builder (`distro-builder/`)**:
   - Debian 12 (Bookworm) Live-Build pipeline.
   - Hybrid UEFI (GRUB EFI) + BIOS (ISOLINUX) boot menus.
   - 100% RAM overlay protection (`overlayroot="tmpfs"`).
   - Automated disk installer (`/usr/local/bin/labkiosk-install`).
   - Python 3 daemon (`agent.py`) binding strictly to loopback `127.0.0.1:8888`.
   - Chromium Manifest V3 extension (`content.js` + `background.js`) in Shadow DOM.
   - Detailed specification: [`distro-builder/AGENTS.md`](../distro-builder/AGENTS.md)
   - Specialized skill: [`skills/labkiosk-distro/SKILL.md`](../skills/labkiosk-distro/SKILL.md)

2. **Cloudflare SaaS Control Plane (`cloudflare-control/`)**:
   - Cloudflare Workers edge control plane (`src/index.ts`).
   - Cloudflare D1 SQL database with numbered migrations (`migrations/0001..0005.sql`).
   - Pure Web Crypto `PBKDF2-HMAC-SHA256` authentication (0 runtime npm dependencies).
   - Strict multi-tenant authorization guards (`src/guard.ts`).
   - Nonce-based Content Security Policy (CSP) and output escaping (`src/escape.ts`).
   - Detailed specification: [`cloudflare-control/AGENTS.md`](../cloudflare-control/AGENTS.md)
   - Specialized skill: [`skills/labkiosk-control/SKILL.md`](../skills/labkiosk-control/SKILL.md)

---

## ⚠️ Core Invariants (Do Not Violate)

- **Zero NPM Dependencies in Worker**: The Cloudflare Worker control plane uses 0 runtime dependencies. Use Web Crypto API (`crypto.subtle`) for hashing.
- **100% RAM Overlay**: Thin-client storage is protected from flash wear. All runtime file writes divert to RAM `tmpfs`.
- **Top-Level Navigation Only**: Never embed external educational web apps in `<iframe>` tags.
- **Multi-Tenant Data Isolation**: Every database query must filter by `tenant_id`. Authoritative consensus state must live in D1, not isolate memory.
- **The Schema Has Two Homes**: When editing database tables, update BOTH a new file in `migrations/` AND `SCHEMA_SQL` in `src/db.ts`.
- **Zero Inline Event Handlers**: CSP blocks inline `onclick=`. Use `data-action` attributes and delegated event listeners.
- **Fail Closed**: Missing configurations, invalid tokens, or unverified checksums must fail loudly.

---

## 🛠️ Verification Commands

Always run these commands before submitting changes:

```bash
# 1. Cloudflare Control Plane
pnpm --prefix cloudflare-control run typecheck
pnpm --prefix cloudflare-control test

# 2. Client Distro & Installer Syntax
python3 -m py_compile distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py
python3 -m py_compile distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js
```
