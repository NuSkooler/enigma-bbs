#!/usr/bin/env bash
# Start GoToSocial dev instance.
# Run from the dev_util/gotosocial/ directory (paths in config.yaml are relative).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BIN="$SCRIPT_DIR/bin/gotosocial"
if [[ ! -x "$BIN" ]]; then
    echo "ERROR: binary not found at $BIN"
    echo "Run: curl -sL <url> | tar -xz -C bin/ gotosocial"
    exit 1
fi

mkdir -p data/storage

echo "Starting GoToSocial on http://localhost:8181"
echo "  DB:      $SCRIPT_DIR/data/gotosocial.db"
echo "  Storage: $SCRIPT_DIR/data/storage"
echo ""
echo "First time? After GTS starts, run in another terminal:"
echo "  ./create_admin.sh <username> <email>"
echo ""

exec "$BIN" --config-path config.yaml server start
