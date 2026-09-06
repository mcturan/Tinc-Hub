from flask import Blueprint, render_template, jsonify, request, redirect, url_for, session, Response, stream_with_context
from app import *

bp = Blueprint('api_settings', __name__)

@bp.route("/api/settings/backup", methods=["POST"])
@admin_required
def api_backup():
    import datetime
    try:
        ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"/var/log/tinc-hub/tinc_hub_backup_{ts}.tar.gz"
        # /etc/tinc-hub ve /opt/tinc-hub klasorlerini yedekle
        subprocess.run(["sudo", "tar", "-czf", filename, "/etc/tinc-hub", "/opt/tinc-hub"], check=True)
        return jsonify({"ok": True, "file": filename})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500




@bp.route("/api/settings/telegram", methods=["POST"])
@admin_required
def api_save_telegram():
    data = request.json
    t_token = data.get("token", "")
    t_chat = data.get("chat", "")
    
    import os
    env_file = "/etc/tinc-hub/config.env"
    lines = []
    if os.path.exists(env_file):
        with open(env_file, "r") as f:
            lines = f.readlines()
            
    found_token = False
    found_chat = False
    
    with open(env_file, "w") as f:
        for line in lines:
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                f.write(f"TELEGRAM_BOT_TOKEN={t_token}\n")
                found_token = True
            elif line.startswith("TELEGRAM_CHAT_ID="):
                f.write(f"TELEGRAM_CHAT_ID={t_chat}\n")
                found_chat = True
            else:
                f.write(line)
                
        if not found_token:
                f.write(f"TELEGRAM_BOT_TOKEN={t_token}\n")
        if not found_chat:
                f.write(f"TELEGRAM_CHAT_ID={t_chat}\n")
                
    return jsonify({"ok": True, "message": "Telegram ayarları kaydedildi. Aktif olması için Tinc Hub'ı yeniden başlatın."})

@bp.route("/api/settings/ai", methods=["POST"])
@admin_required
def api_save_ai():
    data = request.json or {}
    gemini_key = data.get("gemini_api_key", "").strip()
    
    import os
    env_file = "/etc/tinc-hub/config.env"
    lines = []
    if os.path.exists(env_file):
        with open(env_file, "r") as f:
            lines = f.readlines()
            
    found_key = False
    with open(env_file, "w") as f:
        for line in lines:
            if line.startswith("GEMINI_API_KEY="):
                f.write(f"GEMINI_API_KEY={gemini_key}\n")
                found_key = True
            else:
                f.write(line)
        if not found_key:
            f.write(f"GEMINI_API_KEY={gemini_key}\n")
            
    return jsonify({"ok": True, "message": "AI API anahtarı başarıyla kaydedildi."})
