#!/usr/bin/env bash
# Production-style run: build, then serve on http://127.0.0.1:3000.
# Usage: [HOST=0.0.0.0] ./scripts/mac/start.sh [--skip-build]
set -euo pipefail
cd "$(dirname "$0")/../.."

# HOST=0.0.0.0 makes the app reachable from other machines on your network (default: this Mac only).
# The admin UI needs a login (npm run admin -- create ...); mock URLs under /mock stay open to anyone who can reach the port.
HOST="${HOST:-127.0.0.1}"

[ -d node_modules ] || { echo "Dependencies missing: run ./scripts/mac/setup.sh first" >&2; exit 1; }
[ -d .data/pg ] || npm run db:migrate

# Never expose the admin UI on the network before a login exists.
if [ "$HOST" != "127.0.0.1" ] && ! npm run --silent admin -- status >/dev/null 2>&1; then
  echo "Refusing to listen on $HOST: no admin account exists yet." >&2
  echo "Create one first:  npm run admin -- create you@example.com \"Your Name\"" >&2
  echo "(or start without HOST, open http://localhost:3000/login on this Mac, create it there, then restart)." >&2
  exit 1
fi
if [ "$HOST" != "127.0.0.1" ]; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  echo "Listening on $HOST. Team URL: http://${LAN_IP:-YOUR-MAC-IP}:3000"
fi

[ "${1:-}" = "--skip-build" ] || npm run build
exec npx next start -H "$HOST"
