# Lab Kiosk OS & Cloud Control Platform

<div align="center">

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1%20(Free%20for%20Schools)-blue.svg)](LICENSE)
[![Co-Developed with AI](https://img.shields.io/badge/Co--Developed%20with-AI%20(Google%20DeepMind%20Antigravity)-7952b3.svg)](#-ai-co-development-statement)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20SQL-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Debian 12](https://img.shields.io/badge/OS-Debian%2012%20(Bookworm)-A81D33?logo=debian&logoColor=white)](https://www.debian.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-CI-success)](#-automated-testing)

**A next-generation, ultra-lightweight Linux Kiosk Operating System & Multi-Tenant Cloudflare Control Plane.**  
*Tailored for school computer labs, thin clients (4 GB RAM, 12 GB SATA SSD), and remote classroom supervision.*

[Features](#-key-features) • [Architecture](#-architecture) • [Quickstart](#-quickstart-guide) • [Build the ISO](#-building-the-kiosk-iso) • [AI Statement](#-ai-co-development-statement) • [Licensing](#-licensing--commercial-use)

</div>

---

## 🌟 Overview

**Lab Kiosk** is an open, source-available operating system and cloud management platform engineered to replace expensive commercial kiosk software (such as Porteus Kiosk) in educational institutions. 

It provides public schools, universities, and non-profit training centers with an enterprise-grade thin client environment that boots completely in RAM, prevents flash memory degradation, blocks unauthorized internet access, and gives teachers instant, real-time visual control over student workstations.

Every workstation enrols against exactly one school using that school's enrollment key, and every teacher sees exactly one school's screens. The control plane refuses anonymous access to student telemetry.

Every school receives its own isolated subdomain (e.g. `greenwood.labkiosk.akbhoi.com`), a customized **Student Learning Portal** with curated educational web applications, and a live **Teacher Control Console** with sub-second screen telemetry and embedded remote control.

---

## 🚀 Key Features

### 💻 Client Kiosk OS (Debian 12 Bookworm)
- **100% RAM Overlay (`toram` + `overlayroot="tmpfs"`):** The image is copied into RAM at boot and the root filesystem is read-only with a tmpfs overlay. Browser cache, agent logs and all student activity live in RAM and are gone on reboot, so the thin client's SSD is never written to at all.
- **Hardened Lockdown:** Virtual TTY consoles (TTY1–TTY6) masked and VT switching disabled at the X server (`DontVTSwitch`, `DontZap`); Openbox ships with an empty keybinding table so `Alt+Tab`, `Alt+F4` and friends do nothing; the `kiosk` and `root` accounts are locked; shutdown and reboot are reserved for teachers through a narrowly scoped polkit rule.
- **Top-Level Native Browsing (Zero-Margin Viewport):** Unlike legacy kiosk wrappers that suffer from `X-Frame-Options` and CSP iframe blocking, Lab Kiosk loads websites as native top-level pages. A Manifest V3 Chromium extension injects an **auto-hiding 44px navigation bar** (Home, Back, Forward, Reload, Status Shield) that smoothly reveals only when moving the cursor to the top edge. The injected content script never talks to the agent directly: it messages the extension's **service worker**, which holds the `host_permissions` grant for `127.0.0.1:8888`. That is what allows the agent to refuse wildcard CORS instead of advertising itself to every site a student visits.
- **Remote Lock Curtain (Eyes to the Front):** One-click full-screen lock curtain with custom teacher announcements ("Class attention please! Eyes to the board"). The curtain covers the page and discards mouse and keyboard events aimed at it; it is a browser-level block, not an X11 input grab, so it works alongside Chromium's kiosk mode rather than replacing it.
- **Dynamic Policy Synchronization:** A background Python agent receives the school's approved domain list on each heartbeat and writes it into Chromium's managed enterprise policy file, which Chromium re-reads on its own policy refresh. Chromium reads its *boot* policy once at startup, so the agent additionally restarts the browser after the first policy sync that follows enrolment — without that, a workstation that had just enrolled kept running under the minimal boot allowlist and showed "This page is blocked" on its own school portal.
- **First-Boot Setup Wizard (`/setup`):** On a fresh workstation the browser opens an onboarding GUI that asks for the school subdomain, a PC identifier (e.g. `PC-01`), and the school's **enrollment key**. The agent verifies all three against the Cloudflare Worker before writing anything to disk, so a typo is caught immediately instead of leaving the machine permanently misconfigured. Enrolment returns the school's own portal URL, so the relaunched browser lands on the student portal rather than the public landing page. Once enrolled, the wizard refuses to serve again.
- **Enterprise Chromium Policy:** `URLBlocklist` denies `http://*` and `https://*` outright and the school's approved domains are added back by the agent, so filtering is deny-by-default. `chrome://`, `file://` and `javascript://` are blocked, DevTools are disabled, and downloads, printing, sign-in, sync and password storage are off. The policy deliberately contains **no blanket extension block**: `ExtensionInstallBlocklist: ["*"]` makes Chromium refuse `--load-extension` altogether and silently removes the kiosk's own navigation bar and lock curtain. Students still cannot install anything — `chrome://` is unreachable, the Web Store is not allowlisted, and the browser profile is deleted on every launch.

### ☁️ Cloud Control Plane (Cloudflare Workers + D1)
- **Multi-Tenant SaaS Architecture:** Single-worker routing across wildcard subdomains (`*.labkiosk.akbhoi.com`). Complete tenant data isolation.
- **Serverless SQL (Cloudflare D1):** Relational tables for schools, admin users, sessions, student portal apps, client devices, audit logs, and command queues.
- **Native Web Crypto Authentication:** Zero-dependency PBKDF2-HMAC-SHA256 password hashing (32-byte salt, 100,000 iterations), `HttpOnly; Secure; SameSite=Lax` session cookies scoped to the parent domain, server-side password policy, and exponential back-off after repeated failed sign-ins.
- **Per-Device Enrolment:** Workstations authenticate to the telemetry API with a bearer token issued once, by exchanging the school's rotatable enrollment key. Only a SHA-256 of each token is stored, and decommissioning a workstation revokes it.
- **Enforced Tenant Isolation:** Every workstation-control and configuration endpoint requires a session that administers the school in question. The school is taken from the `Host` header; a `?tenant=` override is honoured only for local development or for a caller who already administers that school.
- **Audit Trail:** Sign-ins, command dispatch, enrolment, portal and allowlist edits, and subdomain approvals are recorded per school and readable at `/api/audit-logs`.
- **Student Learning Portal & Custom Branding:** Fully customizable application launchpad featuring responsive cards with high-res thumbnails, category badges, and single-click launch. Teachers can customize the portal hero title, subtitle, instruction description, and footer note to match their institution or department.
- **Direct Single-Site Lockdown vs. App Launcher Grid:** Configurable homepage mode per lab, accessible from both the Student Learning Portal modal and Lab Settings & Customization. Schools, universities, colleges, and testing centers can lock thin clients directly to an LMS (Canvas, Blackboard, Moodle), CBT exam platform, or catalog (`single_url` mode) with 100% full-screen lockdown, or use the visual App Launcher Grid (`portal` mode). Target lockdown domains are automatically whitelisted with smart protocol resolution.
- **Dynamic Broadcast URL Shortcuts & Auto-Whitelisting:** Quick-launch broadcast shortcuts customizable per tenant via D1 (`broadcast_presets`). Shortcuts can be added, deleted, or auto-populated from approved portal apps. Shortcut domains and active broadcasts are automatically injected into the effective Chromium allowlist so lessons and exams are never blocked.
- **Customizable Screen Freeze Announcements:** Freeze screens with custom announcements ("Midterm Exam Active", "Class demonstration in progress", "Lab time ended") with configurable quick-announcement chips and customizable tenant-level default lock messages.
- **Dynamic Workstation Collection:** Real-time grid that displays only active thin clients (no fixed 40-slot limit). Features 1-click workstation decommissioning (`✕`).
- **Sub-Second Fleet Monitoring:** Ingests live screen thumbnails every 3 seconds from enrolled workstations, capped at 256 KB each and persisted in D1 so the grid survives worker isolate recycling.
- **In-Browser Remote Desktop (noVNC):** Clicking any workstation card opens an on-demand remote control session. On the real image `x11vnc` is password-protected and `websockify` is bound to loopback, so the session is reachable only through a Cloudflare Tunnel and never directly over the school LAN.
- **Super Admin Platform Console (`/super`):** Master dashboard for the platform owner to approve or reject requested school subdomains, manage tenant slugs, and monitor global fleet metrics.

---

## 📐 Architecture

```text
+---------------------------------------------------------------------------------------+
|                               CLOUDFLARE EDGE SAAS LAYER                              |
|                                                                                       |
|   [ Public Visitors ]          [ Platform Owner ]           [ School Teachers ]       |
|            │                           │                             │                |
|            ▼                           ▼                             ▼                |
|   labkiosk.akbhoi.com      labkiosk.akbhoi.com/super    greenwood.labkiosk.akbhoi.com |
|    (Landing Page & ISO)      (Master Admin Console)        (Teacher Lab Dashboard)    |
|            │                           │                             │                |
|            +---------------------------+-----------------------------+                |
|                                        │                                              |
|                                        ▼                                              |
|                     [ Cloudflare Worker Router: index.ts ]                            |
|                        ├── Web Crypto PBKDF2 Authentication                           |
|                        ├── guard.ts: Tenant Resolution & Authorization                |
|                        ├── escape.ts: Output Escaping for every template              |
|                        ├── Device Token Enrolment & Verification                      |
|                        └── Cloudflare D1 Database (+ memory telemetry cache)          |
+---------------------------------------------------------------------------------------+
                                         ▲
                                         │ (HTTPS Telemetry / Remote Commands)
+---------------------------------------------------------------------------------------+
|                      CLIENT WORKSTATION LAYER (Intel Thin Clients)                    |
|                                                                                       |
|   Hardware: Intel x86_64 CPU, 4 GB RAM, 12 GB SATA SSD                                |
|   Kernel: Linux 6.1 (Debian 12 Minimal) with overlayroot="tmpfs" (RAM Overlay)        |
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

---

## 📂 Repository Layout

```text
labkiosk/
├── distro-builder/                     # Debian 12 live-build OS generator
│   ├── auto/                           # live-build automation scripts (config, build, clean)
│   ├── config/
│   │   ├── package-lists/kiosk.list    # Minimal package list (Xorg, Openbox, Chromium, etc.)
│   │   ├── hooks/live/                 # TTY masking & kernel hardening hooks
│   │   └── includes.chroot/            # Rootfs overlay
│   │       ├── etc/chromium/policies/  # Enterprise policy templates
│   │       ├── etc/openbox/            # Locked window manager configs
│   │       ├── etc/overlayroot.conf    # RAM overlay tmpfs declaration
│   │       └── opt/labkiosk/
│   │           ├── setup/              # First-boot HTML5 onboarding wizard
│   │           ├── extension/          # Manifest V3 nav bar & lock curtain
│   │           │   ├── content.js      # Shadow-DOM nav bar, curtain, input swallowing
│   │           │   └── background.js   # Service worker: the only caller of the agent
│   │           └── agent/              # Python 3 telemetry & command agent
│   ├── Dockerfile                      # Containerized cross-platform ISO builder
│   └── build-iso.sh                    # Linux native build script
│
├── cloudflare-control/                 # Cloudflare Workers multi-tenant control plane
│   ├── migrations/                     # Cloudflare D1 SQL schema migrations
│   ├── src/
│   │   ├── index.ts                    # Worker router & REST API
│   │   ├── guard.ts                     # Tenant resolution & authorization guards
│   │   ├── escape.ts                    # HTML / attribute / JSON output escaping
│   │   ├── db.ts                       # D1 data layer & default tenant seeding
│   │   ├── auth.ts                     # Native Web Crypto PBKDF2 authentication
│   │   ├── d1_adapter.ts               # Local in-memory D1 test adapter (Node 22+)
│   │   ├── ui.ts                       # Teacher Dashboard console UI
│   │   ├── ui_landing.ts               # Public SaaS landing page
│   │   ├── ui_portal.ts                # Student Learning Portal UI
│   │   ├── ui_super.ts                 # Super Admin master console
│   │   └── types.ts                    # TypeScript interface models
│   ├── test/                           # Automated integration test suite
│   ├── wrangler.jsonc                  # Wrangler configuration
│   └── tsconfig.json                   # Strict TypeScript compiler configuration
│
├── .github/
│   ├── workflows/                      # GitHub Actions CI & ISO Build workflows
│   ├── ISSUE_TEMPLATE/                 # Structured bug report & feature forms
│   └── PULL_REQUEST_TEMPLATE.md        # Pull request template
│
├── AGENTS.md                           # AI agent architecture & maintenance guidelines
├── skills/labkiosk-core/SKILL.md       # Antigravity / AI Agent operational skill
├── CONTRIBUTING.md                     # Community contribution guidelines
├── SECURITY.md                         # Vulnerability disclosure policy
├── CODE_OF_CONDUCT.md                  # Contributor Covenant v2.1
├── LICENSE                             # Business Source License 1.1 (Free for Schools)
├── docker-test/                        # Simulator image: same agent, extension and policies
└── docker-compose.yml                  # Local workstation simulator with noVNC
```

---

## ⚡ Quickstart Guide

### 1. Prerequisites
- **Node.js:** v22.0.0 or higher
- **Package Manager:** `pnpm` (`npm install -g pnpm`)
- **Docker:** (Optional, for testing client simulation locally)

### 2. Start Local Cloudflare Control Plane
```bash
cd cloudflare-control
pnpm install

# Run automated multi-tenant unit tests
pnpm test

# Launch local development server with hot-reload
pnpm dev
```
The local control plane will be live on `http://localhost:8787`:
- **Public SaaS Landing Page:** `http://localhost:8787/`
- **Student Learning Portal:** `http://localhost:8787/?tenant=demo`
- **Teacher Lab Dashboard:** `http://localhost:8787/admin?tenant=demo`
- **Super Admin Console:** `http://localhost:8787/super`

> **Super admin credentials.** When `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` are unset, the
> worker seeds a well-known default account (`admin@akbhoi.com` / `SuperAdmin2026!`) so local
> development works out of the box. **Set both as Wrangler secrets before deploying** — the default
> is public knowledge and grants control of every school on the platform:
> ```bash
> npx wrangler secret put SUPER_ADMIN_EMAIL && npx wrangler secret put SUPER_ADMIN_PASSWORD
> ```

### 3. Deploy the Control Plane
```bash
cd cloudflare-control
npx wrangler d1 create labkiosk-db          # paste the id into wrangler.jsonc
npx wrangler d1 migrations apply labkiosk-db --remote
npx wrangler secret put SUPER_ADMIN_EMAIL
npx wrangler secret put SUPER_ADMIN_PASSWORD
npx wrangler deploy
```
Point a wildcard DNS record (`CNAME *`) at the worker so each school's subdomain resolves, and edit
the `routes` and `DEFAULT_DOMAIN` entries in `wrangler.jsonc` to match your own zone.

The worker refuses to start without a D1 binding rather than silently falling back to an in-memory
database, so a misconfigured deployment fails loudly instead of quietly losing every school's data.

### 4. Launch Docker Client Simulator
You can simulate a live thin client without needing physical hardware:
```bash
# From repository root, with `pnpm dev` already running
docker compose up -d
```
(On installations that still ship Compose v1 — including Podman's `docker` shim — the command is
`docker-compose up -d`.)
- **In-Browser Workstation Display:** Open [http://localhost:6080/vnc.html](http://localhost:6080/vnc.html)
  (VNC password: `labkiosk`, set via the `VNC_PASSWORD` environment variable in `docker-compose.yml`)
- The simulated workstation boots straight into the **first-boot setup wizard**. Enrol it the way a
  real one is enrolled: enter the school subdomain (`demo`), a workstation name (`PC-01`), and the
  school's **enrollment key**, which you can read from the teacher dashboard under
  **Settings → Workstation Enrollment Key**.
- After enrolment the agent writes the school's Chromium policy and relaunches the browser once, so
  the kiosk lands on the student portal. The screen going briefly black is that restart, not a crash.
- Once enrolled, the workstation appears on the teacher dashboard at
  `http://localhost:8787/admin?tenant=demo`.

> The agent's local API binds to `127.0.0.1` inside the container, exactly as it does on a real
> workstation, so the wizard is driven from the noVNC screen rather than from your host browser.

By default the simulator enrols against `http://host.docker.internal:8787`. Set `WORKER_URL` to point
it somewhere else — a deployed worker, or `pnpm dev` on another port. The agent accepts a plain
`http://` origin only for loopback and container-gateway hosts; every other worker URL must be
`https://`.

---

## 💿 Building the Kiosk ISO

### Method 1: Using Docker (Windows, macOS, Linux)
No Linux installation required:
```bash
docker build -t labkiosk-builder distro-builder
docker run --privileged --rm -v "$PWD/distro-builder/out:/build/out" labkiosk-builder
```
The ready-to-flash `labkiosk-debian12-amd64.iso` and its `.sha256` are written to
`distro-builder/out/`.

> **Cloudflare Tunnel binary.** The build only installs `cloudflared` when a release is pinned in
> `distro-builder/config/includes.chroot/usr/share/labkiosk/cloudflared.pin`, and it verifies the
> download against the SHA-256 recorded there. With nothing pinned the image still builds and boots;
> it simply has no tunnel, so remote control is unavailable until you pin a release. The build never
> ships an unverified binary fetched from the network.

### Method 2: Native Linux / WSL2
On Debian 12 or Ubuntu 22.04+:
```bash
sudo apt-get update && sudo apt-get install -y live-build debootstrap
cd distro-builder
sudo bash build-iso.sh
```

### Method 3: Flash to USB Drive
Use **Rufus** (Windows) in *DD Image mode* or **balenaEtcher** (Mac/Linux) to write the generated ISO onto any standard 2 GB+ USB drive. Insert the USB drive into your Thin Client and boot via BIOS/UEFI.

> **This is a live image.** It boots entirely into RAM (`toram`) and ships no installer, so it runs
> from the USB drive on every boot rather than being installed to the thin client's SSD. That is
> what delivers the zero-SSD-wear guarantee, and it also means each workstation must be enrolled
> again if its USB drive is replaced. Adding a persistent install path would need an installer
> (for example `calamares`) in `config/package-lists/kiosk.list.chroot`.

### Securing the Boot Chain
Everything this image enforces — masked TTYs, disabled VT switching, locked accounts, Chromium
policy — is started *by GRUB*. A student who can edit the boot entry appends `init=/bin/sh` and gets
a root shell before any of it runs, so the boot chain is where kiosk hardening actually begins.

1. **Set a GRUB password** before building. Generate a hash and record it in
   `distro-builder/config/includes.chroot/usr/share/labkiosk/grub.pin`:
   ```bash
   grub-mkpasswd-pbkdf2
   ```
   Copy the printed `grub.pbkdf2.sha512....` value into `PASSWORD_PBKDF2=`. The hash is safe to
   commit — it is a salted digest, not the password. The build then locks the menu: the kiosk still
   boots its default entry with no prompt, but editing an entry or opening the GRUB command line
   asks for the password. Leave it empty and the build prints a warning and produces an image with
   an editable boot menu, which is fine for a VM but not for a classroom.
2. **Set a BIOS/UEFI password and disable USB boot** once the image is deployed, so the workstation
   cannot simply be booted from a different drive.

---

## 🔌 Control Plane API

The school a request acts on comes from the `Host` header. A `?tenant=` / `X-Tenant` override is
honoured only on a local development host, for a super admin, or for a session that already
administers that school — everything else is answered as if the parameter were absent. Authorization
is applied by `src/guard.ts`; no route resolves a tenant or checks a role by hand.

| Endpoint | Method | Who may call it |
| :--- | :--- | :--- |
| `/api/status` | GET | Anyone (health and mode probe) |
| `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me` | POST / GET | Public; login is rate-limited with exponential back-off |
| `/api/portal-sites` | GET | Public — students load the portal |
| `/api/portal-sites`, `/api/portal-sites/:id` | POST / DELETE | Teacher administering this school |
| `/api/settings/mode` | POST | Teacher administering this school (switch `portal` or `single_url` and configure target URL) |
| `/api/settings/customization` | GET / POST | Teacher administering this school (custom lab name, lock announcement, portal branding) |
| `/api/broadcast-presets`, `/api/broadcast-presets/:id` | GET / POST / DELETE | Teacher administering this school (manage quick launch broadcast shortcuts) |
| `/api/settings/subdomain` | POST | Teacher administering this school |
| `/api/settings/enrollment-key` | GET / POST | Teacher administering this school (POST rotates it) |
| `/api/whitelist` | GET / POST | Teacher administering this school |
| `/api/clients`, `/api/clients/remove` | GET / POST | Teacher administering this school |
| `/api/command` | POST | Teacher administering this school |
| `/api/audit-logs` | GET | Teacher administering this school |
| `/api/devices/enroll` | POST | Anyone holding the school's current enrollment key |
| `/api/telemetry` | POST | An enrolled workstation, via `Authorization: Bearer <device token>` |
| `/api/super/tenants/approve`, `/api/super/tenants/reject` | POST | Super admin only |

Two properties are worth stating explicitly because they are easy to regress:

- **A workstation's identity is its token.** `/api/telemetry` ignores any `clientId` or tenant the
  request body claims and uses the values bound to the presented device token.
- **Removing a workstation revokes it.** `/api/clients/remove` deletes the device and its tokens, so a
  decommissioned machine cannot keep reporting.

---

## 🧪 Automated Testing

The control plane ships an integration suite covering the multi-tenant lifecycle **and** the
security properties that protect it — authorization, tenant isolation, device enrolment, output
escaping, and command-delivery semantics:

```bash
pnpm --prefix cloudflare-control run typecheck
```
```bash
pnpm --prefix cloudflare-control test
```

Among the behaviours pinned by tests:

| Area | What is asserted |
| :--- | :--- |
| Authorization | Every workstation-control and settings endpoint refuses an anonymous caller |
| Tenant isolation | A teacher at one school gets `403` for another school's console, clients and commands |
| Device enrolment | A wrong enrollment key is refused; a valid one issues a token; removal revokes it |
| Telemetry identity | The device token, never the request body, decides which workstation reported |
| Output escaping | A hostile school name and app title render escaped in `/super` and the student portal |
| Command delivery | A broadcast reaches each workstation exactly once, not on every heartbeat |
| Single-site lockdown | Custom LMS/exam URLs are validated, persisted, and automatically whitelisted |
| Customization & Branding | Lab name, lock messages, and portal titles/subtitles update and reflect in student UI |
| Broadcast presets | Presets are validated, scoped per tenant, listed in dashboard, and removable |
| Markup integrity | The rendered dashboard has balanced tags and no modal nested inside another |
| Schema integrity | `SCHEMA_SQL` in `db.ts` declares the same tables and columns as `migrations/` |

---

## 🤖 AI Co-Development Statement

This project is proudly and transparently **co-developed with Artificial Intelligence**.

The entire software architecture, custom Debian live-build hooks, high-performance Cloudflare Worker router, serverless D1 schema, native Web Crypto implementation, and enterprise client extensions were iteratively designed, coded, and tested through pair-programming between the human maintainer and **Antigravity** (Google DeepMind's Advanced Autonomous AI Coding Assistant).

We believe in open collaboration, transparent AI authorship, and leveraging artificial intelligence to build robust, secure, and accessible technology for classrooms around the world.

---

## 📜 Licensing & Commercial Use

Lab Kiosk is released under the **Business Source License 1.1 (BSL 1.1)**:

- **Free for Schools & Non-Profits:** 100% free and unrestricted for all public and non-commercial K-12 schools, colleges, universities, teachers, educational foundations, and personal evaluation.
- **Commercial & MSP Use:** Any commercial enterprise, private for-profit academy, or Managed Service Provider (MSP) reselling Lab Kiosk as a paid commercial service or utilizing it for commercial gain must obtain a commercial license.
- **Change Date:** On **January 1, 2030**, this software automatically converts to the fully open-source **Apache License, Version 2.0**.

For commercial licensing inquiries or custom deployment support, please open an issue or contact the maintainers.
