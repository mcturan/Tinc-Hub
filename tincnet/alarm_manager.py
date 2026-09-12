#!/usr/bin/env python3
"""
alarm_manager.py
----------------
Tinc-Hub Alarm ve Bildirim Motoru.

Nasıl çalışır:
- Her cihazın durumu (online/offline) izlenir.
- Kullanıcının tanımladığı alarm kuralları ALARM_FILE'da saklanır.
- check_alarms() periyodik olarak çağrılır; kurallarla eşleşen olayda
  Telegram veya benzeri kanallar üzerinden bildirim gönderir.
"""

import json, os, time, threading, subprocess, requests

ALARM_FILE = "/opt/tinc-hub/shared/alarms.json"
ALARM_LOG_FILE = "/opt/tinc-hub/shared/alarm_log.json"

# Cihazların son görülen offline zamanlarını takip eder
_offline_since: dict = {}         # ip -> timestamp (ilk çevrimdışı görülme)
_last_notified: dict = {}          # ip -> timestamp (son bildirim gönderme)
NOTIFY_COOLDOWN = 300              # Aynı cihaz için bildirimler arası min. süre (saniye)


# ──────────────────────────────────────────────────────────────────────────────
# Kural Yönetimi
# ──────────────────────────────────────────────────────────────────────────────

def load_alarms() -> list:
    """Alarm kurallarını dosyadan okur."""
    if os.path.exists(ALARM_FILE):
        try:
            with open(ALARM_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return []


def save_alarms(alarms: list):
    """Alarm kurallarını diske yazar."""
    os.makedirs(os.path.dirname(ALARM_FILE), exist_ok=True)
    with open(ALARM_FILE, "w") as f:
        json.dump(alarms, f, indent=2)


def add_alarm(ip: str, label: str, threshold_sec: int,
              channel: str, telegram_token: str, telegram_chat_id: str) -> dict:
    """
    Yeni bir alarm kuralı oluşturur.
    threshold_sec: Kaç saniyelik kesinti sonrası bildirim gönderilsin (örn. 180 = 3 dakika)
    channel: 'telegram' destekleniyor
    """
    alarms = load_alarms()
    rule = {
        "id": f"alarm-{int(time.time())}",
        "ip": ip,
        "label": label,
        "threshold_sec": threshold_sec,
        "channel": channel,
        "telegram_token": telegram_token,
        "telegram_chat_id": telegram_chat_id,
        "enabled": True,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S")
    }
    alarms.append(rule)
    save_alarms(alarms)
    return rule


def delete_alarm(alarm_id: str):
    """Alarm kuralını siler."""
    alarms = [a for a in load_alarms() if a["id"] != alarm_id]
    save_alarms(alarms)


# ──────────────────────────────────────────────────────────────────────────────
# Bildirim Gönderme
# ──────────────────────────────────────────────────────────────────────────────

def send_telegram(token: str, chat_id: str, message: str) -> bool:
    """
    Telegram Bot API üzerinden mesaj gönderir.
    Gerçek HTTP isteği gönderir — mock değil.
    """
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        resp = requests.post(url, json={"chat_id": chat_id, "text": message, "parse_mode": "Markdown"}, timeout=10)
        return resp.ok
    except Exception as e:
        print(f"[AlarmManager] Telegram gönderim hatası: {e}")
        return False


def log_alarm_event(ip: str, label: str, message: str):
    """Gönderilen alarmı alarm_log.json'a kaydeder."""
    log = []
    if os.path.exists(ALARM_LOG_FILE):
        try:
            with open(ALARM_LOG_FILE) as f:
                log = json.load(f)
        except Exception:
            pass
    log.append({"time": time.strftime("%Y-%m-%d %H:%M:%S"), "ip": ip, "label": label, "message": message})
    if len(log) > 200:      # Loga en fazla 200 kayıt tut
        log = log[-200:]
    with open(ALARM_LOG_FILE, "w") as f:
        json.dump(log, f, indent=2)


# ──────────────────────────────────────────────────────────────────────────────
# Ana Kontrol Döngüsü
# ──────────────────────────────────────────────────────────────────────────────

def check_alarms(liveness_status: dict):
    """
    Liveness ping sonuçlarını (ip -> bool) alır ve alarm kurallarını kontrol eder.
    api_network.py içindeki periyodik liveness kontrolünden çağrılır.
    """
    alarms = load_alarms()
    now = time.time()

    # Bakım penceresi kontrolü: Bu IP bakım modundaysa hiç alarm gönderme
    MAINTENANCE_FILE = '/opt/tinc-hub/shared/maintenance.json'
    active_maintenance = set()
    if os.path.exists(MAINTENANCE_FILE):
        try:
            import json as _json
            with open(MAINTENANCE_FILE) as f:
                for m in _json.load(f):
                    active_maintenance.add(m.get('ip', ''))
        except Exception:
            pass

    for rule in alarms:
        if not rule.get("enabled"):
            continue
        # Bu IP bakım modundaysa atla
        if rule["ip"] in active_maintenance or '*' in active_maintenance:
            continue
        ip = rule["ip"]
        is_online = liveness_status.get(ip, True)   # Bilinmiyorsa online say

        if not is_online:
            # Cihaz offline: ilk kez görülüyorsa zamanı kaydet
            if ip not in _offline_since:
                _offline_since[ip] = now

            offline_duration = now - _offline_since[ip]
            threshold = rule.get("threshold_sec", 180)

            # Eşiği aştı ve cooldown süresi geçtiyse bildir
            if offline_duration >= threshold:
                last_notif = _last_notified.get(ip, 0)
                if now - last_notif >= NOTIFY_COOLDOWN:
                    minutes = int(offline_duration // 60)
                    msg = (
                        f"🚨 *Tinc-Hub Alarm*\n\n"
                        f"*Cihaz:* {rule.get('label', ip)} (`{ip}`)\n"
                        f"*Durum:* ❌ ÇEVRIMDIŞI\n"
                        f"*Süredir Kapalı:* {minutes} dakika\n"
                        f"*Zaman:* {time.strftime('%H:%M:%S')}"
                    )
                    if rule["channel"] == "telegram":
                        ok = send_telegram(rule["telegram_token"], rule["telegram_chat_id"], msg)
                        if ok:
                            _last_notified[ip] = now
                            log_alarm_event(ip, rule.get("label", ip), msg)
        else:
            # Cihaz tekrar online: offline kaydını temizle, "geri döndü" bildirimi gönder
            if ip in _offline_since:
                was_offline_sec = int(now - _offline_since[ip])
                del _offline_since[ip]

                last_notif = _last_notified.get(ip, 0)
                if now - last_notif < NOTIFY_COOLDOWN * 2:   # Daha önce alarm gönderildiyse
                    msg = (
                        f"✅ *Tinc-Hub — Cihaz Geri Döndü*\n\n"
                        f"*Cihaz:* {rule.get('label', ip)} (`{ip}`)\n"
                        f"*Durum:* 🟢 ÇEVRIMIÇI\n"
                        f"*Kapalı Kaldı:* {was_offline_sec // 60} dakika {was_offline_sec % 60} saniye\n"
                        f"*Zaman:* {time.strftime('%H:%M:%S')}"
                    )
                    if rule["channel"] == "telegram":
                        send_telegram(rule["telegram_token"], rule["telegram_chat_id"], msg)
                        log_alarm_event(ip, rule.get("label", ip), msg)
