# Lab Kiosk

**An ultra-lightweight Linux kiosk operating system and a multi-tenant Cloudflare control plane, built for organization workstation fleets.**

Lab Kiosk replaces commercial kiosk software in educational organizations. It turns commodity thin clients (Intel x86_64, 4 GB RAM, 12 GB SSD) into immutable, RAM-only user workstations, and gives operators a live console with three-second screen telemetry, one-click screen locking, Broadcast, and embedded remote control.

Every organization gets its own isolated subdomain (`greenwood.labkiosk.example.edu`), its own curated User Portal, and its own Operator Lab Dashboard. Organization data never crosses a tenant boundary.

---

## Start here

| If you are… | Read |
| :--- | :--- |
| **Evaluating the project** | [Architecture Overview](Architecture-Overview) → [Quickstart](Quickstart) |
| **An organization IT admin deploying workstations** | [Installation Guide](Installation-Guide) → [Kiosk Hardening](Kiosk-Hardening) |
| **An operator using the console** | [Admin Console Guide](Admin-Console-Guide) |
| **Running the platform for many organizations** | [Production Deployment](Production-Deployment) → [Super Admin Guide](Super-Admin-Guide) |
| **Writing code or integrating** | [Development Workflow](Development-Workflow) → [REST API Reference](REST-API-Reference) |
| **Debugging something** | [Troubleshooting](Troubleshooting) |

---

## The two halves

### ☁️ Cloudflare control plane (`cloudflare-control/`)

A Cloudflare Worker with **zero runtime npm dependencies**, backed by Cloudflare D1. It serves the public landing page, the user portal, the admin console, the super-admin console, and the REST API that workstations talk to. Authentication is native Web Crypto PBKDF2; cold start stays under 10 ms.

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
| **No iframes for pages** | Approved sites enforce `X-Frame-Options`. Lab Kiosk navigates top-level and injects its chrome into a Shadow DOM instead. |

---

## Project status and licensing

Lab Kiosk is licensed under the **LabKiosk Software License (Source-Available)**: free and unrestricted for accredited schools, colleges, universities, teachers, and non-profits up to 45 computers; deployments with more than 45 computers are treated as commercial scale. A commercial license is required for for-profit resale, SaaS hosting, or MSP use. Subscribers utilizing the Cloudflare Worker platform are supported per the Subscriber License.

The project is openly co-developed with AI coding assistants — first Antigravity (Google DeepMind), later Claude Code. The rules those agents follow are checked into the repository as `AGENTS.md`, `CLAUDE.md`, and the skills under `skills/`.

→ [Development Workflow](Development-Workflow) · [Security Model](Security-Model) · [FAQ](FAQ) · [Glossary](Glossary)
