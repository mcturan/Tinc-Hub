#!/usr/bin/env python3
"""
Tinc Hub — Ana Uygulama
Tüm servislerin merkezi kontrol paneli. Port 9010.
"""

import os
import sys
import json
import logging
import subprocess
from datetime import datetime, timedelta
from functools import wraps

from flask import (Flask, render_template, jsonify, request,
                   redirect, url_for, session, Response, stream_with_context)
from dotenv import dotenv_values

# ── Shared modüller ──────────────────────────────────────────────────────────
sys.path.insert(0, "/opt/tinc-hub/shared")
try:
    import db as tinchub_db
    tinchub_db.init_db()
except Exception:
    tinchub_db = None

from discovery import discover_all, get_service_detail
from health import check_app, get_cached_health, start_background_checker
from registry import (load_apps, save_apps, get_app, add_app,
                       update_app, delete_app, get_categories)

# ── Config ───────────────────────────────────────────────────────────────────
CONFIG_PATH = "/etc/tinc-hub/config.env"
config = dotenv_values(CONFIG_PATH) if os.path.exists(CONFIG_PATH) else {}

PORT     = int(config.get("DASHBOARD_PORT", 9010))
HOST     = config.get("DASHBOARD_HOST", "0.0.0.0")
SECRET   = config.get("DASHBOARD_SECRET_KEY", "tinc-hub-tinc-secret-2025")
PASSWORD = config.get("TINC_HUB_PASSWORD", "").strip()   # boşsa auth yok

