# FAQ

---

## General

**What problem does Lab Kiosk actually solve?**
Organization workstation fleets need locked-down workstations with operator oversight. Commercial kiosk software is expensive per seat, and thin clients with 4 GB RAM and 12 GB SSDs are not what it targets. Lab Kiosk gives you an immutable RAM-only OS, a live admin console, and per-organization isolation on infrastructure that costs almost nothing to run.

**Is it free?**
Free and unrestricted for accredited public and private schools, colleges, universities, teachers, educational foundations, and personal non-commercial evaluation on up to 45 computers. Any deployment exceeding 45 computers is viewed as commercial scale and requires a commercial or subscriber license. Subscribers utilizing the Cloudflare Worker platform are supported per the Subscriber License.

**How much does the infrastructure cost?**
A Cloudflare Worker plus D1 is inexpensive at room scale, and the free tier covers evaluation comfortably. There is no per-seat cost, and no server to run on-site.

**Can I self-host without Cloudflare?**
Not as written. The control plane targets Cloudflare Workers and D1 specifically, and uses runtime primitives — `crypto.subtle`, the D1 binding, the cron trigger — that a generic Node host does not provide identically. Porting it is a real project, not a config change.

**Does it work offline?**
No. A workstation with no uplink keeps showing whatever it last loaded and backs off its heartbeat exponentially to a 60-second ceiling, recovering promptly when the link returns. But policy, commands, and the portal all come from the control plane.

---

## Hardware

**What are the minimum requirements?**
2 GB RAM and a 3 GB disk will run it. The reference target is 4 GB RAM with a 12 GB SATA SSD, on an Intel x86_64 CPU.

**Will it wear out my SSDs?**
No — that is the point. `overlayroot="tmpfs"` mounts the root filesystem read-only and diverts every write to RAM, on live media and installed disks alike. The only exception is the 512 MiB `LABKIOSK_DATA` partition, written once at enrolment.

**BIOS or UEFI?**
Both. The ISO boots via ISOLINUX on BIOS and GRUB EFI on UEFI, and the installer writes a hybrid GPT layout with three GRUB variants so the installed drive boots regardless of firmware mode.

**Can I run it from USB permanently?**
You can, but on live media the enrolment token lives in the RAM overlay and is lost at power-off, so you would re-enrol every boot. The system is designed to be installed.

**Does it need a GPU?**
No. `HardwareAccelerationModeEnabled` is on so Chromium uses whatever is available, and the package list includes `fbdev` and `vesa` drivers for machines with nothing better.

---

## Deployment

**How many workstations can one organization have?**
There is no hard limit. Each workstation is one row in `client_devices` and one heartbeat every three seconds. Storage is dominated by thumbnails — budget roughly 256 KB per workstation for the latest frame.

