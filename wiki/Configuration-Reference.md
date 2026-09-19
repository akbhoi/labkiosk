# Configuration Reference

Every knob, where it is set, and what happens if it is wrong.

---

## Control plane

### Secrets — `wrangler secret put`

| Secret | Required | Effect if unset |
| :--- | :--- | :--- |
| `SUPER_ADMIN_EMAIL` | **Yes**, with a D1 binding | The worker refuses to serve |
| `SUPER_ADMIN_PASSWORD` | **Yes**, with a D1 binding | The worker refuses to serve |

There is no default super admin in a production path. Changing `SUPER_ADMIN_EMAIL` migrates the account to the new address; rotate the password from inside `/super` instead, since that path verifies the current password and revokes the account's other sessions.

### Environment variables — Cloudflare dashboard

| Variable | Example | Purpose |
| :--- | :--- | :--- |
| `DEFAULT_DOMAIN` | `labkiosk.yourdomain.com` | Platform apex. Only a host *under* this is treated as a school subdomain. |
| `ISO_DOWNLOAD_URL` | a GitHub Releases asset URL | Target of `/download` and `/iso` |
| `TUNNEL_DOMAIN` | `labkiosk.yourdomain.com` | Base domain for remote-assistance tunnels. Defaults to `lab.myschool.edu`. |
| `DEFAULT_HOMEPAGE` | `https://labkiosk.yourdomain.com` | Fallback for non-enrolled clients |
| `ALLOW_LOCAL_DB` | `1` | **Tests and local dev only.** Permits the in-memory database when no D1 binding exists. |

> **Never define a `vars` block in `wrangler.jsonc`.** Every `wrangler deploy` — including every CI run — overwrites whatever is configured in the Cloudflare dashboard. Manage production values in the dashboard or with `wrangler secret`; use `.dev.vars` locally.

### `wrangler.jsonc`

```jsonc
{
  "d1_databases": [
    { "binding": "DB", "database_name": "labkiosk-db",
      "database_id": "…", "migrations_dir": "migrations" }
  ],
  "routes": [
    { "pattern": "labkiosk.yourdomain.com/*",   "zone_name": "yourdomain.com" },
    { "pattern": "*.labkiosk.yourdomain.com/*", "zone_name": "yourdomain.com" }
  ],
  "triggers": { "crons": ["0 * * * *"] }
}
```

Both routes are needed: the apex for the landing page and `/super`, the wildcard for every school.

### `.dev.vars` — local only

```ini
SUPER_ADMIN_EMAIL=admin@labkiosk.local
SUPER_ADMIN_PASSWORD=LocalDevPassword123!
```

Copied from `.dev.vars.example`. Not read in production, and not committed.

### Reserved subdomains

`RESERVED_SLUGS` in `src/guard.ts`:

```text
www  super  labkiosk  api  admin  portal  status  mail  app  kiosk  root
```

These can be neither registered nor resolved as a school. Add to the set **before** you start using a hostname for platform purposes, not after.

### Recognised development hosts

