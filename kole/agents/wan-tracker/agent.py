#!/usr/bin/env python3
"""
TINC Köle — WAN Tracker Agent
WAN IP takibi, port erişilebilirlik kontrolü ve latans ölçümü yapar.
"""

import sys
import os
import time
import socket
import subprocess
import threading
import logging
import re
from datetime import datetime, timedelta

import requests
from dotenv import dotenv_values

# ── Shared DB modülü ────────────────────────────────────────────────────────
sys.path.insert(0, '/opt/kole/shared')
from db import init_db, register_agent, heartbeat, log_event, write_metric, record_wan_ip

# ── Sabitler ─────────────────────────────────────────────────────────────────
AGENT_ID      = 'wan-tracker'
AGENT_NAME    = 'WAN Tracker'
AGENT_DESC    = 'WAN IP takibi, port erişilebilirlik kontrolü ve latans ölçümü'
AGENT_VERSION = '1.0.0'

# IP sorgu kaynakları (sırayla denenir, ilk başarılı kullanılır)
WAN_SOURCES = [
    'https://ifconfig.me',
    'https://api.ipify.org',
    'https://icanhazip.com',
]

# Latans ölçümü hedefleri
PING_TARGETS = ['8.8.8.8', '1.1.1.1']

# Port kontrolü aralığı (saniye)
PORT_CHECK_INTERVAL = 600   # 10 dakika

# Heartbeat aralığı (saniye)
HEARTBEAT_INTERVAL = 60

# Günlük rapor saati (yerel saat 06:00)
DAILY_REPORT_HOUR = 6

# ── Loglama ──────────────────────────────────────────────────────────────────
LOG_DIR  = '/var/log/kole'
LOG_FILE = f'{LOG_DIR}/{AGENT_ID}.log'

os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger(AGENT_ID)


# ── Config yükleme ───────────────────────────────────────────────────────────
def load_config() -> dict:
    cfg = dotenv_values('/etc/kole/config.env')
    return cfg


def parse_ports(raw: str) -> list:
    """'22,80,443' gibi virgüllü port listesini parse et."""
    ports = []
    if not raw:
        return ports
    for p in re.split(r'[,\s]+', raw.strip()):
        try:
            ports.append(int(p))
        except ValueError:
            log.warning(f'Geçersiz port değeri atlandı: {p!r}')
    return ports


# ── WAN IP tespiti ───────────────────────────────────────────────────────────
def fetch_wan_ip(timeout=8):
    """Birden fazla kaynaktan WAN IP'yi almaya çalış, ilk başarılı döner."""
    for url in WAN_SOURCES:
        try:
            resp = requests.get(
                url, timeout=timeout,
                headers={'User-Agent': 'kole-wan-tracker/1.0'}
            )
            resp.raise_for_status()
            ip = resp.text.strip()
            # Basit IPv4 doğrulama
            socket.inet_aton(ip)
            log.debug(f'WAN IP alındı ({url}): {ip}')
            return ip
        except Exception as e:
            log.warning(f'WAN IP kaynağı başarısız ({url}): {e}')
    return None


# ── Port erişilebilirlik kontrolü ────────────────────────────────────────────
def check_port(wan_ip, port, timeout=5):
    """Verilen WAN IP ve porta dışarıdan bağlanılabilir mi?"""
    try:
        with socket.create_connection((wan_ip, port), timeout=timeout):
            return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False


def run_port_checks(wan_ip, ports):
    """Tüm portları kontrol et ve metrikleri yaz."""
    if not ports:
        return
    if not wan_ip:
        log.warning('Port kontrolü: WAN IP bilinmiyor, atlandı.')
        return

    log.info(f'Port kontrolü başlıyor → IP: {wan_ip}, portlar: {ports}')
    for port in ports:
        open_ = check_port(wan_ip, port)
        state = 'açık' if open_ else 'kapalı'
        log.info(f'Port {port}: {state}')
        write_metric(AGENT_ID, f'port_{port}_open', value=1.0 if open_ else 0.0)
        log_event(
            AGENT_ID, 'INFO',
            f'Port {port} → {state} ({wan_ip})',
            category='network',
            data={'port': port, 'open': open_, 'wan_ip': wan_ip},
        )


