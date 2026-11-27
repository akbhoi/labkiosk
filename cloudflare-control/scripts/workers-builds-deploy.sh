#!/usr/bin/env bash
# The deploy command of the labkiosk-controller Worker's Cloudflare Workers
# Builds (Worker → Settings → Build; root directory cloudflare-control). It
# replaces .github/workflows/deploy-cloudflare.yml and keeps its rules:
#
#   1. Nothing untested is deployed: both Workers are typechecked and tested
#      here, in this same build, before anything is applied. Any failure stops
#      the script (set -e) before step 2.
#   2. D1 migrations are applied before the controller is deployed; the new
#      Worker asserts the schema is current on its first request.
#   3. The email Worker is deployed after the controller: its Service Binding
#      names the controller's MailIntake entrypoint, which must already exist.
#
# The build's API token needs Workers Scripts: Edit, D1: Edit and Account
# Settings: Read (the token Workers Builds creates by itself has no D1 access).
set -euo pipefail

PNPM_PIN="10.34.9"   # the lockfiles are pnpm 10's
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
control="$(cd "$here/.." && pwd)"
email="$(cd "$control/.." && pwd)/cloudflare-email-routing"

if [ ! -f "$email/wrangler.jsonc" ]; then
  echo "workers-builds-deploy: $email/wrangler.jsonc not found; the build must check out the whole repository" >&2
  exit 1
fi

pnpm() { npx --yes "pnpm@$PNPM_PIN" "$@"; }

check() {
  echo "=== Check $(basename "$1")"
  pnpm --dir "$1" install --frozen-lockfile
  pnpm --dir "$1" run typecheck
  pnpm --dir "$1" test
}

check "$control"
check "$email"

echo "=== Apply remote D1 migrations"
pnpm --dir "$control" exec wrangler d1 migrations apply labkiosk-db --remote

echo "=== Deploy labkiosk-controller"
pnpm --dir "$control" exec wrangler deploy

echo "=== Deploy labkiosk-email-routing"
pnpm --dir "$email" exec wrangler deploy
