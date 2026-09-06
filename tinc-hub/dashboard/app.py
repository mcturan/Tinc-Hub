#!/usr/bin/env python3
"""
Tinc Hub — Ana Uygulama
Tüm servislerin merkezi kontrol paneli. Port 9010.
"""

import os
import syslog_server
import packet_sniffer
import alarm_manager
import metrics_collector


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
SHARED_DIR = os.environ.get("TINC_HUB_SHARED", "/opt/tinc-hub/shared")
sys.path.insert(0, SHARED_DIR)
try:
    import db as tinchub_db
    tinchub_db.init_db()
except Exception as e:
    import logging
    logging.warning(f"Exception caught: {e}")
    tinchub_db = None

from discovery import discover_all, get_service_detail
from health import check_app, get_cached_health, start_background_checker
from users import init_users, load_users, verify_user

from registry import (load_apps, save_apps, get_app, add_app,
                       update_app, delete_app, get_categories)

# ── Config ───────────────────────────────────────────────────────────────────
CONFIG_PATH = "/etc/tinc-hub/config.env"
config = dotenv_values(CONFIG_PATH) if os.path.exists(CONFIG_PATH) else {}


PORT     = int(config.get("DASHBOARD_PORT", 9010))
HOST     = config.get("DASHBOARD_HOST", "0.0.0.0")
SECRET   = config.get("DASHBOARD_SECRET_KEY", "tinc-hub-tinc-secret-2025")
PASSWORD = config.get("TINC_HUB_PASSWORD", "").strip()   # boşsa auth yok
RUN_USER = config.get("RUN_USER", "turan")
RUN_UID  = config.get("RUN_UID", "1000")

# Initialize users if they don't exist
init_users(PASSWORD)
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

@app.context_processor
def inject_global_vars():
    try:
        from installer import get_git_info
        ver_info = get_git_info()
        return {"app_version": ver_info.get("version", "v1.0.0")}
    except Exception as e:
        import logging
        logging.warning(f"Exception caught: {e}")
        return {"app_version": "v1.0.0"}


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


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not PASSWORD:
            return f(*args, **kwargs)
        if not session.get("authenticated"):
            return jsonify({"error": "Kimlik doğrulama gerekli"}), 401
        if session.get("role") != "admin":
            return jsonify({"error": "Bu işlem için admin yetkisi gerekli"}), 403
        return f(*args, **kwargs)
    return decorated



def register_blueprints():
    # Register Blueprints
    from blueprints.pages import bp as pages_bp
    app.register_blueprint(pages_bp)
    from blueprints.taskmanager import bp as taskmanager_bp
    app.register_blueprint(taskmanager_bp)
    from blueprints.api_apps import bp as api_apps_bp
    app.register_blueprint(api_apps_bp)
    from blueprints.api_system import bp as api_system_bp
    app.register_blueprint(api_system_bp)
    from blueprints.api_agents import bp as api_agents_bp
    app.register_blueprint(api_agents_bp)
    from blueprints.api_store import bp as api_store_bp
    app.register_blueprint(api_store_bp)
    from blueprints.api_settings import bp as api_settings_bp
    app.register_blueprint(api_settings_bp)
    from blueprints.api_notifications import bp as api_notifications_bp
    app.register_blueprint(api_notifications_bp)
    from blueprints.api_rules import bp as api_rules_bp
    app.register_blueprint(api_rules_bp)
    from blueprints.api_network import bp as api_network_bp
    app.register_blueprint(api_network_bp)
    from blueprints.api_plugins import bp as api_plugins_bp
    app.register_blueprint(api_plugins_bp)
    from blueprints.api_remote import bp as api_remote_bp
    app.register_blueprint(api_remote_bp)
    from blueprints.api_terminal import bp as api_terminal_bp
    app.register_blueprint(api_terminal_bp)
    from blueprints.auth import bp as auth_bp
    app.register_blueprint(auth_bp)

if __name__ == "__main__":
    register_blueprints()
    log.info(f"Tinc Hub başlatılıyor → http://{HOST}:{PORT}")
    log.info(f"Kimlik doğrulama: {'AÇIK' if PASSWORD else 'KAPALI (şifresiz)'}")

    # Arka plan health checker başlat
    syslog_server.start_syslog_server()
    packet_sniffer.t_save = __import__('threading').Thread(target=packet_sniffer.save_stats_loop, daemon=True)
    packet_sniffer.t_save.start()
    __import__('threading').Thread(target=packet_sniffer.run_tcpdump, daemon=True).start()

    # Metrik toplayıcı: topology.json'dan IP listesini alarak periyodik ping ölçümü yapar
    def get_monitored_ips():
        try:
            import json
            topo_file = "/opt/tinc-hub/shared/topology.json"
            with open(topo_file) as f:
                topo = json.load(f)
            return [ip for ip in topo.get("nodes", {}).keys() if ip.count('.') == 3]
        except Exception:
            return []
    metrics_collector.start_metrics_collector(get_monitored_ips)

    start_background_checker(load_apps, interval=30)

    app.run(host=HOST, port=PORT, debug=False, threaded=True)
