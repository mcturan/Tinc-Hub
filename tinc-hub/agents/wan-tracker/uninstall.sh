#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="wan-tracker"

echo "🗑️  $AGENT_ID agent kaldırılıyor..."

# Servisi durdur ve devre dışı bırak
systemctl disable --now "tinc-hub-$AGENT_ID.service" 2>/dev/null || true

# Servis dosyasını sil
rm -f "/etc/systemd/system/tinc-hub-$AGENT_ID.service"
systemctl daemon-reload

# Kurulum dizinini temizle
rm -rf "/opt/tinc-hub/agents/$AGENT_ID"

echo "🗑️  $AGENT_ID agent kaldırıldı"
echo "   Not: Loglar /var/log/tinc-hub/$AGENT_ID.log adresinde bırakıldı."
echo "   Logları da silmek için: rm -f /var/log/tinc-hub/$AGENT_ID.log"
