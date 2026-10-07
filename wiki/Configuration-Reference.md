# Configuration Reference

Every knob, where it is set, and what happens if it is wrong.

---

## Control plane

### Secrets — `wrangler secret put`

| Secret | Required | Effect if unset |
| :--- | :--- | :--- |
| `SUPER_ADMIN_EMAIL` | **Yes**, with a D1 binding | The worker refuses to serve |
| `SUPER_ADMIN_PASSWORD` | **Yes**, with a D1 binding | The worker refuses to serve |
| `CF_API_TOKEN` | For custom domains | Approving a custom domain cannot create its Cloudflare for SaaS custom hostname. An API token for the platform zone with **Zone · SSL and Certificates · Edit**. |
| `CF_ZONE_ID` | For custom domains | As above. The zone id of the platform domain (zone **Overview** → *API* → *Zone ID*). |
| `GITHUB_ISSUES_TOKEN` | No | Automatic bug reports stay unavailable to every organization. A fine-grained token for the one repository in `GITHUB_ISSUES_REPO` with **Issues: Read and write** (and **Pull requests: Read** for a private repository). |

There is no default super admin in a production path. Changing `SUPER_ADMIN_EMAIL` migrates the account to the new address; rotate the password from inside `/super` instead, since that path verifies the current password and revokes the account's other sessions.

### Environment variables — Cloudflare dashboard

| Variable | Example | Purpose |
| :--- | :--- | :--- |
| `DEFAULT_DOMAIN` | `labkiosk.yourdomain.com` | Platform apex. Only a host *under* this is treated as an organization subdomain. |
| `ISO_DOWNLOAD_URL` | a GitHub Releases asset URL | Target of `/download` and `/iso` |
| `DEFAULT_HOMEPAGE` | `https://labkiosk.yourdomain.com` | Fallback for non-enrolled clients |
| `GITHUB_ISSUES_REPO` | `owner/repo` | Repository automatic bug reports are filed in. Unset or malformed: the option stays unavailable. |
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
  "triggers": { "crons": ["0 * * * *"] },
  "ai": { "binding": "AI" }
}
```

Both routes are needed: the apex for the landing page and `/super`, the wildcard for every organization.

The `AI` binding (Workers AI, model `@cf/openai/gpt-oss-120b`) is used only by automatic bug reports and needs no token. `pnpm dev` runs `wrangler dev --local`, which leaves it out; plain `npx wrangler dev` calls your account and needs `wrangler login`. The option is offered to organizations only when `AI`, `GITHUB_ISSUES_TOKEN` and `GITHUB_ISSUES_REPO` are all set.

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

These can be neither registered nor resolved as an organization. Add to the set **before** you start using a hostname for platform purposes, not after.

### Recognised development hosts

`DEV_HOSTS` in `src/guard.ts`: `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, `host.docker.internal`, `host.containers.internal`.

On these hosts only, `?tenant=` and `X-Tenant` override the `Host` header.

---

## Per-organization settings

Configured by an organization admin in the dashboard; stored on the `tenants` row.

