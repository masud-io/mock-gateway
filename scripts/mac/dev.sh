#!/usr/bin/env bash
# Run the admin UI and mock engine in development mode (hot reload) on http://127.0.0.1:3000.
# Usage: ./scripts/mac/dev.sh [--open]
set -euo pipefail
cd "$(dirname "$0")/../.."

[ -d node_modules ] || { echo "Dependencies missing: run ./scripts/mac/setup.sh first" >&2; exit 1; }
[ -d .data/pg ] || npm run db:migrate

if [ "${1:-}" = "--open" ]; then
  # Open the browser once the server answers
  ( for _ in $(seq 1 60); do
      curl -fs -o /dev/null http://127.0.0.1:3000/ && { open http://127.0.0.1:3000; exit 0; }
      sleep 1
    done ) &
fi

exec npm run dev
