# Lab Kiosk

**An ultra-lightweight Linux kiosk operating system and a multi-tenant Cloudflare control plane, built for school computer labs.**

Lab Kiosk replaces commercial kiosk software in educational institutions. It turns commodity thin clients (Intel x86_64, 4 GB RAM, 12 GB SSD) into immutable, RAM-only student workstations, and gives teachers a live console with three-second screen telemetry, one-click screen locking, lesson broadcast, and embedded remote control.

Every school gets its own isolated subdomain (`greenwood.labkiosk.example.edu`), its own curated Student Learning Portal, and its own Teacher Lab Dashboard. School data never crosses a tenant boundary.

---

## Start here

| If you are… | Read |
| :--- | :--- |
| **Evaluating the project** | [Architecture Overview](Architecture-Overview) → [Quickstart](Quickstart) |
| **A school IT admin deploying workstations** | [Installation Guide](Installation-Guide) → [Kiosk Hardening](Kiosk-Hardening) |
| **A teacher using the console** | [Teacher Dashboard Guide](Teacher-Dashboard-Guide) |
| **Running the platform for many schools** | [Production Deployment](Production-Deployment) → [Super Admin Guide](Super-Admin-Guide) |
| **Writing code or integrating** | [Development Workflow](Development-Workflow) → [REST API Reference](REST-API-Reference) |
| **Debugging something** | [Troubleshooting](Troubleshooting) |

---

## The two halves

### ☁️ Cloudflare control plane (`cloudflare-control/`)

A Cloudflare Worker with **zero runtime npm dependencies**, backed by Cloudflare D1. It serves the public landing page, the student portal, the teacher dashboard, the super-admin console, and the REST API that workstations talk to. Authentication is native Web Crypto PBKDF2; cold start stays under 10 ms.

→ [Control Plane Internals](Control-Plane-Internals) · [Database Schema](Database-Schema) · [REST API Reference](REST-API-Reference)

### 🐧 Client operating system (`distro-builder/`)

A Debian 12 (Bookworm) live-build image. The root filesystem is mounted read-only with every write diverted to a `tmpfs` RAM overlay, so thin-client flash storage is never written during operation and every reboot is a clean reset. Chromium runs in `--kiosk` under managed enterprise policy, with a Manifest V3 extension supplying the navigation bar and the lock curtain.

→ [Client Agent](Client-Agent) · [Browser Extension](Browser-Extension) · [Disk Installer](Disk-Installer) · [Kiosk Hardening](Kiosk-Hardening)

---

## Design commitments

These are invariants, not preferences. Every one of them is enforced by the test suite, by CI, or by a build that fails closed.

| Commitment | What it means in practice |
| :--- | :--- |
| **Zero SSD wear** | `overlayroot="tmpfs"` on live media *and* on installed disks. The only persistent write target on an installed machine is the 512 MiB `LABKIOSK_DATA` partition holding the enrolment token. |
| **Zero npm at runtime** | The worker uses only Web APIs and Cloudflare primitives. No routing library, no auth framework, no ORM. |
| **Zero placeholders** | No `TODO` stubs, no empty `catch` blocks, no mock data in production paths. |
| **Fail closed** | Missing configuration is an error, never a weaker default. Unapplied migrations, absent super-admin secrets, and unverified build pins all refuse to proceed. |
| **Tenant isolation** | Every query touching devices, commands, sessions, or portal apps filters by `tenant_id`. Every route carries a guard. |
| **No iframes for lessons** | Educational sites enforce `X-Frame-Options`. Lab Kiosk navigates top-level and injects its chrome into a Shadow DOM instead. |

---

## Project status and licensing

Lab Kiosk is released under the **Business Source License 1.1**: free and unrestricted for schools, colleges, universities, teachers, and non-profits; a commercial licence is required for for-profit resale or MSP use. On **1 January 2030** it converts automatically to Apache License 2.0.

The project is openly co-developed with AI coding assistants — first Antigravity (Google DeepMind), later Claude Code. The rules those agents follow are checked into the repository as `AGENTS.md`, `CLAUDE.md`, and the skills under `skills/`.

→ [Development Workflow](Development-Workflow) · [Security Model](Security-Model) · [FAQ](FAQ) · [Glossary](Glossary)
