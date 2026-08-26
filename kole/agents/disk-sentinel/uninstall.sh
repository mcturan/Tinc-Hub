#!/usr/bin/env bash
# uninstall.sh — TINC Köle Disk Sentinel kaldırma betiği
set -euo pipefail

AGENT_ID="disk-sentinel"
SERVICE_NAME="kole-${AGENT_ID}"
INSTALL_DIR="/opt/kole/agents/${AGENT_ID}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
LOG_FILE="/var/log/kole/${AGENT_ID}.log"

# ---------------------------------------------------------------------------
# Root kontrolü
# ---------------------------------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
    echo "❌ Bu betik root olarak çalıştırılmalıdır." >&2
    exit 1
fi

echo "🗑️  ${AGENT_ID} kaldırılıyor…"

# ---------------------------------------------------------------------------
# 1. Servisi durdur ve devre dışı bırak
# ---------------------------------------------------------------------------
if systemctl is-active --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
    echo "⏹  Servis durduruluyor: ${SERVICE_NAME}"
    systemctl stop "${SERVICE_NAME}.service"
fi

systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. Servis dosyasını kaldır
# ---------------------------------------------------------------------------
if [[ -f "${SERVICE_FILE}" ]]; then
    rm -f "${SERVICE_FILE}"
    echo "✔ Servis dosyası kaldırıldı: ${SERVICE_FILE}"
fi

systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true

# ---------------------------------------------------------------------------
# 3. Kurulum dizinini kaldır
# ---------------------------------------------------------------------------
if [[ -d "${INSTALL_DIR}" ]]; then
    rm -rf "${INSTALL_DIR}"
    echo "✔ Kurulum dizini kaldırıldı: ${INSTALL_DIR}"
fi

# ---------------------------------------------------------------------------
# 4. Log dosyası (opsiyonel — kullanıcıya sor)
# ---------------------------------------------------------------------------
if [[ -f "${LOG_FILE}" ]]; then
    read -r -p "Log dosyası silinsin mi? (${LOG_FILE}) [e/H]: " yn
    case "${yn}" in
        [Ee]*)
            rm -f "${LOG_FILE}"
            echo "✔ Log dosyası silindi."
            ;;
        *)
            echo "ℹ  Log dosyası korunuyor: ${LOG_FILE}"
            ;;
    esac
fi

echo "✅ ${AGENT_ID} başarıyla kaldırıldı."