# ── Latans ölçümü ─────────────────────────────────────────────────────────────
def ping_host(host, count=4):
    """
    ping komutuyla ortalama RTT ölç (ms).
    Başarısız olursa None döner.
    """
    try:
        result = subprocess.run(
            ['ping', '-c', str(count), '-W', '3', host],
            capture_output=True, text=True, timeout=20
        )
        if result.returncode != 0:
            log.warning(f'ping başarısız ({host}): exit={result.returncode}')
            return None
        # "rtt min/avg/max/mdev = 1.234/2.345/3.456/0.123 ms" satırını bul
        for line in result.stdout.splitlines():
            m = re.search(
                r'min/avg/max/mdev\s*=\s*[\d.]+/([\d.]+)/[\d.]+/[\d.]+\s*ms',
                line
            )
            if m:
                return float(m.group(1))
        log.warning(f'ping çıktısı parse edilemedi ({host})')
        return None
    except subprocess.TimeoutExpired:
        log.warning(f'ping zaman aşımı ({host})')
        return None
    except Exception as e:
        log.error(f'ping hatası ({host}): {e}')
        return None


def run_latency_checks():
    """Tüm ping hedeflerini kontrol et ve metrikleri yaz."""
    for host in PING_TARGETS:
        rtt = ping_host(host)
        metric_name = f'latency_{host.replace(".", "_")}_ms'
        if rtt is not None:
            log.info(f'Latans {host}: {rtt:.2f} ms')
            write_metric(AGENT_ID, metric_name, value=rtt)
        else:
            log.warning(f'Latans ölçümü başarısız: {host}')
            # Erişilemeyen host için -1 yaz
            write_metric(AGENT_ID, metric_name, value=-1.0)
            log_event(
                AGENT_ID, 'WARN',
                f'{host} adresine ping başarısız',
                category='network',
                data={'host': host},
            )


# ── Günlük rapor ─────────────────────────────────────────────────────────────
def generate_daily_report(wan_history, avg_latencies):
    """Günlük raporu oluştur ve DB'ye yaz."""
    import json

    try:
        from db import get_conn  # noqa — yerel import kasıtlı

        now = datetime.now()
        title = f'WAN Günlük Rapor — {now.strftime("%Y-%m-%d")}'

        ip_changes = len(wan_history)
        ip_list    = [h['ip'] for h in wan_history[:10]]

        content = {
            'date'          : now.strftime('%Y-%m-%d'),
            'ip_changes'    : ip_changes,
            'recent_ips'    : ip_list,
            'avg_latencies' : avg_latencies,
            'generated_at'  : now.isoformat(),
        }

        with _state_lock:
            conn = get_conn()
            conn.execute(
                """INSERT INTO reports (agent_id, report_type, title, content)
                   VALUES (?, 'daily', ?, ?)""",
                (AGENT_ID, title, json.dumps(content, ensure_ascii=False))
            )
            conn.commit()
            conn.close()

        log.info(
            f'Günlük rapor oluşturuldu: IP değişimi={ip_changes}, '
            f'latanslar={avg_latencies}'
        )
        log_event(
            AGENT_ID, 'INFO',
            f'Günlük rapor oluşturuldu — IP değişim sayısı: {ip_changes}',
            category='network',
            data=content,
        )
    except Exception as e:
        log.error(f'Günlük rapor hatası: {e}')


# ── Durum takibi ─────────────────────────────────────────────────────────────
_state_lock      = threading.Lock()
_current_ip      = None
_latency_acc     = {h: [] for h in PING_TARGETS}
_last_report_day = -1   # Son raporun gün numarası


