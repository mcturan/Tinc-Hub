#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TINC Köle — RAM Cleaner Agent
RAM/Swap izleme, swap temizleme, zombie process temizleme,
büyüyen process tespiti ve Ollama boşaltma işlemlerini yapar.
"""

import sys
import os
import time
import signal
import subprocess
import logging

sys.path.insert(0, '/opt/kole/shared')
from db import init_db, register_agent, heartbeat, log_event, write_metric

from dotenv import dotenv_values
import psutil

# ---------------------------------------------------------------------------
# Sabitler ve yapılandırma
# ---------------------------------------------------------------------------
AGENT_ID    = 'ram-cleaner'
LOG_FILE    = f'/var/log/kole/{AGENT_ID}.log'
CONFIG_FILE = '/etc/kole/config.env'

# Loglama ayarları
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

# ---------------------------------------------------------------------------
# Config yükleme
# ---------------------------------------------------------------------------
config = dotenv_values(CONFIG_FILE)

RAM_WARN_PERCENT     = float(config.get('RAM_WARN_PERCENT',    85))
RAM_CHECK_INTERVAL   = int(config.get('RAM_CHECK_INTERVAL',   300))
SWAP_CLEAN_THRESHOLD = float(config.get('SWAP_CLEAN_THRESHOLD', 70))
OLLAMA_SERVICE       = config.get('OLLAMA_SERVICE', '')   # örn: 'ollama'

# Sabit eşikler
RAM_CRITICAL_PERCENT  = 90.0  # Ollama boşaltma için kriz seviyesi
HEARTBEAT_INTERVAL    = 60    # saniye
ZOMBIE_CHECK_INTERVAL = 300   # 5 dakikada bir zombie taraması
TOP_PROC_COUNT        = 5     # en yüksek RAM kullanan process sayısı
OLLAMA_RESTART_DELAY  = 600   # Ollama yeniden başlatma gecikmesi (10 dakika)

# ---------------------------------------------------------------------------
# Yardımcı fonksiyonlar
# ---------------------------------------------------------------------------

def run_cmd(cmd: list, timeout: int = 60) -> tuple:
    """Komutu çalıştır, (returncode, stdout, stderr) döndür."""
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except subprocess.TimeoutExpired:
        log.error(f"Komut zaman aşımına uğradı: {' '.join(cmd)}")
        return -1, '', 'timeout'
    except Exception as exc:
        log.error(f"Komut çalıştırma hatası ({' '.join(cmd)}): {exc}")
        return -1, '', str(exc)


def get_ram_info() -> tuple:
    """RAM ve Swap kullanım yüzdelerini döndür."""
    ram  = psutil.virtual_memory()
    swap = psutil.swap_memory()
    return ram.percent, swap.percent


def get_swap_used_mb() -> float:
    """Kullanılan Swap miktarını MB cinsinden döndür."""
    return psutil.swap_memory().used / (1024 * 1024)


# ---------------------------------------------------------------------------
# Temel kontrol döngüsü işlemleri
# ---------------------------------------------------------------------------

def check_and_write_metrics() -> tuple:
    """RAM/Swap metriklerini ölç ve DB'ye yaz. (ram_pct, swap_pct) döndür."""
    ram_pct, swap_pct = get_ram_info()
    write_metric(AGENT_ID, 'ram_percent',  value=ram_pct)
    write_metric(AGENT_ID, 'swap_percent', value=swap_pct)
    log.info(f"RAM: {ram_pct:.1f}%  Swap: {swap_pct:.1f}%")
    return ram_pct, swap_pct


def check_ram_warn(ram_pct: float) -> None:
    """RAM uyarı eşiği aşılırsa WARN log_event yaz."""
    if ram_pct >= RAM_WARN_PERCENT:
        msg = f"RAM kullanımı yüksek: {ram_pct:.1f}% (eşik: {RAM_WARN_PERCENT}%)"
        log.warning(msg)
        log_event(AGENT_ID, 'WARN', msg)


