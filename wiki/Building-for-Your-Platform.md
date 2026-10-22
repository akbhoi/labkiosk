# Building for Your Platform

Lab Kiosk is built from one source tree for each processor architecture that has a definition under `distro-builder/config/arch/`. Two ship as releases:

| Architecture | Runs on | Boots with | Release ISO |
| :--- | :--- | :--- | :--- |
| `amd64` | 64-bit Intel and AMD PCs, thin clients, x86 virtual machines | UEFI (Secure Boot included) or legacy BIOS | `labkiosk-debian13-amd64.iso` |
| `arm64` | 64-bit ARM computers and virtual machines with UEFI firmware | UEFI (Secure Boot included) | `labkiosk-debian13-arm64.iso` |

Intel and AMD share the `amd64` image: one ISO carries the kernel, microcode and drivers for both.

**Raspberry Pi.** A Pi starts from its own firmware, not UEFI, so it does not boot the `arm64` ISO. Each release also has `labkiosk-debian13-raspi-arm64.img.xz`, a microSD card image of the `arm64` release for the Pi 4 Model B, Pi 400 and Compute Module 4; `distro-builder/tools/labkiosk-raspi.py` makes it from any `arm64` ISO, your own included ([Raspberry Pi](Raspberry-Pi)). The Pi 5 is not supported: Debian 13's kernel does not drive it.

Everything below builds on **Debian 13 (trixie)**. A build always produces an image for the architecture of the machine (or container) it runs on.

---

## Build on a machine of the target architecture

This is the fast and tested path: CI builds each release this way, `amd64` on an x86 runner and `arm64` on an ARM runner.

### With Docker (any host OS)

From the repository root, on a machine of the architecture you want:

```bash
docker build -t labkiosk-iso-builder distro-builder
docker run --privileged --rm -v "$PWD/distro-builder/out:/build/out" labkiosk-iso-builder
```

