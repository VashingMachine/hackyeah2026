#!/usr/bin/env bash
# Throwaway server on a copy of the demo workspace (for manual runs and the e2e script).
set -euo pipefail
cd "$(dirname "$0")/.."
D="${1:-/tmp/blackwall-dev}"
rm -rf "$D" && mkdir -p "$D" && cp -r demo-workspace "$D/ws"
printf 'DB_PASSWORD=hunter2hunter2hunter2\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n' > "$D/ws/project/.env"
export WORKSPACE="$D/ws" BLACKWALL_DB="$D/bw.sqlite" PORT="${PORT:-8787}"
exec node src/server/main.ts
