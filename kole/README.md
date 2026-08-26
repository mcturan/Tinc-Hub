# ⚙ TINC Köle — Agent İzleme Sistemi

Ev/ofis sunucunuzu izleyen, düzenleyen ve koruyan otonom agent sistemi.  
Tek komutla kurulur, systemd ile çalışır, bağımsız olarak taşınabilir.

## 🚀 Hızlı Başlangıç

```bash
git clone https://github.com/mcturan/101.git
cd 101/kole

# Config'i düzenle
sudo cp shared/config.env.template /etc/kole/config.env
sudo nano /etc/kole/config.env   # ROUTER_PASS vs. doldur

# Hepsini kur
sudo bash install.sh

# Ya da seçerek
sudo bash install.sh --only=dashboard
sudo bash install.sh --skip=router-guardian
```

Dashboard'a eriş: **http://SUNUCU-IP:9010**

---

## 🤖 Agent'lar

| Agent | Servis Adı | Yaptığı |
|-------|-----------|---------|
| **Dashboard** | `kole-dashboard` | TINC Köle web arayüzü (port 9010) |
| **router-guardian** | `kole-router-guardian` | WAN IP takibi, akıllı modem reboot |
| **disk-sentinel** | `kole-disk-sentinel` | Disk doluluk, SMART, geçici dosya temizliği |
| **ram-cleaner** | `kole-ram-cleaner` | RAM/Swap izleme, zombie process temizliği |
| **service-watchdog** | `kole-service-watchdog` | Systemd + Docker servis gözetmeni |
| **wan-tracker** | `kole-wan-tracker` | WAN IP geçmişi, dış port erişilebilirlik |

---

## 📁 Yapı

```
kole/
├── install.sh              ← Hepsini kur
├── uninstall.sh            ← Hepsini kaldır
├── shared/
│   ├── db.py               ← Ortak SQLite katmanı
│   ├── requirements.txt
│   └── config.env.template ← Örnek config
├── dashboard/
│   ├── app.py              ← Flask dashboard
│   ├── install.sh
│   └── templates/ + static/
└── agents/
    ├── router-guardian/
    ├── disk-sentinel/
    ├── ram-cleaner/
    ├── service-watchdog/
    └── wan-tracker/
```

Her agent dizininde: `agent.py`, `kole-<ad>.service`, `install.sh`, `uninstall.sh`

---

## ⚙ Konfigürasyon

Tüm ayarlar `/etc/kole/config.env` dosyasında:

```env
# Router
ROUTER_IP=192.168.1.1
ROUTER_USER=admin
ROUTER_PASS=sifreniz

# Eşikler
DISK_WARN_PERCENT=80
RAM_WARN_PERCENT=85

# Dashboard
DASHBOARD_PORT=9010
```

Örnek için bkz: [`shared/config.env.template`](shared/config.env.template)

---

## 🛠 Yönetim

```bash
# Tüm servislerin durumu
systemctl status 'kole-*'

# Belirli bir agent'ı yeniden başlat
sudo systemctl restart kole-disk-sentinel

# Log takibi
journalctl -u kole-router-guardian -f

# Log dosyaları
ls /var/log/kole/

# Veri tabanı
sqlite3 /var/lib/kole/kole.db ".tables"
```

---

## 📦 Başka Bir PC'ye Kurulum

```bash
git clone https://github.com/mcturan/101.git
cd 101/kole
sudo bash install.sh
```

Gereksinimler: `python3`, `python3-venv`, `systemd`

---

## 🗑 Kaldırma

```bash
sudo bash uninstall.sh          # Hepsini kaldır
sudo bash uninstall.sh --only=disk-sentinel  # Sadece birini
```

---

## 📊 Veri

Tüm agent'lar `/var/lib/kole/kole.db` SQLite veritabanına yazar:

- `agents` — Kayıtlı agent'lar ve durumları
- `events` — Log olayları (INFO/WARN/ERROR/CRITICAL)
- `metrics` — Zaman serisi metrikler (disk %, RAM %, WAN IP, ping ms...)
- `reports` — Periyodik raporlar
- `service_states` — Systemd servis durumları
- `wan_history` — WAN IP geçmişi
