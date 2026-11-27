#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "ReproLens: Node.js 22.13+ is required." >&2
  exit 1
fi

node_version="$(node --version | sed 's/^v//')"
if [ "$(printf '%s\n' '22.13.0' "$node_version" | sort -V | head -n1)" != '22.13.0' ]; then
  echo "ReproLens: Node.js 22.13+ is required (found $node_version)." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "ReproLens: created .env; configure the model in the web console."
fi

if [ ! -f dist/cli.js ]; then
  npm run build
fi

exec npm run start:prod