def clean_swap_if_needed(swap_pct: float) -> None:
    """Swap eşiği aşılmışsa swapoff/swapon ile temizle."""
    if swap_pct < SWAP_CLEAN_THRESHOLD:
        return

    before_mb = get_swap_used_mb()
    log.info(
        f"Swap temizleme başlıyor — önce: {before_mb:.1f} MB "
        f"({swap_pct:.1f}% >= eşik {SWAP_CLEAN_THRESHOLD}%)"
    )
    log_event(AGENT_ID, 'INFO', f"Swap temizleme başladı. Önce: {before_mb:.1f} MB")

    rc_off, _, err_off = run_cmd(['swapoff', '-a'])
    if rc_off != 0:
        log.error(f"swapoff başarısız: {err_off}")
        log_event(AGENT_ID, 'ERROR', f"swapoff başarısız: {err_off}")
        return

    rc_on, _, err_on = run_cmd(['swapon', '-a'])
    if rc_on != 0:
        log.error(f"swapon başarısız: {err_on}")
        log_event(AGENT_ID, 'ERROR', f"swapon başarısız: {err_on}")
        return

    after_mb = get_swap_used_mb()
    freed_mb = before_mb - after_mb
    msg = (
        f"Swap temizleme tamamlandı. "
        f"Önce: {before_mb:.1f} MB -> Sonra: {after_mb:.1f} MB "
        f"(Boşaltılan: {freed_mb:.1f} MB)"
    )
    log.info(msg)
    log_event(AGENT_ID, 'INFO', msg)
    write_metric(AGENT_ID, 'swap_freed_mb', value=freed_mb)


def clean_zombies() -> None:
    """
    Zombie process'leri tespit et, parent'larına SIGCHLD gönder
    ve listeyi DB'ye yaz.
    """
    zombies = []

    for proc in psutil.process_iter(['pid', 'name', 'status', 'ppid']):
        try:
            if proc.info['status'] == psutil.STATUS_ZOMBIE:
                zombies.append({
                    'pid':  proc.info['pid'],
                    'name': proc.info['name'],
                    'ppid': proc.info['ppid'],
                })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    if not zombies:
        log.info("Zombie process bulunamadı.")
        return

    log.warning(f"{len(zombies)} zombie process tespit edildi.")
    reaped = 0

    for z in zombies:
        ppid = z['ppid']
        pid  = z['pid']
        try:
            if ppid and ppid > 1:
                os.kill(ppid, signal.SIGCHLD)
                log.info(
                    f"SIGCHLD gönderildi -> parent PID {ppid} "
                    f"(zombie: {z['name']} PID {pid})"
                )
                reaped += 1
            else:
                # Parent init/systemd — direkt waitpid dene
                try:
                    os.waitpid(pid, os.WNOHANG)
                    reaped += 1
                except ChildProcessError:
                    pass
        except (ProcessLookupError, PermissionError) as exc:
            log.warning(f"PID {ppid} için SIGCHLD gönderilemedi: {exc}")

    zombie_list_str = ', '.join(
        f"{z['name']}({z['pid']})" for z in zombies
    )
    msg = (
        f"Zombie temizliği: {len(zombies)} tespit, {reaped} reap denendi. "
        f"Liste: [{zombie_list_str}]"
    )
    log.info(msg)
    log_event(AGENT_ID, 'INFO', msg)
    write_metric(AGENT_ID, 'zombie_count', value=len(zombies))


