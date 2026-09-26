#!/usr/bin/env bash
set -euo pipefail

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
[[ -f dist/index.html ]] || { echo "Run npm run build first." >&2; exit 1; }
web="$repo/infra/server/web"
mkdir -p "$web"

if [[ -f "$web/branding.json" ]]; then
  # Keep this installation's admin-saved name, icon and install manifest.
  tar -C dist --exclude='./branding.json' --exclude='./branding-icon.png' \
    --exclude='./manifest.webmanifest' -cf - . | tar -C "$web" -xf -
else
  cp -a dist/. "$web/"
fi
echo "Web assets deployed to $web. Existing server branding preserved."