| Setting | Column | Notes |
| :--- | :--- | :--- |
| Mode | `mode` | `portal` or `single_url` |
| Single-site URL | `default_url` | Used in `single_url` mode |
| Enrollment key | `enrollment_key` | **Empty by default** — generate one before enrolling anything |
| Default lock message | `default_lock_message` | Used when a lock command carries no message |
| Portal title / subtitle / description / footer | `portal_*` | User Portal copy |
| Custom domain | `custom_domain` | Requires super-admin approval; unique across the platform |
| Allowlist | `tenant_whitelist` rows | Unioned with every portal app's host |
| Broadcast presets | `broadcast_presets` rows | One-click shortcuts |
| Automatic bug reports | `bug_reports_enabled`, `bug_reports_terms_version`, `bug_reports_terms_accepted_at` | Off by default. Sent only while the accepted terms version is the current `BUG_REPORT_TERMS_VERSION` |

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
  "host": "proxy.organization.internal",
  "port": 8080,
  "bypass": "localhost, 127.0.0.1, *.organization.internal"
}
```

Configured in Step 1 of the setup wizard or via `POST /api/network/configure`. Applied to the agent's own environment (`http_proxy`, `https_proxy`, `no_proxy`) and merged into Chromium managed policies as `ProxySettings` (`ProxyMode: "fixed_servers"`). Nothing is written to `/etc/environment`.

### `/etc/labkiosk/system-connections/` — mode `0700`

Contains NetworkManager connection keyfiles (`mode 0600`, owned by `root:root`).
On installed disks, this directory is hosted on the persistent `LABKIOSK_DATA` partition and bind-mounted to `/etc/NetworkManager/system-connections` by a mount unit the image ships (`etc-NetworkManager-system-connections.mount`, `bind,nofail`, only with `labkiosk.installed=1`). It requires `etc-labkiosk.mount`, which `labkiosk-data-generator` creates from the `labkiosk.data=<uuid>` kernel argument; no `/etc/fstab` is written.

This guarantees Wi-Fi credentials and static IP configurations persist across reboots, which otherwise discard the RAM overlay.

### `/etc/localtime` and `/etc/timezone`

```text
Asia/Kolkata
```

IST on the live session, on installed workstations, in the simulator container and in the ISO
builder image. An installed disk keeps what the build wrote; a **live** session is re-configured on
every boot by live-config's `0070-tzdata`, which falls back to `Etc/UTC` unless the kernel command
line carries `timezone=Asia/Kolkata` — so both boot menus and both `--bootappend-*` lines set it.
`systemd-timesyncd` keeps the clock itself in step.

### `/etc/labkiosk/localization.json`

```json
{
  "timezone": "Asia/Kolkata",
  "locale": "en_IN.UTF-8",
  "uiLanguage": "en-US",
  "keymap": "in",
  "keymapVariant": "",
  "syncTime": true
}
```

Written by the wizard's **Language & Region** step, which runs before the network because NTP is
not reachable yet. It lives on `LABKIOSK_DATA`, the installer carries it onto the target disk, and
the agent re-applies it at every start.

### `/etc/labkiosk/i18n/<tag>.json` — interface catalogs

`en-US` ships in the image at `/opt/labkiosk/i18n/en-US.json` and is the source language. To add
another, copy it, translate the values and place it here:

```json
{
  "_meta": { "name": "हिन्दी", "direction": "ltr" },
  "ui.workstation-enrollment-key": "…",
  "bar.home": "…"
}
```

Keys that are missing or empty fall back to the English already in the page, so a partial
translation is safe to ship. `_meta.direction: "rtl"` flips the layout. Values are inserted as
text, never as markup.

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

### Agent constants

| Constant | Value | Meaning |
| :--- | :--- | :--- |
| `LOCAL_API_PORT` | `8888` | Loopback API port |
| `MAX_THUMBNAIL_BYTES` | `256 * 1024` | Oversized frames are dropped, not shrunk |
| `MAX_BACKOFF_SECONDS` | `60` | Ceiling on telemetry retry back-off |
| `CLIENT_ID_PATTERN` | `^[A-Z0-9][A-Z0-9_-]{0,62}\Z` | |
| `TARGET_DISK_PATTERN` | `^/dev/(sd[a-z]\|vd[a-z]\|nvme[0-9]+n[0-9]+\|mmcblk[0-9]+)\Z` | |
| `GRUB_PBKDF2_PATTERN` | `^grub\.pbkdf2\.sha512\.[0-9]+\.[0-9A-Fa-f]+\.[0-9A-Fa-f]+\Z` | |

### `/etc/overlayroot.conf`

```ini
overlayroot="tmpfs:recurse=0"
```

What provides the RAM overlay today is **live-boot**: the ISO and the installed `grub.cfg` (`usr/share/labkiosk/boot/grub.cfg`) both boot with `boot=live`, which mounts the read-only `filesystem.squashfs` under a `tmpfs` upper layer. The image still ships the `overlayroot` package and this file, and both command lines also pass `overlayroot=tmpfs:recurse=0`, so whichever reads it gets the same value.

`recurse=0` has to be part of the value. overlayroot reads only the `overlayroot` and
`overlayroot_cfgdisk` variables from this file, so a separate `overlayroot_options=` line
does nothing and leaves `recurse` at its default of `1` — which overlays **every** fstab
entry with a RAM upper layer, `LABKIOSK_DATA` included, and quietly loses every enrolment
at reboot.

Changing this defeats the project's core guarantee. Do not.

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
| `LABKIOSK_DOMAIN` | `labkiosk.org` |
| `VNC_PASSWORD` | random per container |

---

## Ports

| Port | Bound to | Service |
| :--- | :--- | :--- |
| `8888` | `127.0.0.1` | Agent loopback API — **always** loopback, simulator included |
| `5900` | `localhost` | x11vnc; Remote Control reaches it through the agent and the console's relay |
| `6080` | Simulator only: `0.0.0.0` inside the container, published on the host's `127.0.0.1` | websockify / noVNC, to watch the simulated screen (the real image has neither) |
| `8787` | localhost | `wrangler dev` |

---

## CI secrets

| Secret | Used by | Permissions |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | `deploy-cloudflare.yml` | `Workers Scripts: Edit`, `D1: Edit`, `Account Settings: Read` |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-cloudflare.yml` | From the dashboard sidebar |
| `GITHUB_TOKEN` | `docker-publish.yml` | Provided automatically; needs `packages: write` |

→ [Production Deployment](Production-Deployment) · [Building the ISO](Building-the-ISO) · [Troubleshooting](Troubleshooting)
