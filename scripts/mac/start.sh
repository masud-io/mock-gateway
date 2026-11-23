#!/usr/bin/env bash
# Production-style run: build, then serve on http://127.0.0.1:3000.
# Usage: ./scripts/mac/start.sh [--skip-build]
set -euo pipefail
cd "$(dirname "$0")/../.."

[ -d node_modules ] || { echo "Dependencies missing: run ./scripts/mac/setup.sh first" >&2; exit 1; }
[ -d .data/pg ] || npm run db:migrate

[ "${1:-}" = "--skip-build" ] || npm run build
exec npm start
