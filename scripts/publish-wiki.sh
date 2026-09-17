#!/usr/bin/env bash
#
# Publish wiki/*.md to this repository's GitHub wiki.
#
# GitHub wikis are a separate git repository (<repo>.wiki.git) with no REST API,
# so they can only be updated by pushing to that repo. This script clones it,
# mirrors wiki/ into it, and pushes.
#
# Prerequisites:
#   * The wiki must already exist. GitHub does not create it on first push --
#     open https://github.com/<owner>/<repo>/wiki and save any page once.
#   * Your git credentials must be able to push to <repo>.wiki.git.
#
# Usage:
#   scripts/publish-wiki.sh                 # infers the remote from origin
#   scripts/publish-wiki.sh <wiki-git-url>  # or pass it explicitly
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/wiki"

if [ ! -d "$src" ]; then
  echo "error: $src does not exist" >&2
  exit 1
fi

if [ $# -ge 1 ]; then
  wiki_url="$1"
else
  origin="$(git -C "$repo_root" remote get-url origin)"
  wiki_url="${origin%.git}.wiki.git"
fi

echo "Source:      $src"
echo "Wiki remote: $wiki_url"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if ! git clone --depth 1 "$wiki_url" "$work/wiki" 2>"$work/clone.err"; then
  cat "$work/clone.err" >&2
  echo >&2
  echo "Could not clone the wiki. If the error mentions 'not found', the wiki has" >&2
  echo "never been initialised: open the repository's Wiki tab, create any page," >&2
  echo "save it, then run this script again." >&2
  exit 1
fi

# Replace every tracked page, but keep the wiki's git metadata.
find "$work/wiki" -maxdepth 1 -name '*.md' -delete
cp "$src"/*.md "$work/wiki/"

cd "$work/wiki"
git add -A

if git diff --cached --quiet; then
  echo "Wiki is already up to date; nothing to push."
  exit 0
fi

git -c user.name="${GIT_AUTHOR_NAME:-$(git -C "$repo_root" config user.name)}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-$(git -C "$repo_root" config user.email)}" \
    commit -m "docs(wiki): sync from wiki/ in the main repository"

git push origin HEAD
echo "Published $(ls "$src"/*.md | wc -l | tr -d ' ') pages."
