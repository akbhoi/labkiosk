# Kiosk Hardening

Everything that stands between a curious student and a shell. Each layer assumes the others may fail, which is why there are so many of them.

---

## Layer 1 — Immutable storage

`/etc/overlayroot.conf`:

```ini
overlayroot="tmpfs"
overlayroot_options="recurse=0"
```

The real root filesystem is mounted **read-only**, with a `tmpfs` overlay on top. Every write — browser cache, agent logs, downloads, student files, session state — lands in RAM and is gone at power-off.

This holds on live media **and** on installed disks. Two consequences follow:

- **Zero flash wear.** Thin-client SSDs as small as 12 GB with limited write cycles are never written to during operation.
- **Every boot is a clean boot.** Nothing a student does survives a reboot, so there is no persistence for malware, no accumulated profile corruption, and no stale configuration.

The single exception on an installed disk is `/etc/labkiosk`, mounted from the `LABKIOSK_DATA` partition so that an enrolment survives. → [Disk Installer](Disk-Installer#why-partition-4-exists)

### `toram` is opt-in

`auto/config`'s `--bootappend-live` contains no `toram`. The default entry boots with `overlayroot=tmpfs` and reads the squashfs from the medium as it goes. The boot menu *additionally* offers **Lab Kiosk OS (Load into RAM - toram)**, which copies the whole image into RAM first — pick that when the USB stick should be removable after boot, and expect it to need more RAM than the image size.

---

## Layer 2 — No route to a shell

| Control | Where | Effect |
| :--- | :--- | :--- |
| `root` locked | `passwd -l root` | No root login by any path |
| `getty@tty1..6` masked | `systemctl mask` | Ctrl+Alt+F1…F6 reaches nothing |
| `serial-getty@` masked | `systemctl mask` | No serial console login |
| `debug-shell.service` masked | `systemctl mask` | No systemd emergency shell |
| `DontVTSwitch "true"` | `/etc/X11/xorg.conf.d/10-kiosk-lockdown.conf` | X refuses VT switching |
| `DontZap "true"` | same file | Ctrl+Alt+Backspace cannot kill X |
| Empty `rc.xml` keybindings | `/etc/openbox/rc.xml` | Alt+Tab, Alt+F4, Ctrl+Alt+Del are inert |
| No SSH server | package list | Nothing listens for remote login |

### Why the `kiosk` account has an *empty* password, not a locked one

`passwd -d "$KIOSK_USER"` is deliberate and must stay. A **locked** kiosk account previously deadlocked nodm's PAM stack into a black screen on boot.

What makes an empty password safe here is that **no login path exists to use it**: nodm is pinned to `NODM_USER=kiosk` and starts a session for a fixed user with no password to check, every getty is masked, and no SSH server is installed. There is no prompt anywhere that would accept it.

`kiosk` holds exactly one sudo grant — `NOPASSWD` on `/usr/local/bin/labkiosk-install`, via `/etc/sudoers.d/50-labkiosk-install` — which is what lets the setup wizard run the guided installer. There is no general sudo access.

### Polkit power policy

`/etc/polkit-1/rules.d/50-labkiosk-power.rules` grants `kiosk` reboot and power-off through logind, and nothing else. That grant is what makes the teacher's remote shutdown command work: the agent runs as `kiosk`, so without it the command would be accepted and then silently do nothing.

---

## Layer 3 — Kernel hardening

`/etc/sysctl.d/99-kiosk-lockdown.conf`:

```ini
kernel.sysrq = 0              # No magic SysRq key
kernel.dmesg_restrict = 1     # Unprivileged users cannot read the kernel ring buffer
kernel.kptr_restrict = 2      # Kernel pointers hidden from everyone
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
fs.suid_dumpable = 0
```

Core dumps are disabled outright in `/etc/security/limits.conf` (`* hard core 0`, `* soft core 0`).

---

## Layer 4 — Chromium managed policy

The browser runs `--kiosk` with a wiped profile on every launch, under an enterprise policy at `/etc/chromium/policies/managed/policies.json`.

### Deny-all, then re-permit

```json
"URLBlocklist": [
  "chrome://*", "edge://*", "about:flags", "about:version",
  "javascript://*", "view-source:*", "file://*",
  "http://*", "https://*"
]
```

Everything is denied, and the school's `URLAllowlist` re-permits exactly its own domains plus its portal apps. `view-source:` is listed explicitly because `DeveloperToolsAvailability` does not cover it and the `http`/`https` entries do not match it.

### The rest of the static policy

| Key | Value | Why |
| :--- | :--- | :--- |
| `DeveloperToolsAvailability` | `2` | DevTools disabled entirely |
| `IncognitoModeAvailability` | `1` | Incognito disabled |
| `DownloadRestrictions` | `3` | All downloads blocked |
| `AllowFileSelectionDialogs` | `false` | Without this an upload control still opens a filesystem browser over the kiosk — a file manager a student otherwise has no route to |
| `PrintingEnabled` | `false` | |
| `PasswordManagerEnabled`, `AutofillAddressEnabled`, `AutofillCreditCardEnabled` | `false` | Nothing is retained between students |
| `BrowserSignin` | `0` | No Google sign-in |
| `SyncDisabled` | `true` | |
| `DefaultSearchProviderEnabled` | `false` | An allowlisted kiosk has nowhere to search to |
| `DefaultGeolocationSetting`, `DefaultNotificationsSetting` | `2` | Deny without prompting — a kiosk has nobody to answer a permission prompt, and a modal would sit above the lock curtain |
| `HardwareAccelerationModeEnabled` | `true` | Thin clients need it |

**Audio and video capture are deliberately *not* blocked.** Language labs and video lessons legitimately need the microphone and camera; taking them away breaks real classroom use.

### One home for the policy

The static policy is declared exactly once, in `usr/share/labkiosk/chromium-policy-base.json`. Two consumers generate from it — the build hook `01-lockdown.hook.chroot`, and `sync_chromium_policies()` in `agent.py` — and neither may carry its own copy of those keys. When the keys were declared twice, anything added to one and not the other silently vanished the moment a workstation enrolled.

```bash
# CI asserts the committed generated file matches its base
python3 distro-builder/tools/generate-chromium-policy.py --check
```

Never hand-edit the generated `etc/chromium/policies/managed/policies.json`.

### Never add a blanket extension block

`ExtensionInstallBlocklist: ["*"]` makes Chromium refuse `--load-extension` altogether — silently removing the kiosk's own navigation bar and lock curtain. → [Browser Extension](Browser-Extension#do-not-add-a-blanket-extension-block)

---

## Layer 5 — In-page controls

The MV3 extension traps `F12`, `Ctrl+Shift+I/J/C`, `Ctrl+U`, `F11`, and right-click, and while the lock curtain is up it swallows every mouse, keyboard, and touch event in the capture phase. Its UI lives in a **closed** Shadow DOM so page script cannot reach it.

→ [Browser Extension](Browser-Extension)

---

## Securing the boot chain

All of the above assumes an untampered kernel invocation. Someone with physical access who can edit the GRUB command line and append `init=/bin/sh` bypasses every layer at once.

### The boot-menu password

**A workstation always boots completely unattended.** Every menu entry is marked `--unrestricted`, applied unconditionally by `02-security.hook.chroot`, so powering on goes straight to the kiosk with no prompt. The password is asked for only when someone presses `e` to edit an entry, or `c` for the GRUB shell.

> **Do not commit a hash for an image you ship to more than one customer.** A hash compiled into the ISO is one boot-menu password shared by every deployment that image produced: a leak at any single site compromises all of them, it cannot be rotated on machines already in the field, and `grub.pin` is tracked in git, so the hash is permanent in history and open to offline cracking by anyone who can read the repository.

#### Route 1 — per installation (the default)

The setup wizard collects the password at install time and derives the PBKDF2 digest in the browser. Each site, or each workstation, gets its own password, and the shipped ISO carries no secret at all. → [Disk Installer](Disk-Installer#boot-menu-password)

#### Route 2 — per-customer ISO

Supply the hash in the build environment rather than committing it. This also locks the **live USB** menu:

```bash
docker run --rm -it ghcr.io/akbhoi/labkiosk-iso-builder grub-mkpasswd-pbkdf2 -c 200000

docker run --privileged --rm \
  -e LABKIOSK_GRUB_PBKDF2="grub.pbkdf2.sha512.200000.YOUR.HASH" \
  -v "$PWD/distro-builder/out:/build/out" \
  ghcr.io/akbhoi/labkiosk-iso-builder
```

`LABKIOSK_GRUB_PBKDF2` takes precedence over `grub.pin`, which remains as a fallback for a single organisation building an image for its own lab.

#### Where each mechanism applies

| Target | Mechanism | Set by |
| :--- | :--- | :--- |
| Installed disk | `/etc/grub.d/01_labkiosk_password`, consumed by `update-grub` | The wizard, per installation (Route 1) |
| Live ISO, UEFI | `config/bootloaders/grub-pc/labkiosk-password.cfg`, sourced by `config.cfg` | `auto/config` from `LABKIOSK_GRUB_PBKDF2` or `grub.pin` (Route 2) |
| Live ISO, legacy BIOS | `ALLOWOPTIONS 0` + `NOESCAPE 1` in `config/bootloaders/*/stdmenu.cfg` — **no password needed**, syslinux discards any kernel argument typed at the prompt | static config, always |

With no hash supplied the build prints a note and produces an editable **live** menu — the correct default for a shipped product, because installed workstations get their password from Route 1. If a hash *is* supplied but is not a `grub.pbkdf2.sha512.` value, the build **fails** rather than shipping an image whose menu is unprotected in a way nobody noticed.

### Other boot-chain settings

```ini
GRUB_TIMEOUT=3
GRUB_CMDLINE_LINUX_DEFAULT="consoleblank=0"
GRUB_DISABLE_RECOVERY="true"
```

Recovery mode is a root shell by design and has no place on a kiosk. `consoleblank=0` — rather than `quiet loglevel=3` — is what resolved the black-screen boot deadlock; suppressing boot logs made a PAM autologin failure invisible.

### BIOS / UEFI firmware

Software cannot defend against someone who can simply boot something else. After installing:

1. Set a strong Supervisor/Administrator password in the workstation firmware.
2. Set internal storage as the sole boot target.
3. Disable the boot-device menu (F12) and USB booting.

---

## Build pins fail closed

`usr/share/labkiosk/cloudflared.pin` and `grub.pin` hold values that cannot be verified from the repository — a release checksum and a password hash.

| Pin | Unset | Wrong |
| :--- | :--- | :--- |
| `cloudflared.pin` | Builds without the tunnel binary | **Build fails** |
| `grub.pin` | Builds with a loud warning, live menu editable | **Build fails** |

Never invent a value to make a build go green.

---

## What this does *not* defend against

Stated plainly, because a hardening page that claims completeness is worse than useless:

- **Physical disassembly.** Anyone who can remove the drive can read it. Nothing on it is secret except an enrolment token, which can be revoked from the dashboard in one click.
- **A network-level attacker.** The client trusts its control plane. HTTPS and the device token protect the channel; a compromised control plane can point the kiosk anywhere the allowlist permits.
- **An un-Access-protected tunnel.** `websockify` serves the full noVNC UI on the tunnel hostname. Without a Cloudflare Access policy, an 8-character RFB secret is the only thing between the internet and a live classroom desktop. → [Remote Control](Remote-Control#cloudflare-access-is-mandatory)

→ [Security Model](Security-Model) · [Disk Installer](Disk-Installer) · [Building the ISO](Building-the-ISO)
