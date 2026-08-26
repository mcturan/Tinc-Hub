#!/usr/bin/env bash
# ============================================================
#  TINC Köle — Ana Kurulum Scripti
#  Tüm agent'ları ve dashboard'u tek seferde kurar.
#  Kullanım: sudo bash install.sh [--only=<bileşen>] [--skip=<bileşen>]
#
#  Örnekler:
#    sudo bash install.sh                        # Hepsini kur
#    sudo bash install.sh --only=dashboard       # Sadece dashboard
#    sudo bash install.sh --skip=ram-cleaner     # ram-cleaner hariç hepsini kur
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KOLE_VERSION="1.0.0"

# Bileşenler (sıralı)
ALL_COMPONENTS=(
    "dashboard"
    "router-guardian"
    "disk-sentinel"
    "ram-cleaner"
    "service-watchdog"
    "wan-tracker"
)

# Argüman parse
ONLY=""
SKIP=""
for arg in "$@"; do
    case "$arg" in
        --only=*) ONLY="${arg#--only=}" ;;
        --skip=*) SKIP="${arg#--skip=}" ;;
        -h|--help)
            echo "Kullanım: sudo bash install.sh [--only=<bileşen>] [--skip=<bileşen>]"
            echo "Bileşenler: ${ALL_COMPONENTS[*]}"
            exit 0
            ;;
    esac
done

# Renk kodları
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

header() {
    echo ""
    echo -e "${BLUE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}${BOLD}  ⚙  TINC Köle v${KOLE_VERSION} — Kurulum${NC}"
    echo -e "${BLUE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

info()    { echo -e "${GREEN}  ✓${NC} $1"; }
warn()    { echo -e "${YELLOW}  ⚠${NC} $1"; }
error()   { echo -e "${RED}  ✕${NC} $1"; exit 1; }
section() { echo -e "\n${BOLD}▸ $1${NC}"; }

should_install() {
    local comp="$1"
    [[ -n "$ONLY" && "$ONLY" != "$comp" ]] && return 1
    [[ -n "$SKIP" && "$SKIP" == "$comp" ]] && return 1
    return 0
}

# ─── Başlangıç ─────────────────────────────────────────────

header
[[ $EUID -ne 0 ]] && error "Bu script root olarak çalıştırılmalıdır: sudo bash install.sh"

# Sistem kontrolleri
section "Sistem Kontrolleri"
command -v python3 >/dev/null || error "Python 3 gerekli. Kurulum: apt install python3"
command -v systemctl >/dev/null || error "systemd gerekli"
PYTHON_VER=$(python3 --version | cut -d' ' -f2)
info "Python ${PYTHON_VER}"

# Pip kontrolü
if ! python3 -c "import pip" 2>/dev/null; then
    warn "pip bulunamadı, kuruluyor..."
    apt-get install -y python3-pip python3-venv >/dev/null 2>&1
fi

# ─── Ortak Altyapı ─────────────────────────────────────────

section "Ortak Altyapı"

# Dizinler
mkdir -p /opt/kole/{shared,agents}
mkdir -p /var/lib/kole
mkdir -p /var/log/kole
mkdir -p /etc/kole
info "Dizinler hazır"

# Config dosyası
if [[ ! -f /etc/kole/config.env ]]; then
    cp "$SCRIPT_DIR/shared/config.env.template" /etc/kole/config.env
    warn "Config oluşturuldu: /etc/kole/config.env"
    warn "Lütfen ROUTER_PASS ve diğer değerleri düzenleyin!"
else
    info "Config mevcut: /etc/kole/config.env"
fi

# Shared Python modülleri
cp "$SCRIPT_DIR/shared/db.py" /opt/kole/shared/
info "Shared DB modülü kopyalandı"

# Python venv (tek, paylaşımlı)
if [[ ! -d /opt/kole/venv ]]; then
    info "Python virtual environment oluşturuluyor..."
    python3 -m venv /opt/kole/venv
fi
info "Paketler yükleniyor..."
/opt/kole/venv/bin/pip install --quiet --upgrade pip
/opt/kole/venv/bin/pip install --quiet \
    flask python-dotenv requests urllib3 psutil
info "Python paketleri hazır"

# ─── Bileşen Kurulumları ───────────────────────────────────

section "Bileşen Kurulumları"
INSTALLED=()
SKIPPED=()

for comp in "${ALL_COMPONENTS[@]}"; do
    if should_install "$comp"; then
        echo -e "\n  ${BOLD}→ ${comp}${NC}"
        if [[ "$comp" == "dashboard" ]]; then
            COMP_DIR="$SCRIPT_DIR/dashboard"
        else
            COMP_DIR="$SCRIPT_DIR/agents/$comp"
        fi

        if [[ -f "$COMP_DIR/install.sh" ]]; then
            bash "$COMP_DIR/install.sh" 2>&1 | sed 's/^/    /'
            INSTALLED+=("$comp")
        else
            warn "${comp}: install.sh bulunamadı, atlanıyor"
            SKIPPED+=("$comp")
        fi
    else
        SKIPPED+=("$comp")
    fi
done

# ─── Özet ──────────────────────────────────────────────────

echo ""
echo -e "${BLUE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Kurulum Tamamlandı!${NC}"
echo -e "${BLUE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

HOST_IP=$(hostname -I | awk '{print $1}')
DASH_PORT=$(grep "DASHBOARD_PORT" /etc/kole/config.env 2>/dev/null | cut -d= -f2 | tr -d ' ' || echo "9010")

echo -e "  ${GREEN}Kurulan:${NC}  ${INSTALLED[*]:-hiç}"
[[ ${#SKIPPED[@]} -gt 0 ]] && echo -e "  ${YELLOW}Atlanan:${NC}   ${SKIPPED[*]}"
echo ""
echo -e "  ${BOLD}Dashboard:${NC} http://${HOST_IP}:${DASH_PORT}"
echo -e "  ${BOLD}Config:${NC}    /etc/kole/config.env"
echo -e "  ${BOLD}Loglar:${NC}    /var/log/kole/"
echo -e "  ${BOLD}Veriler:${NC}   /var/lib/kole/kole.db"
echo ""
echo -e "  Durum:     ${BOLD}systemctl status 'kole-*'${NC}"
echo -e "  Durdur:    ${BOLD}systemctl stop 'kole-*'${NC}"
echo -e "  Kaldır:    ${BOLD}bash uninstall.sh${NC}"
echo ""
