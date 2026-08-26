#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TINC Köle — Disk Sentinel Agent
Disk doluluk izleme, geçici dosya temizliği, SMART sağlık kontrolü
ve büyük dosya raporlaması yapar.
"""

import os
import sys
import time
import shutil
import logging
import subprocess
from pathlib import Path
from datetime import datetime, timedelta

sys.path.insert(0, '/opt/kole/shared')
from db import init_db, register_agent, heartbeat, log_event, write_metric

from dotenv import dotenv_values

# ---------------------------------------------------------------------------
# Yapılandırma
# ---------------------------------------------------------------------------
config = dotenv_values('/etc/kole/config.env')

AGENT_ID            = 'disk-sentinel'
AGENT_VERSION       = '1.0.0'
HEARTBEAT_INTERVAL  = 60          # saniye

DISK_CHECK_INTERVAL = int(config.get('DISK_CHECK_INTERVAL',    3600))
DISK_WARN_PERCENT   = float(config.get('DISK_WARN_PERCENT',    80))
DISK_CRITICAL_PERCENT = float(config.get('DISK_CRITICAL_PERCENT', 90))
DISK_EXTRA_CLEANUP_DIRS = config.get('DISK_EXTRA_CLEANUP_DIRS', '').split(',')

# Ek temizlik dizinleri (config'den gelen boş string'i filtrele)
DISK_EXTRA_CLEANUP_DIRS = [d.strip() for d in DISK_EXTRA_CLEANUP_DIRS if d.strip()]

CLEANUP_INTERVAL    = 6 * 3600    # 6 saat
SMART_INTERVAL      = 24 * 3600   # 24 saat
BIGFILE_INTERVAL    = 24 * 3600   # 24 saat

TMP_MAX_AGE_HOURS   = 24
LOG_GZ_MAX_AGE_DAYS = 30

LOG_PATH = f'/var/log/kole/{AGENT_ID}.log'

# ---------------------------------------------------------------------------
# Loglama kurulumu
# ---------------------------------------------------------------------------
os.makedirs('/var/log/kole', exist_ok=True)

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
# Yardımcı fonksiyonlar
# ---------------------------------------------------------------------------

def _run(cmd: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """Bir komutu çalıştırır; (returncode, stdout, stderr) döner."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except FileNotFoundError:
        return -1, '', f'Komut bulunamadı: {cmd[0]}'
    except subprocess.TimeoutExpired:
        return -1, '', f'Komut zaman aşımına uğradı: {" ".join(cmd)}'
    except Exception as exc:
        return -1, '', str(exc)


# ---------------------------------------------------------------------------
# 1. Disk kullanım kontrolü
# ---------------------------------------------------------------------------

def check_disk_usage() -> None:
    """Kök dosya sistemi doluluk yüzdesini ölçer ve eşik kontrolü yapar."""
    try:
        usage = shutil.disk_usage('/')
        percent = usage.used / usage.total * 100
        total_gb  = usage.total / (1024 ** 3)
        used_gb   = usage.used  / (1024 ** 3)
        free_gb   = usage.free  / (1024 ** 3)

        log.info(
            f'Disk kullanımı: %{percent:.1f} '
            f'(kullanılan {used_gb:.1f} GB / toplam {total_gb:.1f} GB, '
            f'boş {free_gb:.1f} GB)'
        )

        # Metriği kaydet
        write_metric(AGENT_ID, 'disk_percent', value=round(percent, 2))
        write_metric(AGENT_ID, 'disk_free_gb',  value=round(free_gb, 2))
        write_metric(AGENT_ID, 'disk_total_gb', value=round(total_gb, 2))

        # Eşik kontrolü
        if percent >= DISK_CRITICAL_PERCENT:
            msg = (
                f'KRİTİK disk doluluk: %{percent:.1f} — '
                f'boş alan sadece {free_gb:.1f} GB! '
                f'(eşik: %{DISK_CRITICAL_PERCENT})'
            )
            log.critical(msg)
            log_event(AGENT_ID, 'CRITICAL', msg)
        elif percent >= DISK_WARN_PERCENT:
            msg = (
                f'UYARI disk doluluk: %{percent:.1f} — '
                f'boş alan {free_gb:.1f} GB '
                f'(eşik: %{DISK_WARN_PERCENT})'
            )
            log.warning(msg)
            log_event(AGENT_ID, 'WARN', msg)
        else:
            log_event(AGENT_ID, 'INFO',
                      f'Disk normal: %{percent:.1f}, boş {free_gb:.1f} GB')

    except Exception as exc:
        log.error(f'Disk kullanım kontrolü hatası: {exc}')
        log_event(AGENT_ID, 'ERROR', f'Disk kontrolü başarısız: {exc}')


