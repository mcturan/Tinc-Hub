#!/bin/bash
echo "[INFO] Tinc Firewall Kuruluyor..."
sudo apt-get install -y ufw

cat << 'SRV' | sudo tee /etc/systemd/system/tinc-firewall.service
[Unit]
Description=Tinc Hub - Firewall
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/tinc-hub/tinc-firewall
ExecStart=/opt/tinc-hub/venv/bin/python /opt/tinc-hub/tinc-firewall/app.py
Restart=always

[Install]
WantedBy=multi-user.target
SRV

sudo mkdir -p /opt/tinc-hub/tinc-firewall
sudo cp -r ./* /opt/tinc-hub/tinc-firewall/

sudo systemctl daemon-reload
sudo systemctl enable tinc-firewall
sudo systemctl restart tinc-firewall
echo "[INFO] Firewall kurulu!"
