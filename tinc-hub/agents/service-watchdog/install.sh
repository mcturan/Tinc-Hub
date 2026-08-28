#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="service-watchdog"
INSTALL_DIR="/opt/tinc-hub/agents/$AGENT_ID"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔧 $AGENT_ID kurulumu başlıyor..."

# 1. Dizin oluştur
mkdir -p "$INSTALL_DIR"

# 2. Agent dosyasını kopyala
cp "$SCRIPT_DIR/agent.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/agent.py"

# 3. Log dizinini oluştur
mkdir -p /var/log/tinc-hub

# 4. Servisi kur ve başlat
cp "$SCRIPT_DIR/tinc-hub-$AGENT_ID.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "tinc-hub-$AGENT_ID.service"

echo "✅ $AGENT_ID agent kuruldu ve başlatıldı"
echo "📋 Durum: systemctl status tinc-hub-$AGENT_ID.service"
echo "📄 Loglar: tail -f /var/log/tinc-hub/$AGENT_ID.log"