# ---------------------------------------------------------------------------
# 2. Geçici dosya temizliği
# ---------------------------------------------------------------------------

def _delete_old_files_in(directory: str, older_than_hours: int) -> int:
    """Verilen dizindeki eski dosyaları siler; silinen dosya sayısını döner."""
    deleted = 0
    cutoff = time.time() - older_than_hours * 3600
    try:
        for entry in os.scandir(directory):
            try:
                stat = entry.stat(follow_symlinks=False)
                if stat.st_mtime < cutoff:
                    if entry.is_dir(follow_symlinks=False):
                        shutil.rmtree(entry.path, ignore_errors=True)
                        deleted += 1
                    else:
                        os.unlink(entry.path)
                        deleted += 1
            except PermissionError:
                pass
            except Exception as exc:
                log.debug(f'Dosya silinemedi {entry.path}: {exc}')
    except PermissionError:
        log.warning(f'Dizine erişim yok: {directory}')
    except FileNotFoundError:
        pass
    return deleted


def _clean_pycache(base_dirs: list[str]) -> int:
    """Belirtilen kök dizinler altındaki __pycache__ ve *.pyc dosyalarını siler."""
    deleted = 0
    for base in base_dirs:
        for root, dirs, files in os.walk(base, topdown=True, onerror=None):
            # __pycache__ dizinlerini temizle
            if '__pycache__' in dirs:
                pycache_path = os.path.join(root, '__pycache__')
                try:
                    shutil.rmtree(pycache_path, ignore_errors=True)
                    deleted += 1
                    dirs.remove('__pycache__')
                except Exception:
                    pass
            # *.pyc dosyalarını temizle
            for fname in files:
                if fname.endswith('.pyc'):
                    try:
                        os.unlink(os.path.join(root, fname))
                        deleted += 1
                    except Exception:
                        pass
    return deleted


def _clean_old_gz_logs(log_dir: str = '/var/log', max_age_days: int = 30) -> int:
    """log_dir altındaki eski *.gz log dosyalarını siler."""
    deleted = 0
    cutoff = time.time() - max_age_days * 86400
    try:
        for fpath in Path(log_dir).rglob('*.gz'):
            try:
                if fpath.stat().st_mtime < cutoff:
                    fpath.unlink()
                    deleted += 1
                    log.debug(f'Eski gz log silindi: {fpath}')
            except Exception as exc:
                log.debug(f'gz log silinemedi {fpath}: {exc}')
    except Exception as exc:
        log.warning(f'gz log taraması hatası: {exc}')
    return deleted


def run_cleanup() -> None:
    """Geçici dosya temizlik rutinini çalıştırır."""
    log.info('Geçici dosya temizliği başlıyor…')
    total_deleted = 0

    # /tmp altındaki eski dosyalar
    tmp_deleted = _delete_old_files_in('/tmp', TMP_MAX_AGE_HOURS)
    log.info(f'/tmp temizliği: {tmp_deleted} öğe silindi')
    total_deleted += tmp_deleted

    # Config'den gelen ek dizinler
    for extra_dir in DISK_EXTRA_CLEANUP_DIRS:
        n = _delete_old_files_in(extra_dir, TMP_MAX_AGE_HOURS)
        log.info(f'{extra_dir} temizliği: {n} öğe silindi')
        total_deleted += n

    # __pycache__ ve *.pyc temizliği (sadece /tmp ve /var altında)
    pycache_bases = ['/tmp', '/var']
    pyc_deleted = _clean_pycache(pycache_bases)
    log.info(f'__pycache__/*.pyc temizliği: {pyc_deleted} öğe silindi')
    total_deleted += pyc_deleted

    # Eski sıkıştırılmış loglar
    gz_deleted = _clean_old_gz_logs('/var/log', LOG_GZ_MAX_AGE_DAYS)
    log.info(f'Eski gz log temizliği: {gz_deleted} dosya silindi')
    total_deleted += gz_deleted

    msg = f'Geçici dosya temizliği tamamlandı: toplam {total_deleted} öğe silindi'
    log.info(msg)
    log_event(AGENT_ID, 'INFO', msg)
    write_metric(AGENT_ID, 'cleanup_deleted_items', value=total_deleted)


# ---------------------------------------------------------------------------
# 3. SMART disk sağlık kontrolü
# ---------------------------------------------------------------------------

def _detect_block_devices() -> list[str]:
    """
    /dev/sd* ve /dev/nvme* bloğunu tespit eder.
    Kullanılabilir disk listesini döner.
    """
    devices = []
    dev_path = Path('/dev')
    for pattern in ('sd?', 'nvme?n?'):
        devices.extend(sorted(str(p) for p in dev_path.glob(pattern)))
    return devices or ['/dev/sda']


