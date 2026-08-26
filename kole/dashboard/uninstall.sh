#!/usr/bin/env bash
# ============================================================
# TINC Köle — Dashboard Kaldırma Scripti
# Kullanım: sudo bash uninstall.sh
# ============================================================
set -euo pipefail

SERVICE="kole-dashboard"
INSTALL_DIR="/opt/kole/dashboard"

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $1"; }

[[ $EUID -ne 0 ]] && { echo "sudo gerekli"; exit 1; }

systemctl disable --now "${SERVICE}.service" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
rm -rf "$INSTALL_DIR"
info "🗑️ TINC Köle Dashboard kaldırıldı"
