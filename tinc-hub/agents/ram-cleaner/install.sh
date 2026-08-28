#!/usr/bin/env bash
# Tinc Hub — RAM Cleaner Agent kurulum betiği
set -euo pipefail

AGENT_ID="ram-cleaner"
INSTALL_DIR="/opt/tinc-hub/agents/$AGENT_ID"
SERVICE_NAME="tinc-hub-$AGENT_ID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Gereksinim kontrolleri ───────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "❌  Bu betik root olarak çalışmalıdır (sudo $0)" >&2
    exit 1
fi

echo "🔧  $AGENT_ID agent kuruluyor..."

# ── 1. Bağımlılıklar ─────────────────────────────────────────────────────────
echo "📦  Python bağımlılıkları kontrol ediliyor..."
python3 -c "import psutil" 2>/dev/null || pip3 install -q --break-system-packages psutil
python3 -c "import dotenv" 2>/dev/null || pip3 install -q --break-system-packages python-dotenv

# ── 2. Log dizini ────────────────────────────────────────────────────────────
mkdir -p /var/log/tinc-hub
chmod 750 /var/log/tinc-hub

# ── 3. Kurulum dizini ────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"

# ── 4. Dosyaları kopyala ─────────────────────────────────────────────────────
cp "$SCRIPT_DIR/agent.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/agent.py"

echo "📁  Dosyalar $INSTALL_DIR dizinine kopyalandı."

# ── 5. Shared modülün varlığını kontrol et ───────────────────────────────────
if [[ ! -f /opt/tinc-hub/shared/db.py ]]; then
    echo "⚠️   /opt/tinc-hub/shared/db.py bulunamadı — shared modülü kurun." >&2
fi

# ── 6. Config dosyasını kontrol et / oluştur ─────────────────────────────────
if [[ ! -f /etc/tinc-hub/config.env ]]; then
    echo "⚠️   /etc/tinc-hub/config.env bulunamadı — örnek oluşturuluyor..."
    mkdir -p /etc/tinc-hub
    cat > /etc/tinc-hub/config.env << 'CONF'
# RAM Cleaner Agent Yapılandırması
RAM_WARN_PERCENT=85
RAM_CHECK_INTERVAL=300
SWAP_CLEAN_THRESHOLD=70
# OLLAMA_SERVICE=ollama
CONF
    chmod 600 /etc/tinc-hub/config.env
    echo "   ✅  /etc/tinc-hub/config.env oluşturuldu — gerekirse düzenleyin."
fi

# ── 7. Systemd servisini kur ─────────────────────────────────────────────────
cp "$SCRIPT_DIR/$SERVICE_NAME.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.service"

echo ""
echo "✅  $AGENT_ID agent kuruldu ve başlatıldı."
echo "   Durum : systemctl status $SERVICE_NAME"
echo "   Log   : tail -f /var/log/tinc-hub/$AGENT_ID.log"
