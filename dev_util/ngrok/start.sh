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

LOCAL_CFG="$SCRIPT_DIR/enigma.local.yml"  # gitignored; holds agent.authtoken

CFG_ARGS=(--config "$CFG")
if [[ -f "$LOCAL_CFG" ]]; then
    CFG_ARGS+=(--config "$LOCAL_CFG")
elif [[ -z "${NGROK_AUTHTOKEN:-}" ]]; then
    echo "ERROR: no ngrok authtoken; export NGROK_AUTHTOKEN or create $LOCAL_CFG:"
    echo "  agent:"
    echo "      authtoken: '<your token>'"
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

exec "$BIN" start "${CFG_ARGS[@]}" enigma-web
