#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TINC Köle — Router Guardian Agent
Görev: Router ve internet bağlantısını izler, gerektiğinde router'ı yeniden başlatır.
"""

import sys
import os
import time
import subprocess
import logging
import base64
import threading
import signal
import re
from datetime import datetime, time as dtime

# Shared DB modülü
sys.path.insert(0, '/opt/kole/shared')
from db import init_db, register_agent, heartbeat, log_event, write_metric

import requests
import urllib3
from dotenv import dotenv_values

# SSL uyarılarını kapat (router self-signed cert için)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ──────────────────────────────────────────────
# Sabitler
# ──────────────────────────────────────────────
AGENT_ID        = 'router-guardian'
AGENT_VERSION   = '1.0.0'
LOG_FILE        = f'/var/log/kole/{AGENT_ID}.log'
PING_TARGETS    = ['192.168.1.1', '8.8.8.8']
CONSECUTIVE_FAIL_THRESHOLD = 3   # Kaç ardışık başarısız ping sonrası reboot
HEARTBEAT_INTERVAL         = 30  # saniye
WAN_CHECK_URL              = 'https://ifconfig.me'
ROUTER_REBOOT_ENDPOINT     = '/cgi-bin/Reboot'
ROUTER_LOGIN_ENDPOINT      = '/cgi-bin/luci/rpc/auth'  # Gerekirse override edilir
DEFAULT_PING_INTERVAL      = 60
DEFAULT_REBOOT_CRON        = '06:00'
HTTP_TIMEOUT               = 10  # saniye

# ──────────────────────────────────────────────
# Loglama kurulumu
# ──────────────────────────────────────────────
os.makedirs('/var/log/kole', exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger(AGENT_ID)


# ──────────────────────────────────────────────
# Config yükleme
# ──────────────────────────────────────────────
config = dotenv_values('/etc/kole/config.env')

ROUTER_IP             = config.get('ROUTER_IP', '192.168.1.1')
ROUTER_USER           = config.get('ROUTER_USER', 'admin')
ROUTER_PASS           = config.get('ROUTER_PASS', 'admin')
ROUTER_PING_INTERVAL  = int(config.get('ROUTER_PING_INTERVAL', DEFAULT_PING_INTERVAL))
ROUTER_REBOOT_CRON    = config.get('ROUTER_REBOOT_CRON', DEFAULT_REBOOT_CRON)
ROUTER_SMART_REBOOT   = config.get('ROUTER_SMART_REBOOT', 'true').lower() == 'true'

# ──────────────────────────────────────────────
# Durum değişkenleri
# ──────────────────────────────────────────────
consecutive_failures = 0    # Ardışık başarısız ping sayısı
last_wan_ip          = None # Önceki döngüde alınan WAN IP
reboot_in_progress   = False
last_scheduled_reboot_date = None  # Bugün scheduled reboot yapıldı mı?
shutdown_flag        = threading.Event()


# ──────────────────────────────────────────────
# Yardımcı fonksiyonlar
# ──────────────────────────────────────────────

def db_log(level: str, message: str, extra: dict = None):
    """Hem Python logger'a hem DB'ye log yazar."""
    getattr(log, level.lower(), log.info)(message)
    try:
        log_event(AGENT_ID, level.upper(), message, extra=extra)
    except Exception as e:
        log.warning(f"DB log_event başarısız: {e}")


def ping_host(host: str, count: int = 1, timeout: int = 3) -> tuple[bool, float]:
    """
    Verilen hostu ping atar.
    Döner: (başarılı mı, ms cinsinden süre veya -1)
    """
    try:
        start = time.monotonic()
        result = subprocess.run(
            ['ping', '-c', str(count), '-W', str(timeout), host],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout + 2
        )
        elapsed_ms = (time.monotonic() - start) * 1000

        if result.returncode == 0:
            # ping çıktısından ms değerini parse etmeye çalış
            output = result.stdout.decode()
            match = re.search(r'time[=<]([\d.]+)\s*ms', output)
            if match:
                elapsed_ms = float(match.group(1))
            return True, round(elapsed_ms, 2)
        return False, -1.0
    except subprocess.TimeoutExpired:
        return False, -1.0
    except Exception as e:
        log.warning(f"Ping hatası ({host}): {e}")
        return False, -1.0


def check_internet() -> tuple[bool, float]:
    """
    8.8.8.8 ve 192.168.1.1'e ping atar.
    Döner: (internet var mı, ortalama ping ms)
    """
    results = []
    for host in PING_TARGETS:
        success, ms = ping_host(host)
        results.append((success, ms))
        log.debug(f"Ping {host}: {'OK' if success else 'FAIL'} {ms}ms")

    # Sadece 8.8.8.8 başarılıysa internet var sayılır
    internet_ok = results[1][0]  # 8.8.8.8 index 1
    avg_ms = sum(ms for _, ms in results if ms > 0) / max(1, sum(1 for s, _ in results if s))
    return internet_ok, round(avg_ms, 2)


def get_wan_ip() -> str | None:
    """curl ile WAN IP'yi alır."""
    try:
        result = subprocess.run(
            ['curl', '-s', '--max-time', '5', WAN_CHECK_URL],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=8
        )
        ip = result.stdout.decode().strip()
        # Basit IPv4 doğrulama
        if re.match(r'^\d{1,3}(\.\d{1,3}){3}$', ip):
            return ip
        return None
    except Exception as e:
        log.warning(f"WAN IP alınamadı: {e}")
        return None


