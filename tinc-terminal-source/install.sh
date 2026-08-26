#!/bin/bash
echo "[INFO] TTYd (Terminal) Kurulumu Başlıyor..."

# ttyd yüklü mü kontrol et
if ! command -v ttyd &> /dev/null; then
    echo "[INFO] ttyd indiriliyor..."
    sudo wget -O /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64
    sudo chmod +x /usr/local/bin/ttyd
fi

# Systemd servisini oluştur (User service)
mkdir -p /home/turan/.config/systemd/user
cat << 'SRV' > /home/turan/.config/systemd/user/tinc-terminal.service
[Unit]
Description=Tinc Hub - Terminal (ttyd)
After=network.target

[Service]
ExecStart=/usr/local/bin/ttyd -p 9012 -W bash
Restart=always

[Install]
WantedBy=default.target
SRV

echo "[INFO] Systemd servisi başlatılıyor..."
systemctl --user daemon-reload
systemctl --user enable tinc-terminal.service
systemctl --user restart tinc-terminal.service
loginctl enable-linger turan

echo "[INFO] Terminal 9012 portunda başarıyla başlatıldı!"
