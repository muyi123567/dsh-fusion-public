#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
pnpm install --frozen-lockfile
if [ -d packages/plugin/dist ]; then
  backup=".dsh-fusion-backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  cp -R packages/plugin/dist "$backup/"
fi
pnpm build
node scripts/doctor.mjs