def record_wan_ip(ip: str):
    """WAN IP değişimini kaydeder."""
    try:
        write_metric(AGENT_ID, 'wan_ip', value_str=ip)
    except Exception as e:
        log.warning(f"write_metric(wan_ip) başarısız: {e}")


def router_login(session: requests.Session) -> bool:
    """
    Router'a HTTPS üzerinden login olur.
    Kullanıcı adı/şifre base64 ile encode edilir.
    Birden fazla login yöntemi denenir (Basic Auth + form POST).
    """
    url_base = f"https://{ROUTER_IP}"
    cred_b64 = base64.b64encode(f"{ROUTER_USER}:{ROUTER_PASS}".encode()).decode()

    # Yöntem 1: HTTP Basic Auth
    try:
        resp = session.get(
            f"{url_base}/",
            auth=(ROUTER_USER, ROUTER_PASS),
            verify=False,
            timeout=HTTP_TIMEOUT
        )
        if resp.status_code in (200, 302):
            log.info("Router login başarılı (Basic Auth).")
            return True
    except Exception as e:
        log.debug(f"Basic Auth denemesi başarısız: {e}")

    # Yöntem 2: Form POST login (OpenWRT / genel router)
    try:
        login_payload = {
            'username': ROUTER_USER,
            'password': ROUTER_PASS,
        }
        headers = {
            'Authorization': f'Basic {cred_b64}',
            'Content-Type': 'application/x-www-form-urlencoded',
        }
        resp = session.post(
            f"{url_base}/cgi-bin/login",
            data=login_payload,
            headers=headers,
            verify=False,
            timeout=HTTP_TIMEOUT,
            allow_redirects=True
        )
        if resp.status_code in (200, 302):
            log.info("Router login başarılı (Form POST).")
            return True
    except Exception as e:
        log.debug(f"Form POST login denemesi başarısız: {e}")

    log.error("Router login başarısız. Tüm yöntemler denendi.")
    return False


