import threading
from flask import Blueprint, render_template, jsonify, request, redirect, url_for, session, Response, stream_with_context
from app import *

bp = Blueprint('auth', __name__)

@bp.route("/login", methods=["GET", "POST"])
def login():
    if not PASSWORD:
        return redirect("/")
    error = None
    if request.method == "POST":
        username = request.form.get("username", "admin")
        password = request.form.get("password", "")
        
        user_data = verify_user(username, password)
        # Fallback to config PASSWORD for admin if users.json corrupted
        if username == "admin" and password == PASSWORD:
            user_data = {"role": "admin"}
            
        if user_data:
            session["authenticated"] = True
            session["username"] = username
            session["role"] = user_data.get("role", "viewer")
            session.permanent = True

            from urllib.parse import urlparse
            next_url = request.args.get("next", "/")
            parsed = urlparse(next_url)
            if parsed.netloc and parsed.netloc != request.host:
                next_url = "/"
            return redirect(next_url)
        error = "Hatalı kullanıcı adı veya şifre"
    return render_template("login.html", error=error)



@bp.route("/logout")
def logout():
    session.clear()
    return redirect("/login" if PASSWORD else "/")


# ── Yardımcılar ───────────────────────────────────────────────────────────────

_metrics_history = {}

def _enrich_apps(apps: list[dict]) -> list[dict]:
    """App listesine sağlık + discovery verisi ekler."""
    disc = _get_discovery()
    port_map = disc.get("ports", {})
    svc_map  = {s["name"]: s for s in disc.get("services", [])}

    for app in apps:
        app["children"] = [
            {k: v for k, v in a.items() if k != "children"}
            for a in apps
            if a.get("parent") == app["id"] or (a.get("parent") and a.get("parent") == app.get("service"))
        ]
        
        # Sağlık
        cached = get_cached_health(app["id"])
        app["health"] = cached or {"ok": None, "checked_at": None}
        
        # Replace {{host}} in URLs
        try:
            from flask import request
            host_ip = request.host.split(':')[0]
            if app.get("url") and "{{host}}" in app["url"]:
                app["url"] = app["url"].replace("{{host}}", host_ip)
            if app.get("internal_url") and "{{host}}" in app["internal_url"]:
                app["internal_url"] = app["internal_url"].replace("{{host}}", host_ip)
        except Exception as e:
            import logging
            logging.warning(f"Exception caught: {e}")
        app["cpu_percent"] = None
        app["ram_mb"] = None
        app["metrics_history"] = {}

        # systemd detay
        svc = app.get("service")
        if svc:
            svc_data = svc_map.get(svc) or svc_map.get(svc.replace(".service", ""))
            if svc_data:
                app["running"]     = svc_data.get("running", False)
                app["cpu_percent"] = svc_data.get("cpu_percent")
                app["ram_mb"]      = svc_data.get("ram_mb")
                app["since"]       = svc_data.get("since")
                app["pid"]         = svc_data.get("pid")
            else:
                # systemctl ile anlık sorgula
                from discovery import get_service_detail, get_process_info
                det = get_service_detail(svc, is_user_service=app.get("is_user_service", False))
                app["running"] = det.get("active_state") == "active"
                app["since"]   = det.get("since", "")
                app["pid"]     = det.get("pid")
                if app["pid"]:
                    proc_info = get_process_info(app["pid"])
                    if proc_info:
                        app["cpu_percent"] = proc_info.get("cpu_percent")
                        app["ram_mb"]      = proc_info.get("ram_mb")

        # Port veya PID discovery'den tamamla
        if (not app.get("pid") or not app.get("running")) and app.get("port"):
            p_info = port_map.get(app.get("port"))
            if p_info and p_info.get("pid"):
                app["pid"] = p_info["pid"]
                if app.get("running") is None or not app.get("running"):
                    app["running"] = True
                from discovery import get_process_info
                proc_info = get_process_info(app["pid"])
                if proc_info:
                    if app.get("cpu_percent") is None:
                        app["cpu_percent"] = proc_info.get("cpu_percent")
                    if app.get("ram_mb") is None:
                        app["ram_mb"] = proc_info.get("ram_mb")

        # psutil ile sadece is_user_service olan servisler için arama (örn: aprs-beacon)
        if app.get("is_user_service") and (not app.get("pid") or not app.get("running")):
            try:
                import psutil
                from discovery import get_process_info
                script_name = (app.get("service") or "").split("@")[0].replace("-", "_") + ".py"
                for proc in psutil.process_iter(['pid', 'cmdline', 'name']):
                    try:
                        cmd_line = ' '.join(proc.info['cmdline'] or []).lower()
                        if script_name in cmd_line and proc.info['pid'] != os.getpid():
                            app["pid"] = proc.info['pid']
                            app["running"] = True
                            proc_info = get_process_info(app["pid"])
                            if proc_info:
                                app["cpu_percent"] = proc_info.get("cpu_percent")
                                app["ram_mb"]      = proc_info.get("ram_mb")
                            break
                    except Exception:
                        pass
            except Exception:
                pass

        # Min/Max Tracking
        if app.get("cpu_percent") is not None or app.get("ram_mb") is not None:
            app_id = app["id"]
            if app_id not in _metrics_history:
                _metrics_history[app_id] = {"cpu_min": app["cpu_percent"], "cpu_max": app["cpu_percent"], "ram_min": app["ram_mb"], "ram_max": app["ram_mb"]}
            else:
                hist = _metrics_history[app_id]
                if app["cpu_percent"] is not None:
                    if hist["cpu_min"] is None or app["cpu_percent"] < hist["cpu_min"]: hist["cpu_min"] = app["cpu_percent"]
                    if hist["cpu_max"] is None or app["cpu_percent"] > hist["cpu_max"]: hist["cpu_max"] = app["cpu_percent"]
                if app["ram_mb"] is not None:
                    if hist["ram_min"] is None or app["ram_mb"] < hist["ram_min"]: hist["ram_min"] = app["ram_mb"]
                    if hist["ram_max"] is None or app["ram_mb"] > hist["ram_max"]: hist["ram_max"] = app["ram_mb"]
            app["metrics_history"] = _metrics_history[app_id]
        # Bellek sızıntısı önlemi: 500'den fazla app geçmişi birikirse ilk 200'ü temizle
        if len(_metrics_history) > 500:
            keys_to_delete = list(_metrics_history.keys())[:200]
            for k in keys_to_delete:
                del _metrics_history[k]

        # Port bilgisi discovery'den tamamla
        if not app.get("port") and svc:
            from discovery import get_service_detail
            det = get_service_detail(svc, is_user_service=app.get("is_user_service", False))
            pid = det.get("pid")
            if pid:
                matched = [p for p, info in port_map.items() if info.get("pid") == pid]
                if matched:
                    app["port"] = matched[0]

        # Durum sınıfı
        ok = app["health"].get("ok")
        app["status_class"] = ("healthy" if ok is True or app.get("running") is True
                               else "dead" if ok is False or app.get("running") is False else "unknown")

    return apps


# Discovery cache (60 saniyede yenile)
_disc_cache = {"data": None, "at": None}
_disc_lock = threading.Lock()
_DISC_TTL = 60


def _get_discovery() -> dict:
    now = datetime.now()
    with _disc_lock:
        if _disc_cache["at"] and (now - _disc_cache["at"]).seconds < _DISC_TTL:
            return _disc_cache["data"]
    try:
        data = discover_all()
    except Exception as e:
        log.error(f"Discovery hatası: {e}")
        data = {"services": [], "ports": {}, "docker": []}
    with _disc_lock:
        _disc_cache["data"] = data
        _disc_cache["at"]   = now
    return data


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
    except Exception as e:
        import logging
        logging.warning(f"Exception caught: {e}")
        return since_str[:16]


MOBILE_REQUIRED_VERSION = "1.0.0"

def _ver_to_int(ver: str) -> int:
    try:
        parts = ver.replace("v", "").split(".")
        return int("".join([p.zfill(3) for p in parts]))
    except Exception as e:
        import logging
        logging.warning(f"Exception caught: {e}")
        return 0

# ── HTML Sayfalar ─────────────────────────────────────────────────────────────