Output: `distro-builder/out/labkiosk-debian13-<arch>.iso` and its `.sha256`. The engine must be **rootful**; [Building the ISO](Building-the-ISO#the-engine-must-be-rootful) has the check and the podman switch.

On an Apple Silicon Mac this builds the `arm64` image; on an Intel Mac or a PC, the `amd64` one.

### Natively on Debian 13

```bash
cd distro-builder
sudo bash build-iso.sh
```

`build-iso.sh` installs live-build and the boot loader tools of this machine's architecture, builds, writes the checksum, and prints a QEMU command to try the result. It warns on a host that is not Debian 13: the live-build of older releases may not know trixie. Use the container there.

---

## Build for another architecture (emulated)

Docker can run a container of another architecture through QEMU user-mode emulation. This is **not tested by the project** and is many times slower than a native build (expect hours instead of minutes): use it when you have no machine of the target architecture.

```bash
# Once per boot of the host: register QEMU for foreign binaries.
docker run --privileged --rm tonistiigi/binfmt --install arm64

docker buildx build --platform linux/arm64 --load -t labkiosk-iso-builder:arm64 distro-builder
docker run --platform linux/arm64 --privileged --rm \
  -v "$PWD/distro-builder/out:/build/out" labkiosk-iso-builder:arm64
```

Swap `arm64` for the target. The architecture still comes from the container (`dpkg --print-architecture`), so the image matches the `--platform` you chose. Setting `LABKIOSK_ARCH` without emulation does not cross-build: live-build would try to run the target's binaries inside the chroot.

---

## Test the image in QEMU

The ISO's own smoke test boots its kernel and checks that the agent answers and Chromium runs, on either architecture:

```bash
sudo apt-get install -y qemu-system-x86 qemu-system-arm xorriso
sudo distro-builder/tests/vm/live-smoke-test.sh distro-builder/out/labkiosk-debian13-arm64.iso
```

It uses KVM when the host matches the image, and emulation otherwise (`SMOKE_TIMEOUT`, 1800 s by default, bounds it). It does not test the boot loader; to see the whole boot, start the ISO under UEFI firmware:

```bash
# amd64 (OVMF; drop -bios for legacy BIOS)
qemu-system-x86_64 -enable-kvm -m 3072 -bios /usr/share/ovmf/OVMF.fd \
  -cdrom distro-builder/out/labkiosk-debian13-amd64.iso

# arm64 (AAVMF, from qemu-efi-aarch64; on a non-ARM host drop -enable-kvm and use -cpu max)
qemu-system-aarch64 -M virt -enable-kvm -cpu host -m 3072 \
  -bios /usr/share/AAVMF/AAVMF_CODE.fd \
  -device virtio-gpu-pci -device qemu-xhci -device usb-kbd -device usb-tablet \
  -cdrom distro-builder/out/labkiosk-debian13-arm64.iso
```

On `amd64`, `distro-builder/tests/vm/boot-test.sh` goes further: it installs the image onto a virtual disk and proves one-try boot, rollback and over-the-air updates ([Testing Guide](Testing-Guide#boot-test-of-the-installed-disk)).

---

## Add an architecture

An architecture is a folder, `distro-builder/config/arch/<arch>/`, named as Debian names it (`dpkg --print-architecture`), with two files. `auto/config` refuses a build for any architecture that lacks either.

| File | Holds |
| :--- | :--- |
| `packages.list.chroot` | What only this architecture installs: its kernel (`linux-image-<flavour>`), its GRUB packages (`grub-efi-<arch>-bin`, and `shim-signed` with `grub-efi-<arch>-signed` where Debian signs them), microcode and firmware specific to it. `auto/config` copies it next to the shared `config/package-lists/kiosk.list.chroot`. |
| `bootloaders` | live-build's `--bootloaders` value on one line: `grub-efi` for UEFI only, `grub-efi,syslinux` to add legacy BIOS. |

Then, in order:

1. **Check every shared package exists for it.** The shared list names Chromium, Xorg, firmware and the rest. Each must be built for the new architecture in trixie: look each up on [packages.debian.org](https://packages.debian.org/trixie/). Chromium is the usual blocker.
2. **Boot loader tools in the builder.** The `Dockerfile` and `build-iso.sh` install the build host's GRUB tools by architecture (a `case` on `dpkg --print-architecture`). Add the new one to both.
3. **The disk installer.** `labkiosk-install` maps the kernel's machine name (`uname -m`) to GRUB's EFI target and the shim's file name in `EFI_PLATFORMS`; it refuses to install on a machine missing from it. Add the pair: GRUB's target (such as `riscv64-efi`) and the EFI file the firmware should start.
4. **Network boot.** `distro-builder/tools/labkiosk-netboot.py` serves the shim and network GRUB per architecture from `PLATFORMS`; add the paths inside the image, or leave network boot to the architectures it knows.
5. **Build and smoke-test it** on a machine of that architecture, as above. `live-smoke-test.sh` picks QEMU by the ISO's name; add a branch for the new suffix.

To **release** it as well (signed over-the-air updates, the download page), the CI and the controller take one more step each: a runner for it in `build-iso.yml`'s matrix and in `RUNNERS` of `distro-builder/tools/security-rebuild.py`, and its ISO read in `cloudflare-control/src/release_notes.ts`. Workstations of an architecture are offered only releases built for it: each release's other architectures sit in `releases/<version>/<arch>/` in R2, and the updater refuses a manifest of another architecture.

### Notes per architecture

| Architecture | Status |
| :--- | :--- |
| `riscv64` | An official Debian 13 architecture. Check that Chromium and a signed shim exist for it before planning on Chromium or Secure Boot. Not built or tested by the project. |
| `ppc64el`, `s390x` | Servers without a desktop GPU or UEFI: not a kiosk target. |
| `i386`, `armhf`, `armel` | 32-bit: not supported. Debian 13 no longer ships an `i386` kernel or installer at all. |

---

## Customise without forking

Many site-specific changes need no new architecture:

- **Boot-menu password** baked into the live ISO: `-e LABKIOSK_GRUB_PBKDF2="grub.pbkdf2.sha512..."` on `docker run` ([Kiosk Hardening](Kiosk-Hardening)).
- **Extra firmware or drivers**: add the Debian package to `config/arch/<arch>/packages.list.chroot` (or to the shared list when every architecture has it). The image installs only what the lists name.
- **Release signing keys** of your own: `config/includes.chroot/usr/share/labkiosk/update-keys/` ([distro-builder README](https://github.com/akbhoi/labkiosk/blob/main/distro-builder/README.md#-over-the-air-releases)). An image built with your keys takes only updates you sign.

→ [Building the ISO](Building-the-ISO) · [Installation Guide](Installation-Guide) · [Network Boot](Network-Boot)
