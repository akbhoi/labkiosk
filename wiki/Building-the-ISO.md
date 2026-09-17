# Building the ISO

The client OS is produced by Debian `live-build`, driven either from a container (any host) or natively on a Debian/Ubuntu machine.

**Output:** `distro-builder/out/labkiosk-debian12-amd64.iso` and its `.sha256`.

---

## Method 1 — Docker (cross-platform)

Run both commands from the **repository root**:

```bash
# 1. Build the builder image. The Dockerfile COPYs the source into the image.
docker build -t ghcr.io/akbhoi/labkiosk-iso-builder distro-builder

# 2. Run live-build in a privileged container, mounting only the output directory.
docker run --privileged --rm \
  -v "$PWD/distro-builder/out:/build/out" \
  ghcr.io/akbhoi/labkiosk-iso-builder
```

### The engine must be rootful

`live-build` runs `debootstrap`, which creates device nodes with `mknod`. A **rootless** user namespace forbids that even under `--privileged`, and the build dies partway through the chroot stage.

Docker Desktop is rootful by default. If your `docker` command is served by a podman machine, switch it once:

```bash
podman machine stop && podman machine set --rootful && podman machine start
```

Verify before starting a long build:

```bash
docker run --rm --privileged debian:bookworm-slim sh -c 'mknod /tmp/n b 7 99 && echo ok'
```

> Rootful and rootless keep **separate image stores**, so images pulled before the switch will not be listed afterwards. Reverse with `podman machine set --rootful=false`.

### Step 1 is not optional when you have changed anything

The builder image **contains the source** — its Dockerfile does `COPY . /build/` rather than bind-mounting, because Windows 9P/drvfs mounts enforce `nodev`/`noexec` and would break `mknod`. Only `out/` is bind-mounted.

| Goal | What to run |
| :--- | :--- |
| Build the ISO **from your working tree** | `docker build …` first, every time you change `distro-builder/` |
| Reproduce the **published** ISO exactly as CI builds it from `main` | `docker pull ghcr.io/akbhoi/labkiosk-iso-builder:latest`, then run it |

Running a stale or pulled image silently builds an ISO from the source baked into it, and the result looks exactly like your change had no effect.

### The `.dockerignore` matters

Without it the build context carries `chroot/`, `cache/`, and every previously built ISO — over a gigabyte — and, worse, a stale `lb config`-generated `config/binary` whose `LB_BOOTAPPEND_LIVE` still contained the `quiet loglevel=3` that caused the black-screen boot deadlock.

---

## Method 2 — Native Debian / Ubuntu / WSL2

On Debian 12 (Bookworm) or Ubuntu 22.04+:

```bash
sudo apt-get update && sudo apt-get install -y live-build debootstrap

cd distro-builder
sudo bash build-iso.sh
```

---

## What goes into the image

### Package manifest

`config/package-lists/kiosk.list.chroot` is deliberately minimal:

| Group | Packages |
| :--- | :--- |
| Kernel & live boot | `linux-image-amd64`, `live-boot`, `live-config`, `live-config-systemd`, `overlayroot`, `systemd-sysv` |
| Boot & partitioning | `grub-efi-amd64-bin`, `grub-pc-bin`, `grub-common`, `grub2-common`, `efibootmgr`, `parted`, `dosfstools`, `e2fsprogs`, `rsync`, `sudo` |
| Virtualisation | `hyperv-daemons` |
| Firmware | `firmware-linux-free`, `firmware-misc-nonfree`, `firmware-realtek`, `firmware-iwlwifi` |
| X11 & desktop | `xserver-xorg-core`, `xserver-xorg-legacy`, `xserver-xorg-video-{all,fbdev,vesa}`, `xserver-xorg-input-all`, `xinit`, `x11-xserver-utils`, `nodm`, `openbox`, `xdotool`, `scrot`, `unclutter`, `alsa-utils` |
| Browser & fonts | `chromium`, `chromium-sandbox`, `fonts-dejavu`, `fonts-liberation`, `fonts-noto-core`, `fonts-noto-color-emoji` |
| Remote & network | `x11vnc`, `novnc`, `websockify`, `network-manager`, `curl`, `python3`, `ca-certificates` |

