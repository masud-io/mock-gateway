#!/usr/bin/env bash
# Production-style run: build, then serve on http://127.0.0.1:3000.
# Usage: [HOST=0.0.0.0] ./scripts/mac/start.sh [--skip-build]
set -euo pipefail
cd "$(dirname "$0")/../.."

# HOST=0.0.0.0 makes the app reachable from other machines on your network (default: this Mac only).
# WARNING: the admin UI has no login, so anyone who can reach the port can edit everything.
HOST="${HOST:-127.0.0.1}"
if [ "$HOST" != "127.0.0.1" ]; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  echo "Listening on $HOST. Team URL: http://${LAN_IP:-<this Mac's IP>}:3000"
fi

[ -d node_modules ] || { echo "Dependencies missing: run ./scripts/mac/setup.sh first" >&2; exit 1; }
[ -d .data/pg ] || npm run db:migrate

[ "${1:-}" = "--skip-build" ] || npm run build
exec npx next start -H "$HOST"
