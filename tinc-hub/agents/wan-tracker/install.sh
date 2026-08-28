#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="wan-tracker"
INSTALL_DIR="/opt/tinc-hub/agents/$AGENT_ID"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔧 $AGENT_ID agent kuruluyor..."

# 1. Dizin oluştur
mkdir -p "$INSTALL_DIR"

# 2. Dosyaları kopyala
cp "$SCRIPT_DIR/agent.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/agent.py"

# 3. Log dizinini garantile
mkdir -p /var/log/tinc-hub

# 4. Python bağımlılıklarını kontrol et / kur
if ! python3 -c "import requests, dotenv" 2>/dev/null; then
    echo "📦 Python bağımlılıkları kuruluyor..."
    pip3 install --quiet --break-system-packages requests python-dotenv
fi

# 5. Servisi kur
cp "$SCRIPT_DIR/tinc-hub-$AGENT_ID.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "tinc-hub-$AGENT_ID.service"

echo "✅ $AGENT_ID agent kuruldu ve başlatıldı"
echo "   Loglar: journalctl -u tinc-hub-$AGENT_ID -f"
echo "   Loglar: tail -f /var/log/tinc-hub/$AGENT_ID.log"