`scrot` supplies thumbnails, `xdotool` drives the browser, `alsa-utils` implements the `mute` command, and `chromium-sandbox` is present because the real image keeps Chromium's sandbox enabled — only the simulator passes `--no-sandbox`.

### Build hooks

| Hook | Does |
| :--- | :--- |
| `config/hooks/live/01-lockdown.hook.chroot` | Creates the `kiosk` user, configures nodm autologin and its PAM stack, masks every getty, writes the Xorg lockdown snippet, the polkit power rule, the sudoers rule, and generates the Chromium policy from its base |
| `config/hooks/live/02-security.hook.chroot` | sysctl hardening, disables core dumps, sets GRUB timeout and `consoleblank=0`, disables recovery mode, applies `--unrestricted` and any pinned boot password |

### Rootfs overlay

`config/includes.chroot/` is injected verbatim into the image: the agent, the extension, the wizard, the installer, `overlayroot.conf`, the Openbox config, and the `cloudflared-kiosk.service` unit.

> **Line endings.** `.gitattributes` pins every script, hook, and config in this tree to `eol=lf`, because the repository builds a Linux image. A CRLF hook dies with `$'\r': command not found`. Never write these files with a tool that translates newlines — Python's `Path.write_text` does, on Windows.

---

## Bootloaders

| Firmware | Config | Notes |
| :--- | :--- | :--- |
| Legacy BIOS | `config/bootloaders/isolinux/`, `syslinux/` | `ALLOWOPTIONS 0` + `NOESCAPE 1` in `stdmenu.cfg` means syslinux discards any kernel argument typed at the prompt — no password needed |
| UEFI | `config/bootloaders/grub-pc/` | Password applied from `LABKIOSK_GRUB_PBKDF2` or `grub.pin` when present |

The menu offers a default entry, a **Load into RAM (toram)** entry, an **Install to Hard Disk** entry, and a failsafe entry.

---

## Build pins

```text
config/includes.chroot/usr/share/labkiosk/cloudflared.pin   release tag + SHA-256
config/includes.chroot/usr/share/labkiosk/grub.pin          PBKDF2 boot-menu hash
```

| Pin | Unset | Wrong |
| :--- | :--- | :--- |
| `cloudflared.pin` | Builds without the tunnel binary | **Build fails** |
| `grub.pin` | Builds with a loud warning; live menu stays editable | **Build fails** |

Never invent a value to make a build go green. → [Kiosk Hardening](Kiosk-Hardening#build-pins-fail-closed)

---

## Pre-flight checks

Run these before packaging — CI runs them too:

```bash
PYTHONPYCACHEPREFIX=/tmp/labkiosk-pyc python3 -m py_compile \
  distro-builder/config/includes.chroot/opt/labkiosk/agent/agent.py \
  distro-builder/config/includes.chroot/usr/local/bin/labkiosk-install

node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/content.js
node --check distro-builder/config/includes.chroot/opt/labkiosk/extension/background.js

python3 distro-builder/tools/generate-chromium-policy.py --check

shellcheck -S warning \
  distro-builder/config/includes.chroot/etc/openbox/autostart \
  distro-builder/docker-build.sh \
  docker-test/entrypoint.sh
```

`PYTHONPYCACHEPREFIX` is not optional: without it `py_compile` writes `__pycache__` directories *inside* `config/includes.chroot`, and live-build copies whatever is on disk straight into the ISO.

---

## CI

`.github/workflows/build-iso.yml` builds the ISO on version tags (`v*`), frees disk space on the runner first, warns when a release build has no GRUB password pinned, verifies the checksum, uploads the artifact, and creates a GitHub Release.

`.github/workflows/ci.yml` runs on every push: both Docker images build (no push), the worker is typechecked and tested, and the client checks above all run.

---

## Flashing to USB

Minimum 2 GB.

- **Windows:** Rufus, in **DD Image mode** when prompted.
- **macOS / Linux:** balenaEtcher, or:

```bash
sudo dd if=distro-builder/out/labkiosk-debian12-amd64.iso of=/dev/sdX \
  bs=4M status=progress conv=fsync
```

Verify `/dev/sdX` carefully. `dd` will not ask twice.

→ [Installation Guide](Installation-Guide) · [Disk Installer](Disk-Installer) · [Kiosk Hardening](Kiosk-Hardening)
