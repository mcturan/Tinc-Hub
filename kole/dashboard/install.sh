#!/usr/bin/env bash
# ============================================================
# TINC Köle — Dashboard Kurulum Scripti
# Kullanım: sudo bash install.sh
# ============================================================
set -euo pipefail

COMPONENT="dashboard"
INSTALL_DIR="/opt/kole/dashboard"
SERVICE="kole-dashboard"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Renk kodları
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && error "Bu script root olarak çalıştırılmalıdır: sudo bash install.sh"

info "TINC Köle Dashboard kuruluyor..."

# 1. Dizinler
mkdir -p "$INSTALL_DIR"/{templates,static/{css,js}}
mkdir -p /var/lib/kole
mkdir -p /var/log/kole
info "Dizinler oluşturuldu"

# 2. Python venv (paylaşımlı)
if [[ ! -d /opt/kole/venv ]]; then
    info "Python virtual environment oluşturuluyor..."
    python3 -m venv /opt/kole/venv
fi

# 3. Gereksinimleri yükle
info "Python paketleri yükleniyor..."
/opt/kole/venv/bin/pip install --quiet --upgrade pip
/opt/kole/venv/bin/pip install --quiet flask python-dotenv requests psutil

# 4. Shared modülü kopyala
mkdir -p /opt/kole/shared
cp "$SCRIPT_DIR/../../shared/db.py" /opt/kole/shared/
info "Shared DB modülü kopyalandı"

# 5. Dashboard dosyalarını kopyala
cp "$SCRIPT_DIR/app.py" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/templates/"* "$INSTALL_DIR/templates/"
cp -r "$SCRIPT_DIR/static/"* "$INSTALL_DIR/static/" 2>/dev/null || true
chmod +x "$INSTALL_DIR/app.py"
info "Dashboard dosyaları kopyalandı"

# 6. Config dosyası
if [[ ! -f /etc/kole/config.env ]]; then
    mkdir -p /etc/kole
    cp "$SCRIPT_DIR/../../shared/config.env.template" /etc/kole/config.env
    warn "Config dosyası oluşturuldu: /etc/kole/config.env"
    warn "Lütfen ROUTER_PASS ve diğer değerleri düzenleyin!"
fi

# 7. Port 9010 kontrolü
PORT=$(grep "DASHBOARD_PORT" /etc/kole/config.env | cut -d= -f2 | tr -d ' ' || echo "9010")
if ss -tlnp | grep -q ":${PORT} " 2>/dev/null; then
    warn "Port ${PORT} kullanımda! config.env'de DASHBOARD_PORT değiştirin."
fi

# 8. Systemd service
cp "$SCRIPT_DIR/kole-dashboard.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "${SERVICE}.service"
info "Servis etkinleştirildi: ${SERVICE}"

# 9. Durum kontrolü
sleep 2
if systemctl is-active --quiet "${SERVICE}"; then
    info "✅ TINC Köle Dashboard başarıyla kuruldu!"
    echo ""
    echo "  Erişim: http://$(hostname -I | awk '{print $1}'):${PORT}"
    echo "  Log:    journalctl -u ${SERVICE} -f"
    echo "  Durdur: systemctl stop ${SERVICE}"
else
    error "Servis başlatılamadı. Log: journalctl -u ${SERVICE} -n 20"
fi
