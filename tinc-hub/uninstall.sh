#!/usr/bin/env bash
# ============================================================
#  Tinc Hub — Ana Kaldırma Scripti
#  Kullanım: sudo bash uninstall.sh [--only=<bileşen>]
# ============================================================
set -euo pipefail

ONLY=""
for arg in "$@"; do
    [[ "$arg" == --only=* ]] && ONLY="${arg#--only=}"
done

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
[[ $EUID -ne 0 ]] && { echo "sudo gerekli"; exit 1; }

ALL=(tinc-hub tinc-hub-router-guardian tinc-hub-disk-sentinel tinc-hub-ram-cleaner tinc-hub-service-watchdog tinc-hub-wan-tracker)

echo -e "${RED}${BOLD}Tinc Hub kaldırılıyor...${NC}"

for svc in "${ALL[@]}"; do
    [[ -n "$ONLY" && "$ONLY" != "${svc#tinc-hub-}" ]] && continue
    systemctl disable --now "$svc" 2>/dev/null || true
    rm -f "/etc/systemd/system/${svc}.service"
    echo -e "  ${GREEN}✓${NC} ${svc} durduruldu"
done

systemctl daemon-reload

if [[ -z "$ONLY" ]]; then
    rm -rf /opt/tinc-hub
    rm -rf /var/lib/tinc-hub
    rm -rf /var/log/tinc-hub
    rm -rf /etc/tinc-hub
    echo -e "\n${GREEN}✓ Tüm Tinc Hub bileşenleri ve verileri kaldırıldı.${NC}"
else
    COMP_DIR="/opt/tinc-hub/agents/$ONLY"
    [[ "$ONLY" == "dashboard" ]] && COMP_DIR="/opt/tinc-hub/dashboard"
    rm -rf "$COMP_DIR"
    echo -e "\n${GREEN}✓ ${ONLY} kaldırıldı.${NC}"
fi
