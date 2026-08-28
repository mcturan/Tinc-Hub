#!/usr/bin/env bash
# ============================================================
# Tinc Hub — Dashboard Kurulum Scripti
# Kullanım: sudo bash install.sh
# ============================================================
set -euo pipefail

COMPONENT="dashboard"
INSTALL_DIR="/opt/tinc-hub/dashboard"
SERVICE="tinc-hub"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Renk kodları
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && error "Bu script root olarak çalıştırılmalıdır: sudo bash install.sh"

info "Tinc Hub Dashboard kuruluyor..."

# 1. Dizinler
mkdir -p "$INSTALL_DIR"/{templates,static/{css,js}}
mkdir -p /var/lib/tinc-hub
mkdir -p /var/log/tinc-hub
info "Dizinler oluşturuldu"

# 2. Python venv (paylaşımlı)
if [[ ! -d /opt/tinc-hub/venv ]]; then
    info "Python virtual environment oluşturuluyor..."
    python3 -m venv /opt/tinc-hub/venv
fi

# 3. Gereksinimleri yükle
info "Python paketleri yükleniyor..."
/opt/tinc-hub/venv/bin/pip install --quiet --upgrade pip
/opt/tinc-hub/venv/bin/pip install --quiet flask python-dotenv requests psutil PyYAML

# 4. Shared modülü kopyala
mkdir -p /opt/tinc-hub/shared
cp "$SCRIPT_DIR/../shared/db.py" /opt/tinc-hub/shared/
info "Shared DB modülü kopyalandı"

# 5. Dashboard dosyalarını kopyala
cp "$SCRIPT_DIR/"*.py "$INSTALL_DIR/"
cp "$SCRIPT_DIR/"*.json "$INSTALL_DIR/" 2>/dev/null || true
cp -r "$SCRIPT_DIR/templates/"* "$INSTALL_DIR/templates/"
cp -r "$SCRIPT_DIR/static/"* "$INSTALL_DIR/static/" 2>/dev/null || true
chmod +x "$INSTALL_DIR/"*.py

# Git sürüm bilgisini kaydet
GIT_DIR_FOUND="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -n "$GIT_DIR_FOUND" ]]; then
    GIT_COUNT=$(git -C "$GIT_DIR_FOUND" rev-list --count HEAD 2>/dev/null || echo "1")
    GIT_HASH=$(git -C "$GIT_DIR_FOUND" rev-parse --short HEAD 2>/dev/null || echo "release")
    echo "{\"count\": $GIT_COUNT, \"hash\": \"$GIT_HASH\", \"version\": \"v1.${GIT_COUNT}.${GIT_HASH}\", \"repo_dir\": \"$GIT_DIR_FOUND\"}" > "$INSTALL_DIR/version.json"
fi
info "Dashboard dosyaları kopyalandı"

# 5.1. Varsayılan apps.yaml kopyala
if [[ ! -f /etc/tinc-hub/apps.yaml ]]; then
    mkdir -p /etc/tinc-hub
    cp "$SCRIPT_DIR/apps.yaml" /etc/tinc-hub/apps.yaml
    info "Varsayılan apps.yaml oluşturuldu"
fi

# 6. Config dosyası
if [[ ! -f /etc/tinc-hub/config.env ]]; then
    mkdir -p /etc/tinc-hub
    cp "$SCRIPT_DIR/../shared/config.env.template" /etc/tinc-hub/config.env
    warn "Config dosyası oluşturuldu: /etc/tinc-hub/config.env"
    warn "Lütfen ROUTER_PASS ve diğer değerleri düzenleyin!"
fi

# 7. Port 9010 kontrolü
PORT=$(grep "DASHBOARD_PORT" /etc/tinc-hub/config.env | cut -d= -f2 | tr -d ' ' || echo "9010")
if ss -tlnp | grep -q ":${PORT} " 2>/dev/null; then
    warn "Port ${PORT} kullanımda! config.env'de DASHBOARD_PORT değiştirin."
fi

# 8. Systemd service
cp "$SCRIPT_DIR/tinc-hub.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "${SERVICE}.service"
info "Servis etkinleştirildi: ${SERVICE}"

# 9. Durum kontrolü
sleep 2
if systemctl is-active --quiet "${SERVICE}"; then
    info "✅ Tinc Hub Dashboard başarıyla kuruldu!"
    echo ""
    echo "  Erişim: http://$(hostname -I | awk '{print $1}'):${PORT}"
    echo "  Log:    journalctl -u ${SERVICE} -f"
    echo "  Durdur: systemctl stop ${SERVICE}"
else
    error "Servis başlatılamadı. Log: journalctl -u ${SERVICE} -n 20"
fi

# Tray uygulamasını kopyala
if [ -d "$SCRIPT_DIR/../tray" ]; then
    mkdir -p /opt/tinc-hub/tray
    cp "$SCRIPT_DIR/../tray/"* /opt/tinc-hub/tray/
    
    # Mevcut kullanıcı için autostart ekle
    if [ -n "$SUDO_USER" ]; then
        USER_HOME=$(getent passwd $SUDO_USER | cut -d: -f6)
        mkdir -p $USER_HOME/.config/autostart
        cp "$SCRIPT_DIR/../tray/tinc-hub.desktop" $USER_HOME/.config/autostart/
        chown -R $SUDO_USER:$SUDO_USER $USER_HOME/.config/autostart
    fi
fi
