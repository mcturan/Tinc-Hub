#!/usr/bin/env python3
"""
Tinc Hub — App Registry

apps.yaml dosyasını okur/yazar. Elle tanımlı + keşfedilen uygulamaları yönetir.
"""

import os
import yaml
import uuid
from pathlib import Path
from datetime import datetime
import threading

APPS_YAML = os.environ.get("TINC_HUB_APPS_YAML", "/etc/tinc-hub/apps.yaml")
_lock = threading.Lock()


# ─── Default apps.yaml içeriği ───────────────────────────────────────────────

DEFAULT_YAML = """\
# Tinc Hub — Uygulama Kayıt Defteri
# Uygulamaları buraya ekle veya web arayüzünden düzenle.
#
# health_check seçenekleri: http | systemd | port | none
# Kategori önerileri: İş | Medya | Sistem | Telsiz | Araç | Güvenlik

apps:
  - id: firinna-pos
    name: Firinna POS
    description: Kafe sipariş ve yönetim sistemi
    url: https://pos.firinna.com
    internal_url: http://127.0.0.1:5000
    health_url: http://127.0.0.1:5000
    service: firinna-pos
    port: 5000
    category: İş
    icon: "🍞"
    health_check: http
    pinned: true

  - id: firinna-web
    name: Firinna Web
    description: Kafe web sitesi
    url: https://firinna.com
    health_url: https://firinna.com
    service: nginx
    port: 443
    category: İş
    icon: "🌐"
    health_check: http
    pinned: true

  - id: aprs-beacon
    name: APRS Beacon
    description: Telsiz konum beacon servisi
    service: aprs-beacon@default
    port: null
    category: Telsiz
    icon: "📡"
    health_check: systemd
    pinned: true

  - id: plex
    name: Plex Media Server
    description: Medya yayın sunucusu
    url: http://127.0.0.1:32400/web
    internal_url: http://127.0.0.1:32400
    health_url: http://127.0.0.1:32400/identity
    service: plexmediaserver
    port: 32400
    category: Medya
    icon: "🎬"
    health_check: http
    pinned: false

  - id: ollama
    name: Ollama AI
    description: Yerel yapay zeka sunucusu
    url: http://127.0.0.1:11434
    health_url: http://127.0.0.1:11434
    service: ollama
    port: 11434
    category: Araç
    icon: "🧠"
    health_check: http
    pinned: false

  - id: nginx
    name: Nginx
    description: Web sunucu ve ters proxy
    service: nginx
    port: 80
    category: Sistem
    icon: "⚡"
    health_check: systemd
    pinned: false

  - id: anydesk
    name: AnyDesk
    description: Uzak masaüstü erişimi
    service: anydesk
    category: Araç
    icon: "🖥️"
    health_check: systemd
    pinned: false

  - id: cctv
    name: CCTV
    description: Güvenlik kamera sistemi
    category: Güvenlik
    icon: "📷"
    health_check: none
    pinned: false

  - id: samba
    name: Samba
    description: Ağ dosya paylaşımı
    service: smbd
    port: 445
    category: Sistem
    icon: "📁"
    health_check: systemd
    pinned: false
"""


# ─── YAML Okuma / Yazma ──────────────────────────────────────────────────────

def _ensure_file():
    path = Path(APPS_YAML)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(DEFAULT_YAML, encoding="utf-8")


def load_apps() -> list[dict]:
    """apps.yaml'dan tüm uygulamaları yükler."""
    _ensure_file()
    with _lock:
        try:
            with open(APPS_YAML, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            apps = data.get("apps", [])
            # ID yoksa üret
            for app in apps:
                if not app.get("id"):
                    app["id"] = str(uuid.uuid4())[:8]
            return apps
        except Exception as e:
            return []


def save_apps(apps: list[dict]):
    """App listesini apps.yaml'a yazar."""
    _ensure_file()
    with _lock:
        # Yedek al
        backup = Path(APPS_YAML + ".bak")
        if Path(APPS_YAML).exists():
            backup.write_text(Path(APPS_YAML).read_text())
        with open(APPS_YAML, "w", encoding="utf-8") as f:
            f.write("# Tinc Hub — Uygulama Kayıt Defteri\n")
            f.write(f"# Son güncelleme: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
            yaml.dump({"apps": apps}, f, allow_unicode=True,
                      default_flow_style=False, sort_keys=False)


def get_app(app_id: str) -> dict | None:
    """ID ile tekil uygulama döner."""
    return next((a for a in load_apps() if a.get("id") == app_id), None)


def add_app(app_data: dict) -> dict:
    """Yeni uygulama ekler, ID üretir."""
    apps = load_apps()
    if not app_data.get("id"):
        app_data["id"] = str(uuid.uuid4())[:8]
    app_data["created_at"] = datetime.now().isoformat()
    apps.append(app_data)
    save_apps(apps)
    return app_data


def update_app(app_id: str, updates: dict) -> dict | None:
    """Mevcut uygulamayı günceller."""
    apps = load_apps()
    for i, app in enumerate(apps):
        if app.get("id") == app_id:
            apps[i].update(updates)
            apps[i]["updated_at"] = datetime.now().isoformat()
            save_apps(apps)
            return apps[i]
    return None


def delete_app(app_id: str) -> bool:
    """Uygulamayı siler."""
    apps = load_apps()
    new_apps = [a for a in apps if a.get("id") != app_id]
    if len(new_apps) < len(apps):
        save_apps(new_apps)
        return True
    return False


def get_categories() -> list[str]:
    """Tüm kategorileri döner."""
    apps = load_apps()
    cats = sorted(set(a.get("category", "Diğer") for a in apps if a.get("category")))
    return cats or ["İş", "Medya", "Sistem", "Telsiz", "Araç", "Güvenlik", "Diğer"]
