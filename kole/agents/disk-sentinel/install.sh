#!/usr/bin/env bash
# install.sh — TINC Köle Disk Sentinel kurulum betiği
set -euo pipefail

AGENT_ID="disk-sentinel"
SERVICE_NAME="kole-${AGENT_ID}"
INSTALL_DIR="/opt/kole/agents/${AGENT_ID}"
LOG_DIR="/var/log/kole"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Root kontrolü
# ---------------------------------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
    echo "❌ Bu betik root olarak çalıştırılmalıdır." >&2
    exit 1
fi

echo "📦 ${AGENT_ID} kuruluyor…"

# ---------------------------------------------------------------------------
# 1. Dizinleri oluştur
# ---------------------------------------------------------------------------
mkdir -p "${INSTALL_DIR}"
mkdir -p "${LOG_DIR}"

# ---------------------------------------------------------------------------
# 2. Dosyaları kopyala
# ---------------------------------------------------------------------------
cp "${SCRIPT_DIR}/agent.py" "${INSTALL_DIR}/agent.py"
chmod +x "${INSTALL_DIR}/agent.py"

echo "✔ Dosyalar kopyalandı: ${INSTALL_DIR}"

# ---------------------------------------------------------------------------
# 3. Python bağımlılıklarını kontrol et
# ---------------------------------------------------------------------------
if ! python3 -c "import dotenv" 2>/dev/null; then
    echo "⚙ python-dotenv kuruluyor…"
    pip3 install --quiet python-dotenv
fi

# smartmontools varlık kontrolü (uyarı, hard hata değil)
if ! command -v smartctl &>/dev/null; then
    echo "⚠  smartctl bulunamadı. SMART kontrolleri devre dışı kalacak."
    echo "   Kurmak için: apt-get install smartmontools"
fi

# ---------------------------------------------------------------------------
# 4. Systemd servisini kur
# ---------------------------------------------------------------------------
cp "${SCRIPT_DIR}/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

# ---------------------------------------------------------------------------
# 5. Durum kontrolü
# ---------------------------------------------------------------------------
sleep 2
if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    echo "✅ ${AGENT_ID} agent kuruldu ve çalışıyor."
    echo "   Loglar: ${LOG_DIR}/${AGENT_ID}.log"
    echo "   Durum : systemctl status ${SERVICE_NAME}"
else
    echo "⚠  Servis başlatılamadı. Logları kontrol edin:"
    echo "   journalctl -u ${SERVICE_NAME} -n 30 --no-pager"
    exit 1
fi