# ── Logging ──────────────────────────────────────────────────────────────────
os.makedirs("/var/log/tinc-hub", exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [HUB] %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler("/var/log/tinc-hub/dashboard.log"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("tinc-hub-hub")

# ── Flask ─────────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.secret_key = SECRET
app.config["SESSION_COOKIE_HTTPONLY"] = True


# ── Auth ─────────────────────────────────────────────────────────────────────

def auth_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not PASSWORD:                          # Şifre tanımlanmamış → geç
            return f(*args, **kwargs)
        if session.get("authenticated"):          # Oturum açık → geç
            return f(*args, **kwargs)
        if request.path.startswith("/api/"):
            return jsonify({"error": "Kimlik doğrulama gerekli"}), 401
        return redirect(url_for("login", next=request.path))
    return decorated


@app.route("/login", methods=["GET", "POST"])
def login():
    if not PASSWORD:
        return redirect("/")
    error = None
    if request.method == "POST":
        if request.form.get("password") == PASSWORD:
            session["authenticated"] = True
            session.permanent = True
            return redirect(request.args.get("next") or "/")
        error = "Hatalı şifre"
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login" if PASSWORD else "/")


# ── Yardımcılar ───────────────────────────────────────────────────────────────

def _enrich_apps(apps: list[dict]) -> list[dict]:
    """App listesine sağlık + discovery verisi ekler."""
    disc = _get_discovery()
    port_map = disc.get("ports", {})
    svc_map  = {s["name"]: s for s in disc.get("services", [])}

    for app in apps:
        app["children"] = [a for a in apps if a.get("parent") == app["id"] or (a.get("parent") and a.get("parent") == app.get("service"))]
        
        # Sağlık
        cached = get_cached_health(app["id"])
        app["health"] = cached or {"ok": None, "checked_at": None}

        # systemd detay
        svc = app.get("service")
        if svc:
            svc_data = svc_map.get(svc) or svc_map.get(svc.replace(".service", ""))
            if svc_data:
                app["running"]     = svc_data.get("running", False)
                app["cpu_percent"] = svc_data.get("cpu_percent")
                app["ram_mb"]      = svc_data.get("ram_mb")
                app["since"]       = svc_data.get("since", "")
            else:
                # systemctl ile anlık sorgula
                det = get_service_detail(svc)
                app["running"] = det.get("active_state") == "active"
                app["since"]   = det.get("since", "")

        # Port bilgisi discovery'den tamamla
        if not app.get("port") and svc:
            det = get_service_detail(svc)
            pid = det.get("pid")
            if pid:
                matched = [p for p, info in port_map.items() if info.get("pid") == pid]
                if matched:
                    app["port"] = matched[0]

        # Durum sınıfı
        ok = app["health"].get("ok")
        app["status_class"] = ("healthy" if ok is True
                               else "dead" if ok is False else "unknown")

    return apps


# Discovery cache (60 saniyede yenile)
_disc_cache = {"data": None, "at": None}
_DISC_TTL = 60


def _get_discovery() -> dict:
    now = datetime.now()
    if _disc_cache["at"] and (now - _disc_cache["at"]).seconds < _DISC_TTL:
        return _disc_cache["data"]
    try:
        _disc_cache["data"] = discover_all()
        _disc_cache["at"]   = now
    except Exception as e:
        log.error(f"Discovery hatası: {e}")
        _disc_cache["data"] = {"services": [], "ports": {}, "docker": []}
        _disc_cache["at"]   = now
    return _disc_cache["data"]


def _format_uptime(since_str: str) -> str:
    if not since_str:
        return ""
    try:
        # systemd format: "Wed 2026-08-26 09:11:00 +03"
        for fmt in ("%a %Y-%m-%d %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S"):
            try:
                dt = datetime.strptime(since_str[:25].strip(), fmt[:len(since_str[:25].strip())])
                break
            except ValueError:
                continue
        else:
            return since_str
        delta = datetime.now(dt.tzinfo) - dt if dt.tzinfo else datetime.now() - dt
        d, s = delta.days, delta.seconds
        h, m = s // 3600, (s % 3600) // 60
        parts = []
        if d:    parts.append(f"{d}g")
        if h:    parts.append(f"{h}s")
        parts.append(f"{m}d")
        return " ".join(parts)
    except Exception:
        return since_str[:16]

def _now():
    return datetime.now().strftime("%H:%M:%S")

# ── HTML Sayfalar ─────────────────────────────────────────────────────────────

@app.route("/")
@auth_required
def index():
    all_apps = load_apps()
    enriched = _enrich_apps(all_apps)
    
    cat_filter = request.args.get("cat", "")
    categories = get_categories()
    
    if cat_filter:
        display_apps = [a for a in enriched if a.get("category") == cat_filter]
        pinned = []
        unpinned = []
    else:
        display_apps = []
        pinned = [a for a in enriched if a.get("pinned")]
        unpinned = [a for a in enriched if not a.get("pinned")]
        
    disc = _get_discovery()
    docker = disc.get("docker", [])
    known_services = {a.get("service") for a in all_apps if a.get("service")}
    unknown_services = [s for s in disc.get("services", []) if s["name"] not in known_services]
    
    system = _system_summary()
    
    return render_template("hub.html",
        apps=display_apps,
        pinned=pinned, 
        unpinned=unpinned,
        categories=categories,
        selected_cat=cat_filter,
        docker=docker,
        unknown_services=unknown_services,
        system=system, 
        now=_now(),
        format_uptime=_format_uptime,
        has_auth=bool(PASSWORD))


@app.route("/app/<app_id>")
@auth_required
def app_detail(app_id):
    app_data = get_app(app_id)
    if not app_data:
        return "Uygulama bulunamadı", 404
    enriched = _enrich_apps([app_data])[0]
    # Anlık health check
    health = check_app(app_data)
    enriched["health"] = health
    return render_template("app_detail.html",
        app=enriched, now=_now(), format_uptime=_format_uptime)


@app.route("/logs")
@auth_required
def logs_page():
    apps = load_apps()
    services = [a for a in apps if a.get("service")]
    selected = request.args.get("service", "")
    # Systemd discovery'den de servis ekle
    disc = _get_discovery()
    disc_services = [s["name"] for s in disc.get("services", [])]
    return render_template("logs.html",
        services=services, disc_services=disc_services,
        selected=selected, now=_now())


@app.route("/settings")
@auth_required
def settings_page():
    apps = load_apps()
    categories = get_categories()
    return render_template("settings.html",
        apps=apps, categories=categories, now=_now(),
        has_auth=bool(PASSWORD))


# ── API: Uygulamalar ─────────────────────────────────────────────────────────

@app.route("/api/apps")
@auth_required
def api_apps():
    apps = _enrich_apps(load_apps())
    return jsonify(apps)


@app.route("/api/app/<app_id>")
@auth_required
def api_app(app_id):
    app_data = get_app(app_id)
    if not app_data:
        return jsonify({"error": "Bulunamadı"}), 404
    return jsonify(_enrich_apps([app_data])[0])


@app.route("/api/app/<app_id>/health")
@auth_required
def api_health(app_id):
    app_data = get_app(app_id)
    if not app_data:
        return jsonify({"error": "Bulunamadı"}), 404
    result = check_app(app_data)
    return jsonify(result)


@app.route("/api/app/<app_id>/action", methods=["POST"])
@auth_required
def api_action(app_id):
    """Start / stop / restart"""
    data = request.get_json() or {}
    action = data.get("action", "")
    if action not in ("start", "stop", "restart"):
        return jsonify({"error": "Geçersiz eylem"}), 400

    app_data = get_app(app_id)
    if not app_data:
        return jsonify({"error": "Uygulama bulunamadı"}), 404

    service = app_data.get("service")
    if not service:
        return jsonify({"error": "Bu uygulama için servis tanımlı değil"}), 400

    unit = service if service.endswith(".service") else f"{service}.service"
    try:
        r = subprocess.run(
            ["systemctl", action, unit],
            capture_output=True, text=True, timeout=15
        )
        ok = r.returncode == 0
        msg = r.stdout.strip() or r.stderr.strip() or f"{action} {'başarılı' if ok else 'başarısız'}"
        log.info(f"Eylem: {action} {unit} → {'OK' if ok else 'FAIL'}")
        return jsonify({"ok": ok, "message": msg})
    except Exception as e:
        return jsonify({"ok": False, "message": str(e)}), 500


# ── API: Settings ─────────────────────────────────────────────────────────────

@app.route("/api/settings/apps", methods=["GET"])
@auth_required
def api_settings_apps_get():
    return jsonify(load_apps())


@app.route("/api/settings/apps/add", methods=["POST"])
@auth_required
def api_add_app():
    data = request.get_json() or {}
    if not data.get("name"):
        return jsonify({"error": "İsim gerekli"}), 400
    app_data = add_app(data)
    return jsonify({"ok": True, "app": app_data}), 201


@app.route("/api/settings/apps/<app_id>", methods=["PUT"])
@auth_required
def api_update_app(app_id):
    data = request.get_json() or {}
    updated = update_app(app_id, data)
    if not updated:
        return jsonify({"error": "Bulunamadı"}), 404
    return jsonify({"ok": True, "app": updated})


@app.route("/api/settings/apps/<app_id>", methods=["DELETE"])
@auth_required
def api_delete_app(app_id):
    ok = delete_app(app_id)
    return jsonify({"ok": ok})


@app.route("/api/settings/apps/<app_id>/pin", methods=["POST"])
@auth_required
def api_pin_app(app_id):
    data = request.get_json() or {}
    pinned = bool(data.get("pinned", True))
    updated = update_app(app_id, {"pinned": pinned})
    return jsonify({"ok": bool(updated)})


# ── API: Discovery ───────────────────────────────────────────────────────────

@app.route("/api/discovery")
@auth_required
def api_discovery():
    disc = _get_discovery()
    return jsonify(disc)


@app.route("/api/discovery/refresh", methods=["POST"])
@auth_required
def api_discovery_refresh():
    _disc_cache["at"] = None   # TTL sıfırla
    disc = _get_discovery()
    return jsonify({"ok": True, "services": len(disc.get("services", [])),
                    "ports": len(disc.get("ports", {}))})


# ── API: Sistem Özeti ────────────────────────────────────────────────────────

def _system_summary() -> dict:
    import shutil
    try:
        import psutil
        ram  = psutil.virtual_memory()
        swap = psutil.swap_memory()
        cpu  = psutil.cpu_percent(interval=0.2)
        disk = shutil.disk_usage("/")
        return {
            "cpu_percent":  round(cpu, 1),
            "ram_percent":  round(ram.percent, 1),
            "ram_used_gb":  round(ram.used  / 1024**3, 1),
            "ram_total_gb": round(ram.total / 1024**3, 1),
            "swap_percent": round(swap.percent, 1),
            "disk_percent": round(disk.used / disk.total * 100, 1),
            "disk_used_gb": round(disk.used  / 1024**3, 1),
            "disk_total_gb":round(disk.total / 1024**3, 1),
        }
    except Exception:
        return {}


@app.route("/api/system")
@auth_required
def api_system():
    return jsonify(_system_summary())


@app.route("/api/wan")
@auth_required
def api_wan():
    if tinchub_db:
        history = tinchub_db.get_wan_history(limit=5)
        latest  = tinchub_db.get_latest_metric("wan-tracker", "wan_ip")
        return jsonify({"history": history, "current": latest})
    return jsonify({"history": [], "current": None})


# ── SSE: Canlı Log Akışı ─────────────────────────────────────────────────────

@app.route("/api/logs/stream/<path:service_name>")
@auth_required
def stream_logs(service_name):
    """
    Server-Sent Events ile journalctl -f akışı.
    Nginx için: proxy_buffering off; X-Accel-Buffering: no
    """
    # Güvenlik: sadece harf, rakam, kısa çizgi, @ ve nokta
    import re as _re
    if not _re.match(r'^[\w@.\-]+$', service_name):
        return "Geçersiz servis adı", 400

    lines = int(request.args.get("lines", 100))
    unit  = service_name if service_name.endswith(".service") else f"{service_name}.service"

    def generate():
        proc = subprocess.Popen(
            ["journalctl", "-u", unit, "-f", f"-n{lines}", "--no-pager", "--output=short-iso"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1
        )
        try:
            yield f"data: {json.dumps({'type': 'connected', 'service': service_name})}\n\n"
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    payload = json.dumps({"type": "line", "line": line,
                                          "ts": datetime.now().isoformat()})
                    yield f"data: {payload}\n\n"
        except GeneratorExit:
            pass
        finally:
            proc.terminate()
            proc.wait(timeout=3)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":       "no-cache",
            "X-Accel-Buffering":   "no",
            "Connection":          "keep-alive",
        }
    )


@app.route("/api/logs/lines/<path:service_name>")
@auth_required
def log_lines(service_name):
    """Son N log satırını JSON olarak döner (statik, SSE değil)."""
    import re as _re
    if not _re.match(r'^[\w@.\-]+$', service_name):
        return jsonify({"error": "Geçersiz servis adı"}), 400
    lines = int(request.args.get("n", 200))
    unit  = service_name if service_name.endswith(".service") else f"{service_name}.service"
    r = subprocess.run(
        ["journalctl", "-u", unit, f"-n{lines}", "--no-pager", "--output=short-iso"],
        capture_output=True, text=True, timeout=10
    )
    return jsonify({"lines": r.stdout.splitlines(), "service": service_name})


# ── Yardımcılar ───────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now().strftime("%d.%m.%Y %H:%M:%S")


# ── Başlatma ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info(f"Tinc Hub başlatılıyor → http://{HOST}:{PORT}")
    log.info(f"Kimlik doğrulama: {'AÇIK' if PASSWORD else 'KAPALI (şifresiz)'}")

    # Arka plan health checker başlat
    start_background_checker(load_apps, interval=30)

    app.run(host=HOST, port=PORT, debug=False, threaded=True)
