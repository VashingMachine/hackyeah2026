#!/usr/bin/env bash
# Throwaway server on a copy of the demo workspace (for manual runs and the e2e script).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -gt 0 ]]; then
  D="$1"
  if [[ -e "$D" ]]; then
    echo "Refusing to replace existing directory: $D. Choose a new demo directory." >&2
    exit 2
  fi
  mkdir -p "$D"
else
  D="$(mktemp -d /tmp/blackwall-dev.XXXXXX)"
fi
cp -r demo-workspace "$D/ws"
echo "[blackwall] demo data: $D"
printf 'DB_PASSWORD=hunter2hunter2hunter2\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n' > "$D/ws/project/.env"
export WORKSPACE="$D/ws" BLACKWALL_DB="$D/bw.sqlite" PORT="${PORT:-8787}"
exec node src/server/main.ts
