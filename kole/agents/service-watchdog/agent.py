#!/usr/bin/env python3
"""
TINC Köle — Service Watchdog Agent
Systemd servislerini ve Docker container'larını izler.
Başarısız servisleri isteğe bağlı olarak otomatik yeniden başlatır.
"""

import sys
import os
import time
import logging
import subprocess
import socket
import json
import threading
from datetime import datetime, timezone

sys.path.insert(0, '/opt/kole/shared')
from db import init_db, register_agent, heartbeat, log_event, write_metric, update_service_state

from dotenv import dotenv_values

# ---------------------------------------------------------------------------
# Sabitler
# ---------------------------------------------------------------------------
AGENT_ID      = 'service-watchdog'
AGENT_NAME    = 'Service Watchdog'
AGENT_DESC    = "Systemd servislerini ve Docker container'larını izler"
AGENT_VERSION = '1.0.0'

LOG_PATH      = f'/var/log/kole/{AGENT_ID}.log'
DOCKER_SOCK   = '/var/run/docker.sock'

# ---------------------------------------------------------------------------
# Loglama
# ---------------------------------------------------------------------------
os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger(AGENT_ID)

# ---------------------------------------------------------------------------
# Config yükleme
# ---------------------------------------------------------------------------
config = dotenv_values('/etc/kole/config.env')

# İzlenecek servisler: boşlukla veya virgülle ayrılmış liste
_raw_services = config.get('WATCHDOG_SERVICES', 'ssh,cron,rsyslog')
WATCHDOG_SERVICES: list = [
    s.strip() for s in _raw_services.replace(',', ' ').split() if s.strip()
]

CHECK_INTERVAL: int   = int(config.get('WATCHDOG_CHECK_INTERVAL', '60'))
AUTO_RESTART: bool    = config.get('WATCHDOG_AUTO_RESTART', 'true').lower() == 'true'
HEARTBEAT_INTERVAL    = 30      # saniye
DAILY_REPORT_INTERVAL = 86400   # 24 saat

# ---------------------------------------------------------------------------
# Yardımcı: komut çalıştır
# ---------------------------------------------------------------------------

def _run(cmd, timeout=10):
    """Komutu çalıştır; (returncode, stdout, stderr) döndür."""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        log.warning('Komut zaman aşımı: %s', ' '.join(cmd))
        return -1, '', 'timeout'
    except Exception as exc:
        log.error('Komut hatası [%s]: %s', ' '.join(cmd), exc)
        return -1, '', str(exc)


def _systemctl_is_active(service):
    """systemctl is-active <service> çıktısını döndür."""
    _, stdout, _ = _run(['systemctl', 'is-active', service])
    return stdout if stdout else 'unknown'


def _systemctl_show_since(service):
    """Servisin ActiveEnterTimestamp değerini döndür."""
    _, stdout, _ = _run(
        ['systemctl', 'show', service,
         '--property=ActiveEnterTimestamp', '--value']
    )
    return stdout if stdout and stdout != 'n/a' else None


def _systemctl_restart(service):
    """Servisi yeniden başlat; başarı durumunu döndür."""
    rc, _, stderr = _run(['systemctl', 'restart', service], timeout=30)
    if rc != 0:
        log.error('Servis yeniden başlatılamadı [%s]: %s', service, stderr)
    return rc == 0

# ---------------------------------------------------------------------------
# 1. Servis izleme
# ---------------------------------------------------------------------------

def check_services():
    """WATCHDOG_SERVICES listesindeki tüm servisleri kontrol eder."""
    for service in WATCHDOG_SERVICES:
        status = _systemctl_is_active(service)
        since  = _systemctl_show_since(service)
        log.debug('Servis durumu: %s → %s (since=%s)', service, status, since)

        if status == 'failed':
            # Standart kayıt (restart sayacı artmadan)
            update_service_state(service, status, since)

            if AUTO_RESTART:
                log.warning('%s servisi çöktü, yeniden başlatılıyor...', service)
                restarted = _systemctl_restart(service)
                if restarted:
                    new_status = _systemctl_is_active(service)
                    new_since  = _systemctl_show_since(service)
                    log.info('%s yeniden başlatıldı → %s', service, new_status)
                    log_event(
                        AGENT_ID, 'ERROR',
                        f'{service} çöktü, yeniden başlatıldı',
                        category='service',
                        data={'new_status': new_status}
                    )
                    # restart_count artır
                    update_service_state(
                        service, new_status, new_since,
                        increment_restart=True
                    )
                else:
                    log_event(
                        AGENT_ID, 'CRITICAL',
                        f'{service} çöktü ama yeniden başlatılamadı',
                        category='service'
                    )
            else:
                log_event(
                    AGENT_ID, 'ERROR',
                    f'{service} servisi başarısız durumda (auto-restart kapalı)',
                    category='service'
                )
        else:
            # Normal durum kaydı
            update_service_state(service, status, since)

        # Her servis için binary metrik yaz (1=active, 0=diğer)
        metric_name = f'service_{service.replace("-", "_")}_active'
        write_metric(
            AGENT_ID, metric_name,
            value=1.0 if status == 'active' else 0.0
        )

