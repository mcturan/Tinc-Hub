#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Tinc Hub — Router Guardian uninstall.sh
# ──────────────────────────────────────────────────────────────
set -euo pipefail

AGENT_ID="router-guardian"
SERVICE_NAME="tinc-hub-${AGENT_ID}"
INSTALL_DIR="/opt/tinc-hub/agents/${AGENT_ID}"

echo "🗑️  ${AGENT_ID} agent kaldırılıyor..."

# ── 1. Servisi durdur ve devre dışı bırak ──────────────────
if systemctl is-active --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
    systemctl stop "${SERVICE_NAME}.service"
    echo "⏹️  Servis durduruldu."
fi

systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
echo "🚫 Servis devre dışı bırakıldı."

# ── 2. Systemd service dosyasını kaldır ────────────────────
if [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    echo "🗑️  Service dosyası silindi."
fi

systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true

# ── 3. Agent dosyalarını kaldır ─────────────────────────────
if [ -d "${INSTALL_DIR}" ]; then
    rm -rf "${INSTALL_DIR}"
    echo "🗑️  Agent dizini silindi: ${INSTALL_DIR}"
fi

echo ""
echo "✅ ${AGENT_ID} agent başarıyla kaldırıldı."
echo ""
echo "ℹ️  Log dosyaları /var/log/tinc-hub/${AGENT_ID}.log adresinde bırakıldı."
echo "   Silmek için: rm -f /var/log/tinc-hub/${AGENT_ID}.log"