# ── Ana döngü ─────────────────────────────────────────────────────────────────
def main():
    global _current_ip, _last_report_day

    # Config yükle
    cfg            = load_config()
    check_interval = int(cfg.get('WAN_CHECK_INTERVAL', 300))
    raw_ports      = cfg.get('WAN_CHECK_PORTS', '')
    ports          = parse_ports(raw_ports)

    log.info(f'{AGENT_NAME} başlatılıyor — interval={check_interval}s, portlar={ports}')

    # DB başlat ve kaydet
    init_db()
    register_agent(AGENT_ID, AGENT_NAME, AGENT_DESC, AGENT_VERSION)
    log_event(AGENT_ID, 'INFO', f'{AGENT_NAME} başlatıldı', category='network')

    last_heartbeat  = 0.0
    last_port_check = 0.0
    last_wan_check  = 0.0

    while True:
        now_ts = time.time()
        now_dt = datetime.now()

        # ── Heartbeat ──────────────────────────────────────────────────────
        if now_ts - last_heartbeat >= HEARTBEAT_INTERVAL:
            heartbeat(AGENT_ID)
            last_heartbeat = now_ts

        # ── WAN IP + Latans kontrolü ───────────────────────────────────────
        if now_ts - last_wan_check >= check_interval:
            new_ip = fetch_wan_ip()
            last_wan_check = now_ts

            if new_ip:
                write_metric(AGENT_ID, 'wan_ip', value_str=new_ip)

                with _state_lock:
                    old_ip = _current_ip

                if old_ip is None:
                    # İlk çalışma
                    log.info(f'WAN IP (ilk tespit): {new_ip}')
                    log_event(
                        AGENT_ID, 'INFO',
                        f'WAN IP tespit edildi: {new_ip}',
                        category='network',
                        data={'ip': new_ip},
                    )
                elif old_ip != new_ip:
                    # IP değişti — WARN seviyesinde logla
                    log.warning(f'WAN IP değişti: {old_ip} → {new_ip}')
                    log_event(
                        AGENT_ID, 'WARN',
                        f'WAN IP değişti: {old_ip} → {new_ip}',
                        category='network',
                        data={'old_ip': old_ip, 'new_ip': new_ip},
                    )

                # record_wan_ip zaten duplicate önler
                record_wan_ip(new_ip)

                with _state_lock:
                    _current_ip = new_ip
            else:
                log.error('WAN IP alınamadı — tüm kaynaklar başarısız')
                log_event(
                    AGENT_ID, 'ERROR',
                    'WAN IP alınamadı — tüm kaynaklar başarısız',
                    category='network',
                )

            # Her WAN kontrolünde latans ölç
            run_latency_checks()

            # Latans ortalaması için biriktir (günlük rapor için)
            from db import get_latest_metric  # geç import — döngüsel bağımlılık yok
            for host in PING_TARGETS:
                row = get_latest_metric(
                    AGENT_ID, f'latency_{host.replace(".", "_")}_ms'
                )
                if row and row['value'] is not None and row['value'] >= 0:
                    with _state_lock:
                        _latency_acc[host].append(row['value'])
                        # Son 288 ölçümü tut (~24 saat @ 5 dk aralık)
                        if len(_latency_acc[host]) > 288:
                            _latency_acc[host] = _latency_acc[host][-288:]

        # ── Port kontrolü (her 10 dakikada bir) ───────────────────────────
        if now_ts - last_port_check >= PORT_CHECK_INTERVAL:
            with _state_lock:
                current_ip = _current_ip
            run_port_checks(current_ip, ports)
            last_port_check = now_ts

        # ── Günlük rapor (her sabah DAILY_REPORT_HOUR'da) ──────────────────
        if now_dt.hour == DAILY_REPORT_HOUR and now_dt.day != _last_report_day:
            _last_report_day = now_dt.day

            from db import get_wan_history  # geç import
            wan_hist = get_wan_history(limit=100)

            with _state_lock:
                avg_lats = {
                    host: (sum(vals) / len(vals)) if vals else -1.0
                    for host, vals in _latency_acc.items()
                }
            generate_daily_report(wan_hist, avg_lats)

        # Ana döngü polling süresi — en küçük aralığı aşmaz
        time.sleep(10)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log.info(f'{AGENT_NAME} durduruldu (KeyboardInterrupt)')
        log_event(AGENT_ID, 'INFO', f'{AGENT_NAME} durduruldu', category='network')
        sys.exit(0)
    except Exception as exc:
        log.critical(f'{AGENT_NAME} beklenmeyen hata: {exc}', exc_info=True)
        try:
            log_event(
                AGENT_ID, 'CRITICAL',
                f'Agent çöktü: {exc}',
                category='network',
            )
        except Exception:
            pass
        sys.exit(1)