# ---------------------------------------------------------------------------
# 5. Docker container izleme (Unix socket üzerinden HTTP)
# ---------------------------------------------------------------------------

def _unix_socket_connect(sock_path):
    """Ham Unix domain socket bağlantısı döndür."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(sock_path)
    return sock


def _docker_request(path):
    """
    Docker Engine API'ye Unix socket üzerinden GET isteği atar.
    http.client kullanır; requests gerektirmez.
    """
    try:
        import http.client

        class UnixSocketHTTPConnection(http.client.HTTPConnection):
            def connect(self):
                self.sock = _unix_socket_connect(DOCKER_SOCK)

        conn = UnixSocketHTTPConnection('localhost')
        conn.request('GET', path, headers={'Host': 'localhost'})
        resp = conn.getresponse()
        if resp.status == 200:
            return json.loads(resp.read().decode())
        log.warning('Docker API [%s] yanıtı: HTTP %d', path, resp.status)
        return None
    except Exception as exc:
        log.error('Docker API bağlantı hatası: %s', exc)
        return None


def check_docker():
    """Docker container durumlarını kontrol et, metrik yaz."""
    if not os.path.exists(DOCKER_SOCK):
        return  # Docker kurulu/erişilebilir değil

    containers = _docker_request('/containers/json?all=true')
    if containers is None:
        log.warning('Docker container listesi alınamadı')
        return

    running_count = 0
    exited_count  = 0

    for ct in containers:
        state  = ct.get('State', 'unknown')
        names  = ', '.join(ct.get('Names', ['?']))
        image  = ct.get('Image', 'unknown')
        ct_id  = ct.get('Id', '')[:12]

        if state == 'running':
            running_count += 1
        elif state == 'exited':
            exited_count += 1
            exit_status = ct.get('Status', '')  # örn: "Exited (1) 2 hours ago"
            log.warning(
                "Docker container çıkmış: %s [%s] image=%s durum='%s'",
                names, ct_id, image, exit_status
            )
            log_event(
                AGENT_ID, 'WARN',
                f'Docker container çıkmış: {names} ({exit_status})',
                category='service',
                data={
                    'container_id': ct_id,
                    'image':        image,
                    'status':       exit_status
                }
            )

    log.info('Docker: %d çalışıyor, %d çıkmış', running_count, exited_count)
    write_metric(AGENT_ID, 'docker_running_count', value=float(running_count))
    write_metric(AGENT_ID, 'docker_exited_count',  value=float(exited_count))
    write_metric(AGENT_ID, 'docker_total_count',
                 value=float(running_count + exited_count))

# ---------------------------------------------------------------------------
# 6. Boot log özeti (program başlangıcında bir kez)
# ---------------------------------------------------------------------------

def check_boot_errors():
    """
    journalctl -b -p err çıktısını parse et.
    Kritik hata satırları varsa log_event yaz.
    """
    log.info('Boot log özeti alınıyor...')
    rc, stdout, stderr = _run(
        ['journalctl', '-b', '-p', 'err', '--no-pager', '-o', 'short-iso'],
        timeout=20
    )
    if rc != 0:
        log.warning('journalctl çalıştırılamadı: %s', stderr)
        return

    lines = [l for l in stdout.splitlines() if l.strip()]
    if not lines:
        log.info('Boot log özeti: kritik hata yok.')
        log_event(
            AGENT_ID, 'INFO',
            'Sistem başlangıcında kritik hata tespit edilmedi',
            category='service'
        )
        return

    # İlk 20 satırı örnek olarak al (çok uzun olabilir)
    sample_lines = lines[:20]
    summary      = '\n'.join(sample_lines)
    error_count  = len(lines)

    log.warning('Boot log özeti: %d hata satırı bulundu', error_count)
    log_event(
        AGENT_ID, 'WARN',
        f'Sistem başlangıcında {error_count} hata satırı tespit edildi',
        category='service',
        data={
            'total_errors': error_count,
            'sample':       summary[:2000]  # DB'ye max 2000 karakter
        }
    )
    write_metric(AGENT_ID, 'boot_error_count', value=float(error_count))

# ---------------------------------------------------------------------------
# 7. Günlük servis uptime raporu
# ---------------------------------------------------------------------------

def _parse_since_timestamp(since_str):
    """
    systemctl'den gelen 'ActiveEnterTimestamp' değerini datetime'a çevirir.
    Örnek: 'Tue 2026-08-25 10:32:01 UTC'
    """
    if not since_str:
        return None
    formats = [
        '%a %Y-%m-%d %H:%M:%S %Z',
        '%a %Y-%m-%d %H:%M:%S',
        '%Y-%m-%dT%H:%M:%S%z',
        '%Y-%m-%d %H:%M:%S %Z',
    ]
    for fmt in formats:
        try:
            return datetime.strptime(since_str, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def generate_uptime_report():
    """
    İzlenen her servis için uptime hesapla; günlük raporu DB'ye yaz.
    """
    import importlib
    db_mod = importlib.import_module('db')
    get_conn = db_mod.get_conn

    now    = datetime.now(tz=timezone.utc)
    report = {}

    for service in WATCHDOG_SERVICES:
        status    = _systemctl_is_active(service)
        since_str = _systemctl_show_since(service)
        since_dt  = _parse_since_timestamp(since_str) if since_str else None

        if since_dt and status == 'active':
            uptime_sec = (now - since_dt).total_seconds()
            uptime_h   = uptime_sec / 3600
            uptime_str = (
                f'{int(uptime_h // 24)}g '
                f'{int(uptime_h % 24)}s '
                f'{int((uptime_sec % 3600) // 60)}d'
            )
        else:
            uptime_str = (
                'bilinmiyor'
                if status == 'active'
                else f'çalışmıyor ({status})'
            )
            uptime_sec = 0.0

        report[service] = {
            'status':     status,
            'since':      since_str,
            'uptime':     uptime_str,
            'uptime_sec': uptime_sec,
        }

        # Servis başına uptime metriği
        metric_name = f'service_{service.replace("-", "_")}_uptime_sec'
        write_metric(AGENT_ID, metric_name, value=float(uptime_sec))

    # Raporu reports tablosuna yaz
    try:
        with _lock:
            conn = get_conn()
            conn.execute("""
                INSERT INTO reports (agent_id, report_type, title, content)
                VALUES (?, 'daily', ?, ?)
            """, (
                AGENT_ID,
                f'Servis Uptime Raporu — {now.strftime("%Y-%m-%d %H:%M UTC")}',
                json.dumps(report, ensure_ascii=False)
            ))
            conn.commit()
            conn.close()
        log.info('Günlük uptime raporu yazıldı: %d servis', len(report))
    except Exception as exc:
        log.error('Uptime raporu DB yazma hatası: %s', exc)

    log_event(
        AGENT_ID, 'INFO',
        f'Günlük servis uptime raporu oluşturuldu ({len(report)} servis)',
        category='service',
        data=report
    )

# ---------------------------------------------------------------------------
# Thread: heartbeat
# ---------------------------------------------------------------------------
_stop_event = threading.Event()
_lock       = threading.Lock()


def _heartbeat_loop():
    """Her HEARTBEAT_INTERVAL saniyede bir heartbeat gönder."""
    while not _stop_event.is_set():
        try:
            heartbeat(AGENT_ID)
        except Exception as exc:
            log.error('Heartbeat hatası: %s', exc)
        _stop_event.wait(HEARTBEAT_INTERVAL)

# ---------------------------------------------------------------------------
# Ana döngü
# ---------------------------------------------------------------------------

def main():
    log.info('=== %s v%s başlıyor ===', AGENT_NAME, AGENT_VERSION)
    log.info('İzlenen servisler : %s', ', '.join(WATCHDOG_SERVICES))
    log.info('Kontrol aralığı   : %ds', CHECK_INTERVAL)
    log.info('Otomatik restart  : %s', AUTO_RESTART)

    # DB başlat, agent kaydet
    init_db()
    register_agent(AGENT_ID, AGENT_NAME, AGENT_DESC, AGENT_VERSION)

    # Heartbeat thread'ini başlat
    hb_thread = threading.Thread(
        target=_heartbeat_loop, daemon=True, name='heartbeat'
    )
    hb_thread.start()

    # Program başlangıcında bir kez boot log özeti al
    try:
        check_boot_errors()
    except Exception as exc:
        log.error('Boot log özeti hatası: %s', exc)

    # İlk uptime raporunu hemen üret
    last_report_time = time.monotonic()
    try:
        generate_uptime_report()
    except Exception as exc:
        log.error('İlk uptime raporu hatası: %s', exc)

    log.info('Ana döngü başladı.')

    while not _stop_event.is_set():
        cycle_start = time.monotonic()

        # 1. Systemd servisleri kontrol et
        try:
            check_services()
        except Exception as exc:
            log.error('Servis kontrol hatası: %s', exc)

        # 5. Docker container'ları kontrol et
        try:
            check_docker()
        except Exception as exc:
            log.error('Docker kontrol hatası: %s', exc)

        # 7. Günlük uptime raporu (24 saatte bir)
        if time.monotonic() - last_report_time >= DAILY_REPORT_INTERVAL:
            try:
                generate_uptime_report()
            except Exception as exc:
                log.error('Uptime raporu hatası: %s', exc)
            last_report_time = time.monotonic()

        # Bir sonraki döngüye kadar bekle
        elapsed = time.monotonic() - cycle_start
        wait    = max(0.0, CHECK_INTERVAL - elapsed)
        log.debug('Döngü %.2fs sürdü, %.0fs bekleniyor...', elapsed, wait)
        _stop_event.wait(wait)

    log.info('%s durdu.', AGENT_NAME)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log.info('SIGINT alındı, çıkılıyor...')
        _stop_event.set()
    except Exception as exc:
        log.critical('Beklenmeyen hata: %s', exc, exc_info=True)
        sys.exit(1)