def trigger_router_reboot() -> bool:
    """
    Router'a login olup reboot endpoint'ini çağırır.
    Döner: reboot isteği gönderildi mi?
    """
    db_log('warning', "Router reboot tetikleniyor...")
    session = requests.Session()
    session.verify = False

    if not router_login(session):
        db_log('error', "Reboot iptal: Login başarısız.")
        return False

    url_reboot = f"https://{ROUTER_IP}{ROUTER_REBOOT_ENDPOINT}"
    try:
        resp = session.post(url_reboot, verify=False, timeout=HTTP_TIMEOUT)
        if resp.status_code in (200, 204, 302):
            db_log('warning', f"Reboot isteği gönderildi → HTTP {resp.status_code}")
            return True
        else:
            db_log('error', f"Reboot isteği başarısız → HTTP {resp.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        # Router reboot olduğunda bağlantı kopabilir, bu normal
        db_log('warning', "Reboot isteği sonrası bağlantı koptu (beklenen davranış).")
        return True
    except Exception as e:
        db_log('error', f"Reboot isteği sırasında hata: {e}")
        return False


def measure_recovery_time(max_wait: int = 300, check_interval: int = 5) -> int:
    """
    Router reboot sonrası internet bağlantısının kaç saniyede geldiğini ölçer.
    max_wait: Maksimum bekleme süresi (saniye)
    Döner: recovery süresi saniye cinsinden (-1 = timeout)
    """
    db_log('info', f"Recovery izleniyor (maks {max_wait}s)...")
    start = time.monotonic()
    # Önce router'ın kapanması için biraz bekle
    time.sleep(15)

    while (time.monotonic() - start) < max_wait:
        if shutdown_flag.is_set():
            break
        ok, _ = check_internet()
        if ok:
            elapsed = int(time.monotonic() - start)
            db_log('info', f"İnternet geri geldi! Recovery süresi: {elapsed}s")
            return elapsed
        time.sleep(check_interval)

    db_log('error', f"İnternet {max_wait}s içinde geri gelmedi!")
    return -1


def should_run_scheduled_reboot() -> bool:
    """
    ROUTER_REBOOT_CRON saatine (HH:MM) göre scheduled reboot zamanı geldi mi?
    Bugün zaten yapıldıysa tekrar yapmaz.
    """
    global last_scheduled_reboot_date
    try:
        hour, minute = map(int, ROUTER_REBOOT_CRON.split(':'))
        now = datetime.now()
        scheduled_time = dtime(hour, minute)
        now_time = now.time()
        today = now.date()

        # Saat geldi ve bugün henüz yapılmadıysa
        window_start = dtime(hour, minute)
        window_end   = dtime(hour, minute + 2 if minute < 58 else 59)

        if window_start <= now_time <= window_end and last_scheduled_reboot_date != today:
            return True
    except Exception as e:
        log.warning(f"Scheduled reboot zaman kontrolü hatası: {e}")
    return False


def do_reboot_cycle(reason: str):
    """Reboot döngüsünü yönetir: reboot → recovery ölçümü → metrik yaz."""
    global reboot_in_progress, consecutive_failures, last_scheduled_reboot_date

    if reboot_in_progress:
        log.warning("Reboot zaten devam ediyor, atlanıyor.")
        return

    reboot_in_progress = True
    try:
        db_log('warning', f"Reboot başlatılıyor. Sebep: {reason}")
        success = trigger_router_reboot()

        if success:
            recovery_s = measure_recovery_time()
            write_metric(AGENT_ID, 'reboot_recovery_s', value=recovery_s if recovery_s > 0 else 999)
            db_log('info', f"Reboot tamamlandı. Recovery: {recovery_s}s | Sebep: {reason}")
            consecutive_failures = 0  # Sıfırla

            if reason == 'scheduled':
                last_scheduled_reboot_date = datetime.now().date()
        else:
            db_log('error', "Reboot tetiklenemedi.")
    finally:
        reboot_in_progress = False


# ──────────────────────────────────────────────
# Heartbeat thread
# ──────────────────────────────────────────────

def heartbeat_loop():
    """Her HEARTBEAT_INTERVAL saniyede bir heartbeat gönderir."""
    while not shutdown_flag.is_set():
        try:
            heartbeat(AGENT_ID)
        except Exception as e:
            log.warning(f"Heartbeat hatası: {e}")
        shutdown_flag.wait(HEARTBEAT_INTERVAL)


# ──────────────────────────────────────────────
# Sinyal yönetimi
# ──────────────────────────────────────────────

def handle_signal(signum, frame):
    log.info(f"Sinyal alındı ({signum}), kapatılıyor...")
    shutdown_flag.set()


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT,  handle_signal)


# ──────────────────────────────────────────────
# Ana döngü
# ──────────────────────────────────────────────