def track_top_processes() -> None:
    """RAM kullanımı en yüksek N process'i tespit et ve metrik yaz."""
    procs = []

    for proc in psutil.process_iter(['pid', 'name', 'memory_percent']):
        try:
            mem_pct = proc.info['memory_percent']
            if mem_pct is None:
                continue
            procs.append({
                'pid':     proc.info['pid'],
                'name':    proc.info['name'],
                'mem_pct': mem_pct,
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    top = sorted(procs, key=lambda p: p['mem_pct'], reverse=True)[:TOP_PROC_COUNT]

    for rank, p in enumerate(top, start=1):
        metric_key = f'top{rank}_mem_pct'
        write_metric(AGENT_ID, metric_key, value=round(p['mem_pct'], 2))
        log.debug(
            f"  #{rank}: {p['name']} (PID {p['pid']}) — {p['mem_pct']:.2f}%"
        )

    top_str = ', '.join(
        f"{p['name']}({p['mem_pct']:.1f}%)" for p in top
    )
    log.info(f"En yüksek RAM kullanan {TOP_PROC_COUNT} process: {top_str}")


# ---------------------------------------------------------------------------
# Ollama yönetimi
# ---------------------------------------------------------------------------

# Ollama yeniden başlatma zamanını takip eden global değişken
_ollama_restart_at = 0.0   # epoch saniyesi; 0 -> bekleyen restart yok
_ollama_stopped    = False


def maybe_stop_ollama(ram_pct: float) -> None:
    """RAM kritik seviyedeyse Ollama servisini durdur."""
    global _ollama_stopped, _ollama_restart_at

    if not OLLAMA_SERVICE:
        return

    if ram_pct >= RAM_CRITICAL_PERCENT and not _ollama_stopped:
        log.warning(
            f"RAM kritik ({ram_pct:.1f}%) — {OLLAMA_SERVICE} durduruluyor..."
        )
        rc, _, err = run_cmd(['systemctl', 'stop', OLLAMA_SERVICE])
        if rc == 0:
            _ollama_stopped    = True
            _ollama_restart_at = time.time() + OLLAMA_RESTART_DELAY
            msg = (
                f"RAM kritik ({ram_pct:.1f}%): {OLLAMA_SERVICE} durduruldu. "
                f"{OLLAMA_RESTART_DELAY // 60} dakika sonra yeniden başlatılacak."
            )
            log.info(msg)
            log_event(AGENT_ID, 'WARN', msg)
        else:
            log.error(f"{OLLAMA_SERVICE} durdurulamadı: {err}")
            log_event(AGENT_ID, 'ERROR', f"{OLLAMA_SERVICE} durdurulamadı: {err}")


def maybe_restart_ollama() -> None:
    """Bekleme süresi dolduysa Ollama servisini yeniden başlat."""
    global _ollama_stopped, _ollama_restart_at

    if not OLLAMA_SERVICE:
        return
    if not _ollama_stopped:
        return
    if time.time() < _ollama_restart_at:
        remaining = int(_ollama_restart_at - time.time())
        log.debug(f"{OLLAMA_SERVICE} yeniden başlatmasına {remaining}s kaldı.")
        return

    log.info(f"{OLLAMA_SERVICE} yeniden başlatılıyor...")
    rc, _, err = run_cmd(['systemctl', 'start', OLLAMA_SERVICE])
    if rc == 0:
        _ollama_stopped    = False
        _ollama_restart_at = 0.0
        msg = f"{OLLAMA_SERVICE} başarıyla yeniden başlatıldı."
        log.info(msg)
        log_event(AGENT_ID, 'INFO', msg)
    else:
        log.error(f"{OLLAMA_SERVICE} yeniden başlatılamadı: {err}")
        log_event(AGENT_ID, 'ERROR', f"{OLLAMA_SERVICE} yeniden başlatılamadı: {err}")
        # Bir sonraki döngüde tekrar dene
        _ollama_restart_at = time.time() + 60


# ---------------------------------------------------------------------------
# Ana döngü
# ---------------------------------------------------------------------------

def main() -> None:
    log.info(f"=== {AGENT_ID} agent başlatılıyor ===")
    log.info(
        f"Config — RAM_WARN: {RAM_WARN_PERCENT}%  "
        f"SWAP_THRESHOLD: {SWAP_CLEAN_THRESHOLD}%  "
        f"INTERVAL: {RAM_CHECK_INTERVAL}s  "
        f"OLLAMA: '{OLLAMA_SERVICE or 'devre dışı'}'"
    )

    init_db()
    register_agent(
        agent_id=AGENT_ID,
        description='RAM/Swap izleme, swap temizleme, zombie reaping, process takibi',
    )
    log_event(AGENT_ID, 'INFO', f'{AGENT_ID} agent başlatıldı.')

    last_heartbeat    = 0.0
    last_zombie_check = 0.0

    while True:
        now = time.time()

        # ── Heartbeat (her 60 saniyede bir) ──────────────────────────────
        if now - last_heartbeat >= HEARTBEAT_INTERVAL:
            heartbeat(AGENT_ID)
            last_heartbeat = now

        # ── Ana RAM/Swap kontrolü ─────────────────────────────────────────
        try:
            ram_pct, swap_pct = check_and_write_metrics()
            check_ram_warn(ram_pct)
            clean_swap_if_needed(swap_pct)
            track_top_processes()
            maybe_stop_ollama(ram_pct)
            maybe_restart_ollama()
        except Exception as exc:
            log.exception(f"Ana kontrol döngüsünde hata: {exc}")
            log_event(AGENT_ID, 'ERROR', f"Ana kontrol döngüsünde hata: {exc}")

        # ── Zombie temizliği (her 5 dakikada bir) ────────────────────────
        if now - last_zombie_check >= ZOMBIE_CHECK_INTERVAL:
            try:
                clean_zombies()
            except Exception as exc:
                log.exception(f"Zombie temizliği sırasında hata: {exc}")
                log_event(AGENT_ID, 'ERROR', f"Zombie temizliği hatası: {exc}")
            last_zombie_check = now

        # ── Sonraki kontrol için bekle ────────────────────────────────────
        # Heartbeat ve zombie kontrol zamanlaması için uyku süresini kıs
        sleep_time = min(RAM_CHECK_INTERVAL, HEARTBEAT_INTERVAL)
        log.debug(f"Sonraki kontrol için {sleep_time}s bekleniyor...")
        time.sleep(sleep_time)


if __name__ == '__main__':
    main()