**Can an organization use its own domain?**
Yes. Request it in Settings, create a `CNAME` to the platform apex, and a super admin approves it. → [Super Admin Guide](Super-Admin-Guide#custom-domains)

**Do I need Cloudflare Tunnels?**
Only for interactive remote control. Thumbnails, lock, broadcast, reload, reboot, shutdown, and mute all work without one.

**How do I move a workstation to a different organization?**
Decommission it from the dashboard, clear `/etc/labkiosk/config.json`, reboot, and run the wizard with the new organization's subdomain and key.

**What happens if I rotate the enrollment key?**
Nothing to enrolled workstations — they hold their own device tokens. Rotation only stops *new* enrolments with the old key.

---

## Security

**How do I stop users booting from their own USB?**
Set a firmware password and disable USB and network booting in the BIOS/UEFI. Software cannot defend against someone who simply boots something else.

**What if a user edits the GRUB command line?**
Set a boot-menu password at install time. Every entry is marked `--unrestricted`, so normal boot never prompts; the password is asked for only for `e` (edit) or `c` (GRUB shell).

**Why isn't the boot password baked into the ISO?**
Because a compiled-in hash is one password shared by every customer that image was shipped to: unrotatable in the field, and permanent in git history where anyone who can read the repository can attack it offline.

**Can a website break out of the kiosk?**
The layers are: Chromium's deny-all allowlist, `chrome://` blocked, DevTools disabled, no downloads, no file dialogs, a closed Shadow DOM for the kiosk UI, an agent that refuses cross-origin callers, and a read-only root filesystem. A page that found a Chromium sandbox escape would still land in a RAM overlay that resets at power-off.

**Is the screen thumbnail encrypted?**
In transit, by HTTPS. At rest in D1, no. Anyone with database access can see the latest frame from every workstation. → [Security Model](Security-Model#known-limits)

**Can one organization see another organization's workstations?**
No. Every query filters by `tenant_id` and every route carries a guard; the test suite asserts an operator at one organization gets `403` for another's console, clients, and commands.

**Is the 8-character VNC password a problem?**
Yes, if it is your only control. The RFB protocol truncates passwords to 8 characters, so it is about 32 bits however you generate it. **Put a Cloudflare Access policy in front of every tunnel hostname.** → [Remote Control](Remote-Control#cloudflare-access-is-mandatory)

---

## Operation

**What happens when a user saves a file?**
It goes to `/tmp` in the RAM overlay and is gone at reboot. Downloads are blocked outright by policy (`DownloadRestrictions: 3`), and there is no file picker (`AllowFileSelectionDialogs: false`).

**Can users use the camera or microphone?**
Yes, deliberately. Language labs and video pages need them. Geolocation and notifications are denied without prompting, because a kiosk has nobody to answer a permission prompt and a modal would sit above the lock curtain.

**Can users print?**
No. `PrintingEnabled: false`.

**How quickly does an operator command take effect?**
Within one heartbeat — at most three seconds. Lock and unlock update the console's view immediately on dispatch, so the grid does not lag behind the room.

**What if a workstation stops responding?**
The agent runs under a supervisor loop that restarts it within about two seconds of any exit, and a Chromium watchdog relaunches the browser within a second. If a machine is genuinely stuck, `reboot` from the dashboard, or power-cycle it — nothing is lost.

**Where are the logs?**
`/tmp/lab-agent.log` on each workstation, in the RAM overlay. Administrative actions are in the organization's audit log in D1, which survives the tenant.

---

## Development

**Why zero npm dependencies in the worker?**
Supply-chain surface and cold start. Every primitive the control plane needs is a Web API, so there is nothing to audit and nothing to patch, and cold start stays under 10 ms.

**Why Node 22 specifically?**
The test suite uses native `node:sqlite` in `d1_adapter.ts`, which earlier versions do not have. It keeps the test database dependency-free.

**Why is the schema in two places?**
`migrations/` is what a deployed database has; `SCHEMA_SQL` is what the in-memory test adapter builds. Both must change together, and a test asserts they agree. → [Database Schema](Database-Schema#the-schema-has-two-homes)

**Can I test without hardware?**
Yes, for the agent, extension, telemetry, wizard, and everything on the control plane. Bootloaders, `overlayroot`, and the installer need a VM. → [Workstation Simulator](Workstation-Simulator)

**Why can't the content script call the agent directly?**
CORS. A content-script fetch runs in the page's origin and would need the agent to answer `Access-Control-Allow-Origin: *` — which it used to, meaning any site a user visited could talk to it. A service-worker fetch is governed by the extension's `host_permissions` instead, so the agent can refuse cross-origin callers outright.

**Is AI-authored code welcome?**
Yes, under three conditions: zero placeholders, a clean typecheck and full test run, and transparent disclosure of the model in the PR description. The project is openly co-developed with AI assistants. → [Development Workflow](Development-Workflow#ai-contributions)

---

## Troubleshooting

**The workstation shows "This page is blocked" right after enrolling.**
Chromium reads managed policy only at startup. The agent sets `pendingBrowserRestart` and restarts it after the next sync — wait a few seconds.

**My changes to `agent.py` have no effect in the simulator.**
The image bakes the client source in, so a pulled image runs `main`'s code. Use `docker compose up -d --build`, or `docker cp` the file in and restart the agent.

**The ISO build ignores my changes.**
Same cause: the builder image copies the source in. Run `docker build -t ghcr.io/akbhoi/labkiosk-iso-builder distro-builder` first, every time.

**The build dies in the chroot stage.**
Your container engine is rootless. `debootstrap` needs `mknod`, which a rootless user namespace forbids even under `--privileged`. → [Building the ISO](Building-the-ISO#the-engine-must-be-rootful)

**A dashboard button does nothing.**
Almost certainly an inline `on*=` handler blocked by the CSP. Use `data-action` with a delegated listener. The test suite is supposed to catch this before release — if it reached you, please report it.

→ [Troubleshooting](Troubleshooting) for the full catalogue.
