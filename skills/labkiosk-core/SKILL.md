---
name: labkiosk-core
description: Autonomous engineering, debugging, and verification workflows for the Lab Kiosk Linux OS and Cloudflare Multi-Tenant Control Plane. Use when developing features, modifying ISO builds, troubleshooting Chromium kiosk policies, or testing multi-tenant SaaS routing. Co-developed with AI.
---

# Lab Kiosk Core Engineering Skill

This skill guides AI agents through authoring, modifying, testing, and verifying both the **Debian 12 Client Operating System** and the **Cloudflare Workers Multi-Tenant SaaS Platform**.

> **Co-Development Notice:** This skill and the underlying platform were co-developed through human-AI pair programming with Antigravity (Google DeepMind).

---

## 1. Operating Procedures

### A. Modifying Cloudflare Worker Code
1. Inspect [`cloudflare-control/src/types.ts`](file:///d:/Projects/AntigravityProjects/labkiosk/cloudflare-control/src/types.ts) before editing API contracts.
2. If altering the database schema:
   - Add statement to [`cloudflare-control/migrations/0001_initial_schema.sql`](file:///d:/Projects/AntigravityProjects/labkiosk/cloudflare-control/migrations/0001_initial_schema.sql).
   - Mirror the table/index definition in `SCHEMA_SQL` inside [`cloudflare-control/src/db.ts`](file:///d:/Projects/AntigravityProjects/labkiosk/cloudflare-control/src/db.ts).
   - Ensure all queries filter by `tenant_id`.
3. Verify type-safety:
   ```bash
   pnpm --prefix cloudflare-control exec tsc --noEmit
   ```
4. Run integration tests:
   ```bash
   pnpm --prefix cloudflare-control test
   ```

### B. Modifying Client Kiosk Agent & Extension
1. The client agent lives at [`distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py`](file:///d:/Projects/AntigravityProjects/labkiosk/distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py).
2. The browser injection extension lives at [`distro-builder/config/includes.chroot/opt/labkiosk/extension/`](file:///d:/Projects/AntigravityProjects/labkiosk/distro-builder/config/includes.chroot/opt/labkiosk/extension/).
3. The first-boot setup wizard lives at [`distro-builder/config/includes.chroot/opt/labkiosk/setup/wizard.html`](file:///d:/Projects/AntigravityProjects/labkiosk/distro-builder/config/includes.chroot/opt/labkiosk/setup/wizard.html).
4. To test changes immediately without rebuilding the ISO:
   ```bash
   # Copy into running Docker container
   docker cp distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py labkiosk-client-01:/opt/labkiosk/agent/agent.py
   docker cp distro-builder/config/includes.chroot/opt/labkiosk/extension labkiosk-client-01:/opt/labkiosk/

   # Restart Python agent
   docker exec labkiosk-client-01 pkill -f agent.py

   # Verify log output
   docker exec labkiosk-client-01 tail -n 20 /tmp/lab-agent.log
   ```

### C. Capturing Visual Screen Verification
Never claim a UI change is complete without inspecting a visual capture:
```bash
# Capture display 0 inside the container
docker exec -e DISPLAY=:0 labkiosk-client-01 scrot -o /tmp/verify.png

# Copy out to view
docker cp labkiosk-client-01:/tmp/verify.png .
```

---

## 2. Critical Edge Cases & Troubleshooting

### 1. `X-Frame-Options` and `Content-Security-Policy` Blocks
- **Symptom:** Webpage displays "www.khanacademy.org refused to connect" or blank white frame.
- **Root Cause:** Loading modern web applications inside `<iframe>` tags is blocked by modern security headers.
- **Remedy:** Always load educational applications in top-level native browser frames. Rely on the injected Chrome extension (`content.js`) for the top navigation bar and fullscreen lock curtain.

### 2. Chromium Policy Syntax Rules
- **Invalid Pattern:** `http://localhost:*` or `127.0.0.1:*` (Chromium will discard the rule with an `Invalid pattern` error).
- **Valid Pattern:** `localhost` or `127.0.0.1` or `host.containers.internal`. Omission of port matches all ports automatically.

### 3. Miniflare / D1 Multiline SQL Parsing on Windows
- **Symptom:** `D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS ... incomplete input`.
- **Root Cause:** Miniflare's `db.exec()` breaks when parsing multiline strings with Windows CRLF line endings.
- **Remedy:** Always split statements by `;`, normalize newlines with `.replace(/\r\n/g, "\n")`, and execute statements sequentially using `db.prepare(stmt).run()`.

### 4. Chromium Root Execution in Docker
- **Symptom:** `Running as root without --no-sandbox is not supported`.
- **Remedy:** Always ensure `--no-sandbox` is passed when running or executing Chromium inside containerized test environments.
