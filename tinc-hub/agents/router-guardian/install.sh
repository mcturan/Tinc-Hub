#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Tinc Hub — Router Guardian install.sh
# ──────────────────────────────────────────────────────────────
set -euo pipefail

AGENT_ID="router-guardian"
SERVICE_NAME="tinc-hub-${AGENT_ID}"
INSTALL_DIR="/opt/tinc-hub/agents/${AGENT_ID}"
LOG_DIR="/var/log/tinc-hub"
SHARED_DIR="/opt/tinc-hub/shared"

echo "🔧 ${AGENT_ID} agent kuruluyor..."

# ── 0. Bağımlılık kontrolü ──────────────────────────────────
echo "📦 Python bağımlılıkları kontrol ediliyor..."
python3 -c "import requests, urllib3, dotenv" 2>/dev/null || {
    echo "   Eksik paketler kuruluyor..."
    pip3 install --quiet --break-system-packages requests urllib3 python-dotenv
}

# ── 1. Dizinleri oluştur ────────────────────────────────────
mkdir -p "${INSTALL_DIR}"
mkdir -p "${LOG_DIR}"
mkdir -p "${SHARED_DIR}"

echo "📁 Dizinler oluşturuldu: ${INSTALL_DIR}"

# ── 2. Script dizinini belirle ──────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 3. Agent dosyasını kopyala ──────────────────────────────
cp "${SCRIPT_DIR}/agent.py" "${INSTALL_DIR}/agent.py"
chmod +x "${INSTALL_DIR}/agent.py"

echo "📄 agent.py kopyalandı ve çalıştırılabilir yapıldı."

# ── 4. Shared DB modülünü kontrol et ───────────────────────
if [ ! -f "${SHARED_DIR}/db.py" ]; then
    echo "⚠️  UYARI: ${SHARED_DIR}/db.py bulunamadı!"
    echo "   Shared DB modülünü manuel olarak yerleştirin."
fi

# ── 5. Config dosyasını kontrol et ─────────────────────────
if [ ! -f "/etc/tinc-hub/config.env" ]; then
    echo "⚠️  /etc/tinc-hub/config.env bulunamadı, örnek oluşturuluyor..."
    mkdir -p /etc/tinc-hub
    cat > /etc/tinc-hub/config.env <<'CONFIG'
# Router Guardian Ayarları
ROUTER_IP=192.168.1.1
ROUTER_USER=admin
ROUTER_PASS=admin
ROUTER_PING_INTERVAL=60
ROUTER_REBOOT_CRON=06:00
ROUTER_SMART_REBOOT=true
CONFIG
    echo "   ✏️  /etc/tinc-hub/config.env oluşturuldu. Lütfen değerleri düzenleyin."
fi

# ── 6. Systemd service kur ──────────────────────────────────
cp "${SCRIPT_DIR}/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.service"
echo "⚙️  Systemd service kopyalandı: /etc/systemd/system/${SERVICE_NAME}.service"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl start  "${SERVICE_NAME}.service"

echo ""
echo "✅ ${AGENT_ID} agent kuruldu ve başlatıldı!"
echo ""
echo "📊 Durum için: systemctl status ${SERVICE_NAME}"
echo "📜 Loglar için: tail -f ${LOG_DIR}/${AGENT_ID}.log"
