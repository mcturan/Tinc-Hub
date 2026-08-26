#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="service-watchdog"
INSTALL_DIR="/opt/kole/agents/$AGENT_ID"

echo "🔧 $AGENT_ID kurulumu başlıyor..."

# 1. Dizin oluştur
mkdir -p "$INSTALL_DIR"

# 2. Agent dosyasını kopyala
cp agent.py "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/agent.py"

# 3. Log dizinini oluştur
mkdir -p /var/log/kole

# 4. Servisi kur ve başlat
cp "kole-$AGENT_ID.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "kole-$AGENT_ID.service"

echo "✅ $AGENT_ID agent kuruldu ve başlatıldı"
echo "📋 Durum: systemctl status kole-$AGENT_ID.service"
echo "📄 Loglar: tail -f /var/log/kole/$AGENT_ID.log"
