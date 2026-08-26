#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="os-updater"
INSTALL_DIR="/opt/tinc-hub/agents/$AGENT_ID"
SERVICE_NAME="tinc-os-updater"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
    echo "❌ Bu betik root olarak calismalidir" >&2
    exit 1
fi

echo "🔧 $AGENT_ID agent kuruluyor..."
mkdir -p /var/log/tinc-hub
mkdir -p "$INSTALL_DIR"

cp "$SCRIPT_DIR/agent.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/agent.py"

if ! grep -q "OS_UPDATE_INTERVAL" /etc/tinc-hub/config.env 2>/dev/null; then
    echo "OS_UPDATE_INTERVAL=86400" >> /etc/tinc-hub/config.env
fi

cp "$SCRIPT_DIR/tinc-os-updater.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable "$SERVICE_NAME.service"

echo "✅ $AGENT_ID agent kuruldu."
