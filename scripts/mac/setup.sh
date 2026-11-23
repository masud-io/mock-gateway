#!/usr/bin/env bash
# One-time setup on macOS: checks Node, installs dependencies, creates the embedded database.
# Usage: ./scripts/mac/setup.sh [--seed]     (--seed adds the demo data: acme / checkout / payments)
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it first, e.g.:  brew install node" >&2
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
  echo "Node 20 or newer is required (found $(node -v)). Try:  brew upgrade node" >&2
  exit 1
fi

echo "==> Installing dependencies"
npm install

echo "==> Creating the embedded database (.data/pg)"
npm run db:migrate

if [ "${1:-}" = "--seed" ]; then
  echo "==> Seeding demo data"
  npm run db:seed
fi

echo
echo "Done. Start the app with:  ./scripts/mac/dev.sh   (then open http://127.0.0.1:3000)"