def main():
    global consecutive_failures, last_wan_ip

    # DB başlat
    init_db()

    # Agent'ı kaydet
    register_agent(
        agent_id=AGENT_ID,
        name='Router Guardian',
        version=AGENT_VERSION,
        description='Router ve internet bağlantısını izler, gerektiğinde yeniden başlatır.',
    )

    db_log('info', (
        f"Router Guardian başlatıldı | "
        f"Router: {ROUTER_IP} | "
        f"Ping aralığı: {ROUTER_PING_INTERVAL}s | "
        f"Smart reboot: {ROUTER_SMART_REBOOT} | "
        f"Scheduled reboot: {ROUTER_REBOOT_CRON}"
    ))

    # Heartbeat thread'i başlat
    hb_thread = threading.Thread(target=heartbeat_loop, daemon=True, name='heartbeat')
    hb_thread.start()

    # ── Ana kontrol döngüsü ──
    while not shutdown_flag.is_set():
        loop_start = time.monotonic()

        # 1) İnternet bağlantısı kontrolü
        internet_ok, ping_ms = check_internet()

        if internet_ok:
            if consecutive_failures > 0:
                db_log('info', f"Bağlantı geri geldi. (Önceki hata sayısı: {consecutive_failures})")
            consecutive_failures = 0
            log.info(f"İnternet OK | Ping: {ping_ms}ms")
        else:
            consecutive_failures += 1
            db_log('warning', f"İnternet YOK! Ardışık hata: {consecutive_failures}/{CONSECUTIVE_FAIL_THRESHOLD}")

        # 2) Ping metriğini yaz
        try:
            write_metric(AGENT_ID, 'ping_ms', value=ping_ms if internet_ok else -1)
        except Exception as e:
            log.warning(f"write_metric(ping_ms) hatası: {e}")

        # 3) WAN IP kontrolü
        wan_ip = get_wan_ip()
        if wan_ip:
            if wan_ip != last_wan_ip:
                if last_wan_ip is not None:
                    db_log('warning', f"WAN IP değişti: {last_wan_ip} → {wan_ip}")
                else:
                    db_log('info', f"WAN IP tespit edildi: {wan_ip}")
                record_wan_ip(wan_ip)
                last_wan_ip = wan_ip
            else:
                log.debug(f"WAN IP aynı: {wan_ip}")

            try:
                write_metric(AGENT_ID, 'wan_ip', value_str=wan_ip)
            except Exception as e:
                log.warning(f"write_metric(wan_ip) hatası: {e}")
        else:
            log.warning("WAN IP alınamadı.")

        # 4) Ardışık hata → reboot tetikle
        if ROUTER_SMART_REBOOT and consecutive_failures >= CONSECUTIVE_FAIL_THRESHOLD:
            db_log('error', f"Ardışık {consecutive_failures} başarısız ping! Reboot tetikleniyor...")
            reboot_thread = threading.Thread(
                target=do_reboot_cycle,
                args=('connection_loss',),
                daemon=True,
                name='reboot'
            )
            reboot_thread.start()
            # Reboot döngüsü tamamlanana kadar bekle
            reboot_thread.join(timeout=360)

        # 5) Scheduled reboot kontrolü
        if should_run_scheduled_reboot():
            db_log('info', f"Zamanlanmış reboot ({ROUTER_REBOOT_CRON}) çalıştırılıyor...")
            reboot_thread = threading.Thread(
                target=do_reboot_cycle,
                args=('scheduled',),
                daemon=True,
                name='scheduled-reboot'
            )
            reboot_thread.start()
            reboot_thread.join(timeout=360)

        # 6) Döngü süresi ayarı (ping interval'e göre bekle)
        elapsed = time.monotonic() - loop_start
        sleep_time = max(0, ROUTER_PING_INTERVAL - elapsed)
        log.debug(f"Döngü süresi: {elapsed:.1f}s | Bekleme: {sleep_time:.1f}s")
        shutdown_flag.wait(sleep_time)

    db_log('info', "Router Guardian kapatıldı.")


if __name__ == '__main__':
    main()
