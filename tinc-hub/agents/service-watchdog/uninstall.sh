#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="service-watchdog"

echo "🗑️  $AGENT_ID kaldırılıyor..."

# Servisi durdur ve devre dışı bırak
systemctl disable --now "tinc-hub-$AGENT_ID.service" 2>/dev/null || true

# Service dosyasını sil
rm -f "/etc/systemd/system/tinc-hub-$AGENT_ID.service"

# systemd'yi yeniden yükle
systemctl daemon-reload

# Kurulum dizinini sil
rm -rf "/opt/tinc-hub/agents/$AGENT_ID"

echo "🗑️  $AGENT_ID agent kaldırıldı"
echo "ℹ️  Log dosyası korundu: /var/log/tinc-hub/$AGENT_ID.log"
echo "ℹ️  DB kayıtları korundu: /var/lib/tinc-hub/kole.db"
