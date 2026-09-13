# Lab Kiosk OS & Cloud Control Platform

<div align="center">

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1%20(Free%20for%20Schools)-blue.svg)](LICENSE)
[![Co-Developed with AI](https://img.shields.io/badge/Co--Developed%20with-AI%20(Google%20DeepMind%20Antigravity)-7952b3.svg)](#-ai-co-development-statement)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20SQL-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Debian 12](https://img.shields.io/badge/OS-Debian%2012%20(Bookworm)-A81D33?logo=debian&logoColor=white)](https://www.debian.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-8%2F8%20Passing-success)](#-automated-testing)

**A next-generation, ultra-lightweight Linux Kiosk Operating System & Multi-Tenant Cloudflare Control Plane.**  
*Tailored for school computer labs, thin clients (4 GB RAM, 12 GB SATA SSD), and remote classroom supervision.*

[Features](#-key-features) • [Architecture](#-architecture) • [Quickstart](#-quickstart-guide) • [Build the ISO](#-building-the-kiosk-iso) • [AI Statement](#-ai-co-development-statement) • [Licensing](#-licensing--commercial-use)

</div>

---

## 🌟 Overview

**Lab Kiosk** is an open, source-available operating system and cloud management platform engineered to replace expensive commercial kiosk software (such as Porteus Kiosk) in educational institutions. 

It provides public schools, universities, and non-profit training centers with an enterprise-grade thin client environment that boots completely in RAM, prevents flash memory degradation, blocks unauthorized internet access, and gives teachers instant, real-time visual control over student workstations.

Every school receives its own isolated subdomain (e.g. `greenwood.labkiosk.io`), a customized **Student Learning Portal** with curated educational web applications, and a live **Teacher Control Console** with sub-second screen telemetry and embedded remote control.

---

## 🚀 Key Features

### 💻 Client Kiosk OS (Debian 12 Bookworm)
- **100% RAM Overlay (`overlayroot="tmpfs"`):** When thin clients boot, the 12 GB SATA SSD is mounted read-only (`ro`). All temporary files, browser cache, and student activity reside strictly in RAM. Zero disk wear, instant reboot recovery.
- **Hardened Lockdown:** Virtual TTY consoles (TTY1–TTY6) masked; escape shortcuts (`Alt+Tab`, `Alt+F4`, `Ctrl+Alt+Del`, `F11`) stripped from Openbox window manager; system shutdown/reboot reserved for teachers.
- **Top-Level Native Browsing (Zero-Margin Viewport):** Unlike legacy kiosk wrappers that suffer from `X-Frame-Options` and CSP iframe blocking, Lab Kiosk loads websites as native top-level pages. An enterprise Chromium extension injects an **auto-hiding 44px navigation bar** (Home, Back, Forward, Reload, Status Shield) that smoothly reveals only when moving the cursor to the top edge.
- **Remote Lock Curtain (Eyes to the Front):** One-click full-screen lock curtain with custom teacher announcements ("Class attention please! Eyes to the board") that immediately blocks mouse/keyboard input.
- **Dynamic Policy Synchronization:** Background Python agent synchronizes approved domain whitelists into Chromium managed enterprise policies via inotify without requiring browser restarts.
- **First-Boot Setup Wizard (`/setup`):** On freshly installed thin clients, an onboarding GUI prompts for the school subdomain and PC identifier (e.g. `PC-01`), verifies connectivity with the Cloudflare Worker, and locks down the device permanently.

### ☁️ Cloud Control Plane (Cloudflare Workers + D1)
- **Multi-Tenant SaaS Architecture:** Single-worker routing across wildcard subdomains (`*.labkiosk.io`). Complete tenant data isolation.
- **Serverless SQL (Cloudflare D1):** Relational tables for schools, admin users, sessions, student portal apps, client devices, audit logs, and command queues.
- **Native Web Crypto Authentication:** Zero-dependency PBKDF2-HMAC-SHA256 password hashing (32-byte salt, 100,000 iterations) and secure `HttpOnly` session management.
- **Student Learning Portal:** Configurable application launchpad featuring responsive cards with high-res thumbnails, category badges (Mathematics, Coding, Physics, Geometry), and single-click launch.
- **Dynamic Workstation Collection:** Real-time grid that displays only active thin clients (no fixed 40-slot limit). Features 1-click workstation decommissioning (`✕`).
- **Sub-Second Fleet Monitoring:** Ingests live screen thumbnails every 3 seconds from active workstations.
- **In-Browser Remote Desktop (noVNC):** Clicking any workstation card opens an on-demand, interactive remote control session routed securely through Cloudflare Tunnel (`x11vnc` / `websockify`).
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
|       labkiosk.io              labkiosk.io/super           greenwood.labkiosk.io      |
|    (Landing Page & ISO)      (Master Admin Console)        (Teacher Lab Dashboard)    |
|            │                           │                             │                |
|            +---------------------------+-----------------------------+                |
|                                        │                                              |
|                                        ▼                                              |
|                     [ Cloudflare Worker Router: index.ts ]                            |
|                        ├── Web Crypto PBKDF2 Authentication                           |
|                        ├── Wildcard Subdomain & Tenant Resolver                       |
|                        ├── High-Performance Memory Telemetry Cache                    |
|                        └── Cloudflare D1 Database (SQLite Engine)                     |
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
|   [ Chromium Kiosk ] ◀─────── Loaded Extension (Auto-Hiding Floating Nav Bar)         |
|         │                                                                             |
|         ├── Native Top-Level Browsing (Full Hardware Acceleration, Zero iframe blocks)|
|         └── Managed Enterprise Policies (Dynamic URLAllowlist & Blocklist)            |
|                                                                                       |
|   [ Local Python 3 Agent: agent.py ]                                                  |
|         ├── First-Boot Setup Wizard (http://127.0.0.1:8888/setup)                     |
|         ├── Heartbeat & Screen Thumbnail Streaming (every 3s)                         |
|         └── Policy Inotify Synchronization & Remote Command Dispatch                  |
|                                                                                       |
|   [ Remote Control Gateway ]                                                          |
|         └── x11vnc + websockify (Port 6080) ──▶ Cloudflare Tunnel / Direct LAN        |
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
│   │           ├── extension/          # Manifest V3 auto-hiding top bar & curtain
│   │           └── agent/              # Python 3 telemetry & command agent
│   ├── Dockerfile                      # Containerized cross-platform ISO builder
│   └── build-iso.sh                    # Linux native build script
│
├── cloudflare-control/                 # Cloudflare Workers multi-tenant control plane
│   ├── migrations/                     # Cloudflare D1 SQL schema migrations
│   ├── src/
│   │   ├── index.ts                    # Worker router & REST API
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
- **Super Admin Console:** `http://localhost:8787/super` *(Default credentials: `admin@labkiosk.io` / `SuperAdmin2026!`)*

### 3. Launch Docker Client Simulator
You can simulate a live thin client without needing physical hardware:
```bash
# From repository root
docker compose up -d
```
- **In-Browser Workstation Display:** Open [http://localhost:6080/vnc.html](http://localhost:6080/vnc.html)
- **First-Boot Setup Wizard:** Open [http://localhost:8888/setup](http://localhost:8888/setup)
- Workstation `PC-01` will immediately appear on the teacher dashboard at `http://localhost:8787/admin?tenant=demo`.

---

## 💿 Building the Kiosk ISO

### Method 1: Using Docker (Windows, macOS, Linux)
No Linux installation required:
```bash
cd distro-builder
docker build -t labkiosk-builder .
docker run --privileged --rm -v $(pwd)/out:/build/out labkiosk-builder
```
The ready-to-flash `labkiosk-debian12-amd64.iso` will be generated in `distro-builder/out/`.

### Method 2: Native Linux / WSL2
On Debian 12 or Ubuntu 22.04+:
```bash
sudo apt-get update && sudo apt-get install -y live-build debootstrap
cd distro-builder
sudo bash build-iso.sh
```

### Method 3: Flash to USB Drive
Use **Rufus** (Windows) in *DD Image mode* or **balenaEtcher** (Mac/Linux) to write the generated ISO onto any standard 2 GB+ USB drive. Insert the USB drive into your Thin Client and boot via BIOS/UEFI.

---

## 🧪 Automated Testing

The control plane includes comprehensive automated integration tests covering the complete multi-tenant lifecycle:
```bash
pnpm --prefix cloudflare-control test
```
```text
▶ Multi-Tenant Lab Kiosk SaaS Platform
  ✔ Serves Public SaaS Landing Page on root /
  ✔ Registers new school admin and claims subdomain
  ✔ Logs in as Super Admin and accesses Super Admin Console on /super
  ✔ Serves Student Learning Portal on school subdomain /
  ✔ Adds and deletes a custom app card in Student Portal
  ✔ Serves School Teacher Dashboard on /admin for logged-in school admin
  ✔ Ingests client telemetry scoped to tenant and dispatches commands
  ✔ Responds to first-boot setup wizard status probe on /api/status
✔ Multi-Tenant Lab Kiosk SaaS Platform (8 tests, 0 failures)
```

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
