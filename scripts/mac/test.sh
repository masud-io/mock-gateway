#!/usr/bin/env bash
# Typecheck, lint and run the test suite (uses a temporary database, safe while the app is running).
set -euo pipefail
cd "$(dirname "$0")/../.."

npx tsc --noEmit
npm run lint
npm test
