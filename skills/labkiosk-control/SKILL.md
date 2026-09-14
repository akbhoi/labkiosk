---
name: labkiosk-control
description: Engineering, debugging, and verification procedures for the LabKiosk Cloudflare Workers Control Plane (Edge SaaS), Cloudflare D1 SQL database, native Web Crypto PBKDF2 authentication, multi-tenant authorization guards, nonce CSP, and automated unit/integration test suite. Use when modifying worker routes, database migrations, security guards, teacher dashboard UI, student portal, or super admin console.
---

# Lab Kiosk Cloudflare Control Plane Engineering Skill

This skill guides AI coding assistants through authoring, modifying, testing, and verifying the **Cloudflare Workers Multi-Tenant SaaS Platform**, Cloudflare D1 database, and web user interfaces.

> **Architecture Reference:** Read [`cloudflare-control/AGENTS.md`](../../cloudflare-control/AGENTS.md) before making architectural changes.

---

## 1. Operating Procedures

### A. Modifying Routes & Endpoints
1. Inspect `cloudflare-control/src/types.ts` before editing API contracts.
2. **Mandatory Guarding:**
   - Every route that accesses tenant data MUST call `resolveTenant()` and `requireTenantAdmin()` from `src/guard.ts`.
   - Every platform administrative route MUST call `requireSuperAdmin()`.
   - Device routes (`/api/telemetry`) MUST call `requireDevice()`.
   - Cookie-authenticated mutations (`POST`/`DELETE`) MUST pass `rejectCrossSiteMutation()`.
3. **Never Use Module Memory for Consensus:**
   - State that multiple edge isolates or requests must agree on (e.g. active broadcast URL, workstation remote passwords) MUST reside in D1.

### B. Modifying the Database Schema
1. **The Schema Has Two Homes:**
   - Add a **new** numbered migration file under `cloudflare-control/migrations/` (e.g. `0006_feature.sql`). Never edit an applied migration.
   - Update `SCHEMA_SQL` inside `cloudflare-control/src/db.ts` to mirror the new tables or columns.
   - Ensure all queries filter by `tenant_id`.

### C. Modifying UI Templates (`ui*.ts`)
1. **CSP Nonce Requirement:** Every `<script>` tag MUST include `nonce="${escapeAttr(nonce)}"`.
2. **Zero Inline Event Handlers:** Do not use `onclick=`, `onsubmit=`, `onchange=`, etc. Use `data-action` attributes with a delegated event listener, or `addEventListener`.
3. **Escaping Rule:**
   - Server-side: All dynamic variables MUST be escaped via `escapeHtml()` or `escapeJson()` from `src/escape.ts`.
   - Client-side: Construct DOM elements and assign `textContent`. Never concatenate values into `innerHTML`.
   - URLs: Validate and sanitize via `safeHttpUrl()`.

---

## 2. Automated Verification & Testing

Always execute these commands in order before submitting code changes:

### 1. TypeScript Strict Typecheck
```bash
pnpm --prefix cloudflare-control run typecheck
```
*Expected result:* Exit code 0, zero errors. Typechecks both `src/` (Workers runtime) and `test/` (Node runtime).

### 2. Automated Multi-Tenant & Security Tests
```bash
pnpm --prefix cloudflare-control test
```
*Expected result:* All unit and integration tests passing.

**Testing Mandatory Rule:** When adding any route, you MUST add corresponding negative tests (unauthenticated access, cross-tenant tampering, invalid input).

### 3. Running Local Development Server
```bash
cd cloudflare-control
cp .dev.vars.example .dev.vars   # One-time setup: configure local secrets
pnpm dev                        # predev applies migrations to local D1
```