`DEV_HOSTS` in `src/guard.ts`: `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, `host.docker.internal`, `host.containers.internal`.

On these hosts only, `?tenant=` and `X-Tenant` override the `Host` header.

---

## Per-school settings

Configured by a teacher admin in the dashboard; stored on the `tenants` row.

| Setting | Column | Notes |
| :--- | :--- | :--- |
| Mode | `mode` | `portal` or `single_url` |
| Single-site URL | `default_url` | Used in `single_url` mode |
| Enrollment key | `enrollment_key` | **Empty by default** — generate one before enrolling anything |
| Default lock message | `default_lock_message` | Used when a lock command carries no message |
| Portal title / subtitle / description / footer | `portal_*` | Student Portal copy |
| Custom domain | `custom_domain` | Requires super-admin approval; unique across the platform |
| Allowlist | `tenant_whitelist` rows | Unioned with every portal app's host |
| Broadcast presets | `broadcast_presets` rows | One-click shortcuts |

Rotating the enrollment key does **not** affect enrolled workstations — they hold their own device tokens.

---

## Client workstation

### `/etc/labkiosk/config.json` — mode `0600`

```json
{
  "deviceToken": "…",
  "workerUrl": "https://oakridge.labkiosk.example.edu",
  "targetUrl": "https://oakridge.labkiosk.example.edu",
  "clientId": "PC-01",
  "clientNum": 1
}
```

Written at enrolment. On live media it lives in the RAM overlay and is lost at power-off; on an installed disk, `/etc/labkiosk` is a mount point for the `LABKIOSK_DATA` partition, which is what makes enrolment persist.

### `/etc/labkiosk/proxy.json` — mode `0644`

```json
{
  "enabled": true,
  "host": "proxy.school.internal",
  "port": 8080,
  "bypass": "localhost, 127.0.0.1, *.school.internal"
}
```

Configured in Step 1 of the setup wizard or via `POST /api/network/configure`. Applied to the agent's own environment (`http_proxy`, `https_proxy`, `no_proxy`) and merged into Chromium managed policies as `ProxySettings` (`ProxyMode: "fixed_servers"`). Nothing is written to `/etc/environment`.

### `/etc/labkiosk/system-connections/` — mode `0700`

Contains NetworkManager connection keyfiles (`mode 0600`, owned by `root:root`).
On installed disks, this directory is hosted on the persistent `LABKIOSK_DATA` partition and bind-mounted to `/etc/NetworkManager/system-connections` via `/etc/fstab`:
```text
/etc/labkiosk/system-connections /etc/NetworkManager/system-connections none bind,nofail 0 0
```
This guarantees Wi-Fi credentials and static IP configurations persist across `overlayroot="tmpfs"` reboots.

### `/etc/localtime` and `/etc/timezone`

```text
Asia/Kolkata
```

IST on the live session, on installed workstations, in the simulator container and in the ISO
builder image. An installed disk keeps what the build wrote; a **live** session is re-configured on
every boot by live-config's `0070-tzdata`, which falls back to `Etc/UTC` unless the kernel command
line carries `timezone=Asia/Kolkata` — so both boot menus and both `--bootappend-*` lines set it.
`systemd-timesyncd` keeps the clock itself in step.

### `/etc/polkit-1/rules.d/50-labkiosk-network.rules`

```javascript
polkit.addRule(function(action, subject) {
    if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0 && subject.user === "kiosk") {
        return polkit.Result.YES;
    }
});
```

Permits the unprivileged `kiosk` user to control NetworkManager and create/modify network connections via `nmcli` without sudo or password prompts.

### Agent environment overrides

| Variable | Purpose |
| :--- | :--- |
| `WORKER_URL` | Control plane base URL |
| `LABKIOSK_DOMAIN` | Base platform domain shown in the wizard |
| `LABKIOSK_REMOTE_HOST` | Tunnel hostname to report, when not parsed from the cloudflared config |

### Agent constants

| Constant | Value | Meaning |
| :--- | :--- | :--- |
| `LOCAL_API_PORT` | `8888` | Loopback API port |
| `MAX_THUMBNAIL_BYTES` | `256 * 1024` | Oversized frames are dropped, not shrunk |
| `MAX_BACKOFF_SECONDS` | `60` | Ceiling on telemetry retry back-off |
| `CLIENT_ID_PATTERN` | `^[A-Z0-9][A-Z0-9_-]{0,62}$` | |
| `TARGET_DISK_PATTERN` | `^/dev/(sd[a-z]\|vd[a-z]\|nvme[0-9]+n[0-9]+\|mmcblk[0-9]+)$` | |
| `GRUB_PBKDF2_PATTERN` | `^grub\.pbkdf2\.sha512\.[0-9]+\.[0-9A-Fa-f]+\.[0-9A-Fa-f]+$` | |

### `/etc/overlayroot.conf`

```ini
overlayroot="tmpfs:recurse=0"
```

`recurse=0` has to be part of the value. overlayroot reads only the `overlayroot` and
`overlayroot_cfgdisk` variables from this file, so a separate `overlayroot_options=` line
does nothing and leaves `recurse` at its default of `1` — which overlays **every** fstab
entry with a RAM upper layer, `LABKIOSK_DATA` included, and quietly loses every enrolment
at reboot.

Changing this defeats the project's core guarantee. Do not.

### `/etc/cloudflared/config.yml`

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: pc-01.labkiosk.institution.edu
    service: http://127.0.0.1:6080
  - service: http_status:404
```

`cloudflared-kiosk.service` starts automatically when this file exists. The agent parses the first `hostname:` under `ingress:` and reports it as `remoteHost`.

### Chromium policy

Declared once in `usr/share/labkiosk/chromium-policy-base.json`; generated into `etc/chromium/policies/managed/policies.json`. **Never hand-edit the generated file.**

```bash
python3 distro-builder/tools/generate-chromium-policy.py --check
```

→ [Kiosk Hardening](Kiosk-Hardening#layer-4--chromium-managed-policy)

---

## Build-time

### Pins

| File | Holds | Unset | Wrong |
| :--- | :--- | :--- | :--- |
| `usr/share/labkiosk/cloudflared.pin` | Release tag + SHA-256 | Builds without the tunnel binary | **Build fails** |
| `usr/share/labkiosk/grub.pin` | PBKDF2 boot-menu hash | Builds with a warning; live menu editable | **Build fails** |

Never invent a value to make a build go green.

### Build environment

| Variable | Purpose |
| :--- | :--- |
| `LABKIOSK_GRUB_PBKDF2` | Per-customer boot-menu hash. Takes precedence over `grub.pin`. |

```bash
docker run --privileged --rm \
  -e LABKIOSK_GRUB_PBKDF2="grub.pbkdf2.sha512.200000.YOUR.HASH" \
  -v "$PWD/distro-builder/out:/build/out" \
  ghcr.io/akbhoi/labkiosk-iso-builder
```

### `auto/config`

Sets the kernel command line, `--bootappend-live`, distribution, and package lists. Note that it contains **no `toram`** — that is an opt-in boot menu entry, not the default.

---

## Simulator — `docker-compose.yml`

| Variable | Default |
| :--- | :--- |
| `WORKER_URL` | `http://host.docker.internal:8787` |
| `LABKIOSK_DOMAIN` | `labkiosk.akbhoi.com` |
| `VNC_PASSWORD` | random per container |
| `LABKIOSK_REMOTE_HOST` | *(empty)* |

---

## Ports

| Port | Bound to | Service |
| :--- | :--- | :--- |
| `8888` | `127.0.0.1` | Agent loopback API — **always** loopback, simulator included |
| `5900` | `localhost` | x11vnc |
| `6080` | `127.0.0.1` on the real image; `0.0.0.0` in the simulator | websockify / noVNC |
| `8787` | localhost | `wrangler dev` |

---

## CI secrets

| Secret | Used by | Permissions |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | `deploy-cloudflare.yml` | `Workers Scripts: Edit`, `D1: Edit`, `Account Settings: Read` |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-cloudflare.yml` | From the dashboard sidebar |
| `GITHUB_TOKEN` | `docker-publish.yml` | Provided automatically; needs `packages: write` |

→ [Production Deployment](Production-Deployment) · [Building the ISO](Building-the-ISO) · [Troubleshooting](Troubleshooting)
