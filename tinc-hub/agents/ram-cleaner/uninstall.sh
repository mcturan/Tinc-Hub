#!/usr/bin/env bash
# Tinc Hub — RAM Cleaner Agent kaldırma betiği
set -euo pipefail

AGENT_ID="ram-cleaner"
INSTALL_DIR="/opt/tinc-hub/agents/$AGENT_ID"
SERVICE_NAME="tinc-hub-$AGENT_ID"

# ── Gereksinim kontrolleri ───────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "❌  Bu betik root olarak çalışmalıdır (sudo $0)" >&2
    exit 1
fi

echo "🗑️   $AGENT_ID agent kaldırılıyor..."

# ── 1. Servisi durdur ve devre dışı bırak ────────────────────────────────────
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl stop "$SERVICE_NAME"
    echo "   ⏹️   $SERVICE_NAME durduruldu."
fi

if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl disable "$SERVICE_NAME"
    echo "   🔕  $SERVICE_NAME devre dışı bırakıldı."
fi

# ── 2. Servis dosyasını kaldır ───────────────────────────────────────────────
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
if [[ -f "$SERVICE_FILE" ]]; then
    rm -f "$SERVICE_FILE"
    echo "   🗑️   $SERVICE_FILE kaldırıldı."
fi

systemctl daemon-reload

# ── 3. Kurulum dizinini kaldır ───────────────────────────────────────────────
if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    echo "   🗑️   $INSTALL_DIR kaldırıldı."
fi

echo ""
echo "✅  $AGENT_ID agent başarıyla kaldırıldı."
echo "   Not: /var/log/tinc-hub/$AGENT_ID.log ve /etc/tinc-hub/config.env korundu."