def check_smart_health() -> None:
    """smartctl ile disk sağlığını kontrol eder."""
    devices = _detect_block_devices()
    log.info(f'SMART kontrolü başlıyor: {devices}')

    for device in devices:
        rc, stdout, stderr = _run(['smartctl', '-H', device], timeout=30)
        dev_short = Path(device).name

        if rc == -1:
            msg = f'smartctl çalıştırılamadı ({device}): {stderr}'
            log.warning(msg)
            log_event(AGENT_ID, 'WARN', msg)
            continue

        # smartctl çıktısında PASSED/FAILED arama
        status = 'UNKNOWN'
        for line in stdout.splitlines():
            upper = line.upper()
            if 'PASSED' in upper or 'OK' in upper:
                status = 'PASSED'
                break
            elif 'FAILED' in upper:
                status = 'FAILED'
                break

        level = 'CRITICAL' if status == 'FAILED' else 'INFO'
        msg   = f'SMART sağlık ({device}): {status}'
        log.info(msg) if level == 'INFO' else log.critical(msg)
        log_event(AGENT_ID, level, msg)

        # 1 = PASSED, 0 = FAILED/UNKNOWN
        write_metric(
            AGENT_ID,
            f'smart_health_{dev_short}',
            value=1 if status == 'PASSED' else 0
        )


# ---------------------------------------------------------------------------
# 4. Büyük dosya raporu
# ---------------------------------------------------------------------------

def report_large_files(scan_path: str = '/home', top_n: int = 10) -> None:
    """
    scan_path altındaki en büyük top_n dosyayı tespit eder ve DB'ye yazar.
    find + sort kullanır (du -sh yerine — daha güvenilir).
    """
    log.info(f'Büyük dosya taraması başlıyor: {scan_path}')
    rc, stdout, stderr = _run(
        ['find', scan_path, '-type', 'f',
         '-printf', '%s\t%p\n'],
        timeout=120
    )
    if rc != 0 and rc != 1:   # rc=1 → izin hataları (normal)
        log.warning(f'Büyük dosya taraması başarısız: {stderr}')
        log_event(AGENT_ID, 'WARN', f'Büyük dosya taraması hatası: {stderr}')
        return

    entries: list[tuple[int, str]] = []
    for line in stdout.splitlines():
        parts = line.split('\t', 1)
        if len(parts) == 2:
            try:
                entries.append((int(parts[0]), parts[1]))
            except ValueError:
                pass

    entries.sort(reverse=True)
    top = entries[:top_n]

    if not top:
        log.info('Büyük dosya bulunamadı veya dizin boş.')
        return

    lines = []
    for size_bytes, fpath in top:
        size_mb = size_bytes / (1024 ** 2)
        lines.append(f'  {size_mb:9.1f} MB  {fpath}')
        write_metric(
            AGENT_ID,
            'large_file_mb',
            value=round(size_mb, 2),
            # tags opsiyonel; db.py destekliyorsa geç
        )

    report = (
        f'En büyük {top_n} dosya ({scan_path}):\n' + '\n'.join(lines)
    )
    log.info(report)
    log_event(AGENT_ID, 'INFO', report)


# ---------------------------------------------------------------------------
# Ana döngü
# ---------------------------------------------------------------------------

def main() -> None:
    log.info(f'{AGENT_ID} v{AGENT_VERSION} başlatılıyor…')

    # DB bağlantısını başlat ve agent'ı kaydet
    init_db()
    register_agent(AGENT_ID, version=AGENT_VERSION)
    log_event(AGENT_ID, 'INFO', f'{AGENT_ID} başlatıldı')

    last_disk_check = 0.0
    last_cleanup    = 0.0
    last_smart      = 0.0
    last_bigfile    = 0.0
    last_heartbeat  = 0.0

    while True:
        now = time.time()

        # Heartbeat
        if now - last_heartbeat >= HEARTBEAT_INTERVAL:
            heartbeat(AGENT_ID)
            last_heartbeat = now

        # Disk kullanım kontrolü
        if now - last_disk_check >= DISK_CHECK_INTERVAL:
            check_disk_usage()
            last_disk_check = now

        # Geçici dosya temizliği (6 saatte bir)
        if now - last_cleanup >= CLEANUP_INTERVAL:
            run_cleanup()
            last_cleanup = now

        # SMART kontrolü (günde bir)
        if now - last_smart >= SMART_INTERVAL:
            check_smart_health()
            last_smart = now

        # Büyük dosya raporu (günde bir)
        if now - last_bigfile >= BIGFILE_INTERVAL:
            report_large_files('/home', top_n=10)
            last_bigfile = now

        # En küçük uyku adımı: 30 saniye
        time.sleep(30)


if __name__ == '__main__':
    main()
