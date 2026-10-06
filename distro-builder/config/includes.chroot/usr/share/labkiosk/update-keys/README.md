# Release-signing keys for over-the-air updates

`labkiosk-update` downloads a system image only when its `manifest.json` carries a valid
signature by one of the public keys in this folder (`docs/OTA_UPDATES.md` section 5.3). It
checks with `gpgv`, against these files and nothing else.

The folder holds two keys, and the ISO build fails without both:

| File | What it is |
|---|---|
| `current.gpg` | The key `build-iso.yml` signs releases with today. |
| `next.gpg` | The rotation key: kept offline, unused, so that releases can move to it without stranding a workstation that only knows `current.gpg`. |

Each file is a **binary public key**, as `gpg --export` writes it. Never put a secret key, or
an armored (`-----BEGIN PGP`) export, in this folder: it is copied into every image.

## Making the keys

Run this on a machine you trust, not on a build runner. Both keys sign only and never expire;
rotation is a deliberate act, not a date.

```bash
export GNUPGHOME="$(mktemp -d)"
gpg --quick-gen-key "Lab Kiosk release key 1" ed25519 sign never
gpg --quick-gen-key "Lab Kiosk release key 2" ed25519 sign never
gpg --list-keys --with-colons | awk -F: '$1 == "fpr" { print $10 }'   # two fingerprints: KEY1, KEY2

gpg --export KEY1 > distro-builder/config/includes.chroot/usr/share/labkiosk/update-keys/current.gpg
gpg --export KEY2 > distro-builder/config/includes.chroot/usr/share/labkiosk/update-keys/next.gpg
gpg --armor --export-secret-keys KEY1 > release-key-1.asc   # becomes the UPDATE_SIGNING_KEY secret
gpg --armor --export-secret-keys KEY2 > release-key-2.asc   # store offline; needed only to rotate
```

Then, in the repository's **Settings → Secrets and variables → Actions**:

- secret `UPDATE_SIGNING_KEY`: the contents of `release-key-1.asc`;
- secret `UPDATE_SIGNING_PASSPHRASE`: its passphrase, if you gave it one.

Keep `release-key-2.asc` offline (a password manager or an encrypted USB stick), delete both
`.asc` files and the temporary `GNUPGHOME` from the machine, and commit the two `.gpg` files.

`build-iso.yml` checks every release signature against these files before it uploads
anything, so a secret that does not match `current.gpg` stops the release.

## Rotating

1. Set `UPDATE_SIGNING_KEY` to the `next.gpg` key's secret key.
2. Make a new rotation key; `next.gpg` becomes `current.gpg`, the new key becomes `next.gpg`.
3. Release. Workstations still on the old image already trust the key that signed it.
