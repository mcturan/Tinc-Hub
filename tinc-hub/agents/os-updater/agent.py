#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tinc Hub — OS Updater Agent
İşletim sistemi paket güncellemelerini otomatik yapar.
Başlangıçta bir kez çalışır, ardından ayarlanan periyotta tekrar eder.
"""

import sys
import os
import time
import signal
import subprocess
import logging
from datetime import datetime

sys.path.insert(0, '/opt/tinc-hub/shared')
from db import init_db, register_agent, heartbeat, log_event

from dotenv import dotenv_values

AGENT_ID    = 'os-updater'
LOG_FILE    = f'/var/log/tinc-hub/{AGENT_ID}.log'
CONFIG_FILE = '/etc/tinc-hub/config.env'

os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
console = logging.StreamHandler()
console.setLevel(logging.INFO)
formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')
console.setFormatter(formatter)
logging.getLogger('').addHandler(console)

running = True

def signal_handler(sig, frame):
    global running
    logging.info("Kapatma sinyali alindi, cikis yapiliyor...")
    running = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

def load_config():
    if os.path.exists(CONFIG_FILE):
        return dotenv_values(CONFIG_FILE)
    return {}

def run_updates():
    logging.info("Sistem guncellemeleri (apt update && apt upgrade) basliyor...")
    log_event(AGENT_ID, "UPDATE_START", "Sistem guncellemesi baslatildi.")
    try:
        # Update
        p_update = subprocess.run(["apt-get", "update"], capture_output=True, text=True)
        if p_update.returncode != 0:
            logging.error(f"apt update hatasi: {p_update.stderr}")
            log_event(AGENT_ID, "UPDATE_ERROR", f"apt update hatasi: {p_update.stderr}")
            return False
            
        # Upgrade (non-interactive)
        env = os.environ.copy()
        env["DEBIAN_FRONTEND"] = "noninteractive"
        p_upgrade = subprocess.run(
            ["apt-get", "upgrade", "-y", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"],
            env=env,
            capture_output=True,
            text=True
        )
        if p_upgrade.returncode == 0:
            logging.info("Sistem guncellemeleri basariyla tamamlandi.")
            log_event(AGENT_ID, "UPDATE_SUCCESS", "Sistem guncellemeleri basariyla tamamlandi.")
            return True
        else:
            logging.error(f"apt upgrade hatasi: {p_upgrade.stderr}")
            log_event(AGENT_ID, "UPDATE_ERROR", f"apt upgrade hatasi: {p_upgrade.stderr}")
            return False
    except Exception as e:
        logging.error(f"Guncelleme sirasinda beklenmeyen hata: {e}")
        log_event(AGENT_ID, "UPDATE_CRITICAL", str(e))
        return False

def main():
    logging.info(f"{AGENT_ID} baslatiliyor...")
    init_db()
    register_agent(AGENT_ID)
    
    # Başlangıçta hemen güncelleme yap (kullanıcı "Yeniden Başlat"a basınca hemen çalışması için)
    run_updates()
    
    while running:
        cfg = load_config()
        interval = int(cfg.get("OS_UPDATE_INTERVAL", 86400)) # Default 24 hours
        
        heartbeat(AGENT_ID, f"Beklemede. Periyot: {interval} sn.")
        
        # Sleep loops allow quicker termination
        slept = 0
        while slept < interval and running:
            time.sleep(10)
            slept += 10
            
            if slept % 60 == 0:
                heartbeat(AGENT_ID, "Guncelleme periyodu bekleniyor...")
                
        if running:
            run_updates()

    logging.info(f"{AGENT_ID} durduruldu.")

if __name__ == "__main__":
    if os.geteuid() != 0:
        logging.error("Bu script root (sudo) yetkisiyle calistirilmalidir.")
        sys.exit(1)
    main()
