#!/usr/bin/env bash
# Start ngrok tunnel for ENiGMA's web server.
# After it starts, copy the Forwarding URL and update config/config.hjson.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/bin/ngrok"
CFG="$SCRIPT_DIR/enigma.yml"

if [[ ! -x "$BIN" ]]; then
    echo "ERROR: ngrok binary not found at $BIN"
    exit 1
fi

if grep -q 'authtoken: ""' "$CFG" || ! grep -q 'authtoken:' "$CFG"; then
    echo "ERROR: set your authtoken in $CFG first"
    echo "  Get it from: https://dashboard.ngrok.com/get-started/your-authtoken"
    exit 1
fi

echo "Starting ngrok tunnel for ENiGMA web server..."
echo "Web inspector: http://localhost:4040"
echo ""
echo "When the URL appears, update config/config.hjson:"
echo "  contentServers.web.domain  →  <host>.ngrok-free.app"
echo "  contentServers.web.https.port  →  443"
echo ""

exec "$BIN" start --config "$CFG" enigma-web
