#!/usr/bin/env bash
# ============================================================
#  TINC Köle — Ana Kaldırma Scripti
#  Kullanım: sudo bash uninstall.sh [--only=<bileşen>]
# ============================================================
set -euo pipefail

ONLY=""
for arg in "$@"; do
    [[ "$arg" == --only=* ]] && ONLY="${arg#--only=}"
done

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
[[ $EUID -ne 0 ]] && { echo "sudo gerekli"; exit 1; }

ALL=(kole-dashboard kole-router-guardian kole-disk-sentinel kole-ram-cleaner kole-service-watchdog kole-wan-tracker)

echo -e "${RED}${BOLD}TINC Köle kaldırılıyor...${NC}"

for svc in "${ALL[@]}"; do
    [[ -n "$ONLY" && "$ONLY" != "${svc#kole-}" ]] && continue
    systemctl disable --now "$svc" 2>/dev/null || true
    rm -f "/etc/systemd/system/${svc}.service"
    echo -e "  ${GREEN}✓${NC} ${svc} durduruldu"
done

systemctl daemon-reload

if [[ -z "$ONLY" ]]; then
    rm -rf /opt/kole
    rm -rf /var/lib/kole
    rm -rf /var/log/kole
    rm -rf /etc/kole
    echo -e "\n${GREEN}✓ Tüm TINC Köle bileşenleri ve verileri kaldırıldı.${NC}"
else
    COMP_DIR="/opt/kole/agents/$ONLY"
    [[ "$ONLY" == "dashboard" ]] && COMP_DIR="/opt/kole/dashboard"
    rm -rf "$COMP_DIR"
    echo -e "\n${GREEN}✓ ${ONLY} kaldırıldı.${NC}"
fi
