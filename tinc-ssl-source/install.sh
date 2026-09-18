#!/bin/bash
echo "[INFO] SSL/HTTPS Altyapısı Kuruluyor..."
sudo apt-get install -y nginx certbot python3-certbot-nginx

# Tinc Hub Nginx conf
cat << 'CONF' | sudo tee /etc/nginx/sites-available/tinc-hub
server {
    listen 80;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:9010;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
CONF

sudo ln -sf /etc/nginx/sites-available/tinc-hub /etc/nginx/sites-enabled/
sudo systemctl restart nginx
echo "[INFO] Nginx reverse proxy aktif. Dışarıdan domain ile eriştiğinizde 'sudo certbot --nginx' yazarak SSL alabilirsiniz!"
