#!/usr/bin/env bash
# Create a GTS admin account. Run once after first start.sh.
# Usage: ./create_admin.sh <username> <email>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

USERNAME="${1:-}"
EMAIL="${2:-}"

if [[ -z "$USERNAME" || -z "$EMAIL" ]]; then
    echo "Usage: $0 <username> <email>"
    exit 1
fi

BIN="$SCRIPT_DIR/bin/gotosocial"

echo "Creating admin account: @${USERNAME}"
"$BIN" --config-path config.yaml admin account create \
    --username "$USERNAME" \
    --email    "$EMAIL" \
    --password "$(openssl rand -base64 16)"

echo ""
echo "Promoting to admin..."
"$BIN" --config-path config.yaml admin account promote \
    --username "$USERNAME"

echo ""
echo "Done. Reset the password via the GTS admin panel or:"
echo "  ./bin/gotosocial --config-path config.yaml admin account resetPassword --username $USERNAME"
