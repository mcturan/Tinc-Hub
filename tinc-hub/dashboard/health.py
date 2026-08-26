#!/usr/bin/env python3
"""
Tinc Hub — Sağlık Kontrol Motoru

Her uygulama için HTTP ping veya systemd durumunu kontrol eder.
"""

import subprocess
import requests
import threading
import time
from datetime import datetime

# Son sağlık durumları cache (thread-safe)
_health_cache: dict = {}
_cache_lock = threading.Lock()

# Her app için kaç saniyede bir check yapılsın
CHECK_INTERVAL = 30  # saniye


def http_check(url: str, timeout: int = 5) -> dict:
    """HTTP(S) endpoint'e GET atar, durum döner."""
    try:
        r = requests.get(url, timeout=timeout, allow_redirects=True,
                         verify=False)
        return {
            "ok": r.status_code < 500,
            "status_code": r.status_code,
            "latency_ms": round(r.elapsed.total_seconds() * 1000),
            "error": None,
        }
    except requests.exceptions.ConnectionError:
        return {"ok": False, "status_code": None, "latency_ms": None,
                "error": "bağlantı reddedildi"}
    except requests.exceptions.Timeout:
        return {"ok": False, "status_code": None, "latency_ms": None,
                "error": "zaman aşımı"}
    except Exception as e:
        return {"ok": False, "status_code": None, "latency_ms": None,
                "error": str(e)[:80]}


def systemd_check(service_name: str, is_user: bool = False) -> dict:
    """systemctl is-active ile servis durumunu kontrol eder."""
    try:
        unit = service_name if service_name.endswith(".service") else f"{service_name}.service"
        cmd = ["systemctl", "is-active", unit]
        if is_user:
            # sudo -u turan XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active
            cmd = ["sudo", "-u", "turan", "XDG_RUNTIME_DIR=/run/user/1000", "systemctl", "--user", "is-active", unit]
            
        r = subprocess.run(
            cmd,
            capture_output=True, text=True, timeout=3
        )
        active = r.stdout.strip()
        ok = active == "active"
        return {"ok": ok, "state": active, "error": None}
    except Exception as e:
        return {"ok": False, "state": "unknown", "error": str(e)[:80]}


def port_check(host: str, port: int, timeout: int = 3) -> dict:
    """TCP porta bağlanmayı dener."""
    import socket
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return {"ok": True, "error": None}
    except Exception as e:
        return {"ok": False, "error": str(e)[:60]}


def check_app(app: dict) -> dict:
    """
    Bir uygulamanın sağlık durumunu döner.
    app dict'i registry'den gelir.
    """
    health_type = app.get("health_check", "systemd")
    result = {
        "app_id": app.get("id"),
        "checked_at": datetime.now().isoformat(),
        "ok": False,
        "method": health_type,
        "detail": {},
    }

    if health_type == "http":
        url = app.get("health_url") or app.get("internal_url") or app.get("url")
        if url:
            detail = http_check(url)
            result["ok"] = detail["ok"]
            result["detail"] = detail
        else:
            result["detail"] = {"error": "URL tanımlı değil"}

    elif health_type == "systemd":
        service = app.get("service")
        if service:
            is_user = app.get("is_user_service", False)
            detail = systemd_check(service, is_user=is_user)
            result["ok"] = detail["ok"]
            result["detail"] = detail
        else:
            result["detail"] = {"error": "Servis adı tanımlı değil"}

    elif health_type == "port":
        port = app.get("port")
        if port:
            detail = port_check("127.0.0.1", port)
            result["ok"] = detail["ok"]
            result["detail"] = detail
        else:
            result["detail"] = {"error": "Port tanımlı değil"}

    elif health_type == "none":
        result["ok"] = True
        result["detail"] = {"note": "İzleme kapalı"}

    else:
        result["detail"] = {"error": f"Bilinmeyen tip: {health_type}"}

    return result


def get_cached_health(app_id: str) -> dict | None:
    with _cache_lock:
        return _health_cache.get(app_id)


def update_cache(app_id: str, result: dict):
    with _cache_lock:
        _health_cache[app_id] = result


def start_background_checker(get_apps_fn, interval: int = CHECK_INTERVAL):
    """
    Arka planda periyodik health check döngüsü başlatır.
    get_apps_fn: registry'den app listesi dönen fonksiyon
    """
    def _loop():
        while True:
            try:
                apps = get_apps_fn()
                for app in apps:
                    if app.get("health_check", "systemd") == "none":
                        continue
                    result = check_app(app)
                    update_cache(app["id"], result)
            except Exception:
                pass
            time.sleep(interval)

    t = threading.Thread(target=_loop, daemon=True, name="health-checker")
    t.start()
    return t
