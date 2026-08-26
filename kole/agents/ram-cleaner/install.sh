#!/usr/bin/env bash
# TINC Köle — RAM Cleaner Agent kurulum betiği
set -euo pipefail

AGENT_ID="ram-cleaner"
INSTALL_DIR="/opt/kole/agents/$AGENT_ID"
SERVICE_NAME="kole-$AGENT_ID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Gereksinim kontrolleri ───────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "❌  Bu betik root olarak çalışmalıdır (sudo $0)" >&2
    exit 1
fi

echo "🔧  $AGENT_ID agent kuruluyor..."

# ── 1. Bağımlılıklar ─────────────────────────────────────────────────────────
echo "📦  Python bağımlılıkları kontrol ediliyor..."
python3 -c "import psutil" 2>/dev/null || pip3 install -q psutil
python3 -c "import dotenv" 2>/dev/null || pip3 install -q python-dotenv

# ── 2. Log dizini ────────────────────────────────────────────────────────────
mkdir -p /var/log/kole
chmod 750 /var/log/kole

# ── 3. Kurulum dizini ────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"

# ── 4. Dosyaları kopyala ─────────────────────────────────────────────────────
cp "$SCRIPT_DIR/agent.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/agent.py"

echo "📁  Dosyalar $INSTALL_DIR dizinine kopyalandı."

# ── 5. Shared modülün varlığını kontrol et ───────────────────────────────────
if [[ ! -f /opt/kole/shared/db.py ]]; then
    echo "⚠️   /opt/kole/shared/db.py bulunamadı — shared modülü kurun." >&2
fi

# ── 6. Config dosyasını kontrol et / oluştur ─────────────────────────────────
if [[ ! -f /etc/kole/config.env ]]; then
    echo "⚠️   /etc/kole/config.env bulunamadı — örnek oluşturuluyor..."
    mkdir -p /etc/kole
    cat > /etc/kole/config.env << 'CONF'
# RAM Cleaner Agent Yapılandırması
RAM_WARN_PERCENT=85
RAM_CHECK_INTERVAL=300
SWAP_CLEAN_THRESHOLD=70
# OLLAMA_SERVICE=ollama
CONF
    chmod 600 /etc/kole/config.env
    echo "   ✅  /etc/kole/config.env oluşturuldu — gerekirse düzenleyin."
fi

# ── 7. Systemd servisini kur ─────────────────────────────────────────────────
cp "$SCRIPT_DIR/$SERVICE_NAME.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.service"

echo ""
echo "✅  $AGENT_ID agent kuruldu ve başlatıldı."
echo "   Durum : systemctl status $SERVICE_NAME"
echo "   Log   : tail -f /var/log/kole/$AGENT_ID.log"
