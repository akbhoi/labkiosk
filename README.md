# Lab Kiosk OS & Cloud Control Platform

<div align="center">

[![License: Source-Available](https://img.shields.io/badge/License-Source--Available%20(Free%20for%20Education)-blue.svg)](LICENSE)
[![Co-Developed with AI](https://img.shields.io/badge/Co--Developed%20with-AI%20(Google%20DeepMind%20Antigravity)-7952b3.svg)](#ai-co-development-statement)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20SQL-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Debian 12](https://img.shields.io/badge/OS-Debian%2012%20(Bookworm)-A81D33?logo=debian&logoColor=white)](https://www.debian.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-CI-success)](#automated-testing)

**A next-generation, ultra-lightweight Linux Kiosk Operating System & Multi-Tenant Cloudflare Control Plane.**  
*Tailored for organization workstation fleets, thin clients (4 GB RAM, 12 GB SATA SSD), and remote room supervision.*

[Documentation Hub](#documentation-hub) • [Architecture](#architecture) • [5-Minute Quickstart](#5-minute-quickstart) • [Automated Testing](#automated-testing) • [AI Statement](#ai-co-development-statement) • [Licensing](#licensing--commercial-use)

</div>

---

<a id="overview"></a><a id="-overview"></a>
## 🌟 Overview

**Lab Kiosk** is an open, source-available operating system and edge cloud management platform engineered to replace expensive commercial kiosk software in educational organizations.

It provides organizations, and training centers with an enterprise-grade thin client environment that boots completely in RAM, prevents flash storage degradation, blocks unauthorized web browsing, and empowers operators with real-time visual control over user workstations.

Every organization receives its own isolated subdomain (e.g. `greenwood.labkiosk.example.com`), a customized **User Portal** with curated approved applications, and a live **Operator Control Console** with sub-second screen telemetry and embedded remote control.

---

<a id="documentation-hub"></a><a id="-documentation-hub"></a>
## 📚 Documentation Hub

To keep documentation clean, modular, and maintainable, in-depth guides are organized into dedicated documentation files:

| Guide | Description | Path |
| :--- | :--- | :--- |
| **Cloudflare Control Plane** | Edge SaaS worker architecture, native Web Crypto PBKDF2 authentication, D1 schema migrations, and local dev server. | [`cloudflare-control/README.md`](cloudflare-control/README.md) |
| **Kiosk Distro Builder** | Debian 12 live-build image, automated disk installer, 100% RAM overlay (`overlayroot="tmpfs"`), hybrid BIOS/UEFI bootloaders, and MV3 browser extension. | [`distro-builder/README.md`](distro-builder/README.md) |
| **Local Workstation Simulator** | Docker-based workstation simulator with embedded HTML5 noVNC display for rapid testing without physical thin clients. | [`docker-test/README.md`](docker-test/README.md) |
| **Production Deployment** | Step-by-step production manual: Cloudflare D1 provisioning, remote migrations, secrets, wildcard DNS, and automated CI/CD. | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |
| **Remote Control & Tunnels** | Zero-exposure remote desktop architecture via loopback `websockify`, per-boot ephemeral passwords, and Cloudflare Tunnels. | [`docs/REMOTE_CONTROL.md`](docs/REMOTE_CONTROL.md) |
| **REST API Specification** | Complete REST endpoint catalog, authentication schemes, tenant scoping rules, request/response schemas, and rate limits. | [`docs/API.md`](docs/API.md) |
| **AI Architecture Codices** | Modular architectural specifications and code invariants for AI coding assistants: [Master (`AGENTS.md`)](AGENTS.md) • [Distro Builder (`distro-builder/AGENTS.md`)](distro-builder/AGENTS.md) • [Control Plane (`cloudflare-control/AGENTS.md`)](cloudflare-control/AGENTS.md). | [`AGENTS.md`](AGENTS.md) |
| **AI Skills & Automation** | Standardized AI engineering skills for full-stack, distro, and edge control plane workflows. | [`.agents/skills/`](.agents/skills/) |
| **Security Policy** | Vulnerability reporting procedures, cryptographic standards, and threat model. | [`SECURITY.md`](SECURITY.md) |
| **Contribution Guidelines** | Community guidelines, coding standards, and pull request checklist. | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

---

<a id="architecture"></a><a id="-architecture"></a>
## 📐 Architecture

```text
+---------------------------------------------------------------------------------------+
|                               CLOUDFLARE EDGE SAAS LAYER                              |
|                                                                                       |
|   [ Public Visitors ]          [ Platform Owner ]           [ Organization Operators ]       |
|            │                           │                             │                |
|            ▼                           ▼                             ▼                |
|   labkiosk.domain.com       labkiosk.domain.com/super    greenwood.labkiosk.domain.com|
|    (Landing Page & ISO)      (Master Admin Console)        (Operator Lab Dashboard)    |
|            │                           │                             │                |
|            +---------------------------+-----------------------------+                |
|                                        │                                              |
|                                        ▼                                              |
|                     [ Cloudflare Worker Router: index.ts ]                            |
|                        ├── Web Crypto PBKDF2 Authentication                           |
|                        ├── guard.ts: Tenant Resolution, Authorization, CSRF origin    |
|                        ├── escape.ts: Output Escaping for every template              |
|                        ├── Nonce CSP + hardened headers on every HTML response        |
|                        ├── Device Token Enrolment & Verification                      |
|                        ├── scheduled(): hourly housekeeping (cron trigger)            |
|                        └── Cloudflare D1 Database (+ memory telemetry cache)          |
+---------------------------------------------------------------------------------------+
                                         ▲
                                         │ (HTTPS Telemetry / Remote Commands)
+---------------------------------------------------------------------------------------+
|                      CLIENT WORKSTATION LAYER (Intel Thin Clients)                    |
|                                                                                       |
|   Hardware: Intel x86_64 CPU, 4 GB RAM, 12 GB SATA SSD                                |
|   Kernel: Linux 6.1 (Debian 12 Minimal) with overlayroot="tmpfs" (100% RAM Overlay)   |
|   Display: Xorg Framebuffer + Openbox (Stripped Keybindings & Masked Virtual TTYs)    |
|                                                                                       |
|   [ Chromium Kiosk ] ◀─────── MV3 Extension (--load-extension, unpacked)              |
|         │                       ├── content.js    Nav bar + lock curtain (shadow DOM) |
|         │                       └── background.js Service worker ──▶ agent (loopback) |
|         ├── Native Top-Level Browsing (Full Hardware Acceleration, Zero iframe blocks)|
|         └── Managed Enterprise Policies (Dynamic URLAllowlist & Blocklist)            |
|                                                                                       |
|   [ Local Python 3 Agent: agent.py ]                                                  |
|         ├── First-Boot Enrolment Wizard (127.0.0.1:8888, loopback only)               |
|         ├── Authenticated Heartbeat & Screen Thumbnails (device bearer token, 3s)     |
|         └── Chromium Policy Synchronisation & Remote Command Dispatch                 |
|                                                                                       |
|   [ Remote Control Gateway ]                                                          |
|         └── x11vnc (password) + websockify on 127.0.0.1:6080 ──▶ Cloudflare Tunnel    |
+---------------------------------------------------------------------------------------+
```

<a id="key-platform-capabilities"></a><a id="-key-platform-capabilities"></a>
### 🛡️ Key Platform Invariants & Capabilities

- **Native Top-Level Navigation & Coordinated Reloads**: Chromium runs in native kiosk mode without `<iframe>` embedding. Remote operator commands such as `reload` are dispatched through an event-driven `reloadEpoch` handshake between the workstation agent (`agent.py`) and the browser extension (`content.js`), verified via `sessionStorage` to prevent infinite reload loops without relying on synthetic key injection (`xdotool`).
- **International Keyboard & Multilingual Support**: Workstation lockdown removes OS-level shortcut keys while `content.js` intercepts unauthorized keystrokes. Crucially, `content.js` respects `AltGr` (`event.getModifierState("AltGraph")`) and dead keys (`Dead`), allowing international users to type accented characters, `@`, `€`, and language-specific glyphs seamlessly. Dynamic RTL/LTR layout direction is supported across the wizard and kiosk bar.
- **Query-Aware Navigation**: Kiosk URL normalization strictly preserves search queries (`u.search`), ensuring web apps with room IDs or user session parameters (e.g. `?room=101&user=demo`) work properly and are not incorrectly detected as root broadcast URLs.
- **Centralized Interface Catalogs (i18n)**: The Super Admin Console (`/super`) provides full management for global workstation interface catalogs (`/api/super/i18n`), allowing administrators to upload, inspect, and delete language packs served to unenrolled and enrolled kiosks alike.

---

<a id="5-minute-quickstart"></a><a id="-5-minute-quickstart"></a>
## ⚡ 5-Minute Quickstart

### 1. Run the Control Plane Locally
```bash
cd cloudflare-control
pnpm install

# Configure local development secrets
cp .dev.vars.example .dev.vars

# Start dev server (automatically applies D1 schema migrations)
pnpm dev
```
The local control plane will be live on `http://localhost:8787`:
- **Public Landing Page:** `http://localhost:8787/`
- **User Portal:** `http://localhost:8787/?tenant=demo`
- **Operator Lab Dashboard:** `http://localhost:8787/admin?tenant=demo`
- **Super Admin Console:** `http://localhost:8787/super`

### 2. Launch the Workstation Simulator
Without requiring physical hardware, simulate an enrolled user workstation using Docker:
```bash
# From repository root -- builds from your working tree
docker compose up -d

# ...or pull the published image instead of building
docker compose pull && docker compose up -d
```
- Open [http://localhost:6080/vnc.html](http://localhost:6080/vnc.html) (VNC password: `labkiosk`).
- Complete the onboarding wizard using subdomain `demo` and the enrollment key from **Admin console → Settings → Workstation Enrollment Key**.
- See [`docker-test/README.md`](docker-test/README.md) for full simulation details.

---

<a id="automated-testing"></a><a id="-automated-testing"></a>
## 🧪 Automated Testing

The control plane includes a comprehensive integration suite covering the multi-tenant lifecycle, strict authorization, and defensive security controls:

```bash
# Strict TypeScript Typecheck (Worker runtime and Node test runner)
pnpm --prefix cloudflare-control run typecheck

# Automated Integration & Security Tests (60+ passing tests)
pnpm --prefix cloudflare-control test
```

| Area | What is asserted |
| :--- | :--- |
| **Authorization** | Every workstation-control and settings endpoint refuses anonymous callers. |
| **Tenant Isolation** | Operators at one organization receive `403 Forbidden` for other organizations' consoles, clients, and commands. |
| **Device Enrolment** | Invalid enrollment keys are rejected; valid keys issue device tokens; decommissioning revokes them. |
| **Telemetry Identity** | The device bearer token, never the request body, authoritatively dictates workstation identity. |
| **Output Escaping** | Hostile strings in tenant names or app titles render safely escaped across all interfaces. |
| **Command Delivery** | Broadcast navigations reach workstations exactly once without duplicate delivery. |
| **Browser Hardening** | Every HTML response enforces a nonce CSP, zero inline event handlers, HSTS, and COOP. |
| **CSRF Origin Guard** | Cookie-authenticated mutations from untrusted cross-site origins are rejected with `403`. |
| **Schema Integrity** | Asserts that `SCHEMA_SQL` in `db.ts` strictly matches all numbered files in `migrations/`. |

---

<a id="ai-co-development-statement"></a><a id="-ai-co-development-statement"></a>
## 🤖 AI Co-Development Statement

This project is proudly and transparently **co-developed with Artificial Intelligence**.

The entire software architecture, custom Debian live-build hooks, high-performance Cloudflare Worker router, serverless D1 schema, native Web Crypto implementation, and enterprise client extensions were iteratively designed, coded, and tested through pair-programming between the human maintainer and AI coding assistants, initially **Antigravity** (Google DeepMind) and subsequently Claude Code. The rules those agents follow live in [`AGENTS.md`](AGENTS.md) and [`.agents/skills/labkiosk-core/SKILL.md`](.agents/skills/labkiosk-core/SKILL.md).

We believe in open collaboration, transparent AI authorship, and leveraging artificial intelligence to build robust, secure, and accessible technology for rooms around the world.

---

<a id="licensing--commercial-use"></a><a id="-licensing--commercial-use"></a>
## 📜 Licensing & Commercial Use

Lab Kiosk is licensed under the **LabKiosk Software License (Source-Available, Educational & Commercial)**:

- **Free for Schools & Non-Profits (Up to 45 Computers):** 100% free and unrestricted for all accredited public and private K-12 schools, colleges, universities, teachers, educational foundations, and personal non-commercial evaluation on **up to 45 workstations**.
- **Companies & Other Organizations:** Businesses, government bodies and other organizations outside that educational grant use Lab Kiosk under a paid Commercial License or Subscriber License, whatever the number of computers.
- **45+ Computer Commercial Threshold:** Any party (including educational, academic, and non-commercial organizations) deploying **more than 45 computers** is viewed and treated as commercial scale, requiring a separate paid Commercial License or active Subscription License.
- **Commercial & MSP Restrictions:** Any commercial enterprise, for-profit corporate training academy, or Managed Service Provider (MSP) reselling Lab Kiosk as a paid commercial service, hosting it as a paid offering, or utilizing it for commercial gain must obtain a separate, paid Commercial License.
- **Software License vs. Subscriber License:** This document is the Software License. Subscribers utilizing the hosted Cloudflare Worker control plane are supported in accordance with the **Subscriber License** available directly within the Cloudflare Worker.
- **Proprietary & Source-Available:** This software does not convert to an open-source license. The copyright holders retain all intellectual property, proprietary title, and copyright worldwide.

For commercial licensing inquiries, large-scale deployments, or subscriber agreements, contact `legal@akbhoi.com`.
