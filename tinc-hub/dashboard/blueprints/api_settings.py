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

@bp.route("/api/settings/ai", methods=["GET"])
@admin_required
def api_get_ai_settings():
    import os
    from dotenv import dotenv_values
    env_cfg = {}
    if os.path.exists("/etc/tinc-hub/config.env"):
        try:
            env_cfg = dotenv_values("/etc/tinc-hub/config.env")
        except Exception:
            pass
    gemini_key = env_cfg.get("GEMINI_API_KEY", "") or os.environ.get("GEMINI_API_KEY", "")
    openai_key = env_cfg.get("OPENAI_API_KEY", "") or os.environ.get("OPENAI_API_KEY", "")

    # Mask key for privacy
    def mask_key(k):
        if not k: return ""
        if len(k) <= 8: return "****"
        return k[:4] + "...." + k[-4:]

    return jsonify({
        "gemini_configured": bool(gemini_key),
        "gemini_masked": mask_key(gemini_key),
        "openai_configured": bool(openai_key),
        "openai_masked": mask_key(openai_key)
    })

@bp.route("/api/settings/ai", methods=["POST"])
@admin_required
def api_save_ai():
    data = request.json or {}
    gemini_key = data.get("gemini_api_key")
    openai_key = data.get("openai_api_key")
    
    import os
    env_file = "/etc/tinc-hub/config.env"
    lines = []
    if os.path.exists(env_file):
        with open(env_file, "r") as f:
            lines = f.readlines()
            
    # Process gemini
    if gemini_key is not None:
        gemini_key = gemini_key.strip()
        found_key = False
        new_lines = []
        for line in lines:
            if line.startswith("GEMINI_API_KEY="):
                new_lines.append(f"GEMINI_API_KEY={gemini_key}\n")
                found_key = True
            else:
                new_lines.append(line)
        if not found_key:
            new_lines.append(f"GEMINI_API_KEY={gemini_key}\n")
        lines = new_lines

    # Process openai
    if openai_key is not None:
        openai_key = openai_key.strip()
        found_key = False
        new_lines = []
        for line in lines:
            if line.startswith("OPENAI_API_KEY="):
                new_lines.append(f"OPENAI_API_KEY={openai_key}\n")
                found_key = True
            else:
                new_lines.append(line)
        if not found_key:
            new_lines.append(f"OPENAI_API_KEY={openai_key}\n")
        lines = new_lines

    with open(env_file, "w") as f:
        f.writelines(lines)
            
    return jsonify({"ok": True, "message": "Yapay zeka ayarları başarıyla kaydedildi."})

@bp.route("/api/settings/ai/test", methods=["POST"])
@admin_required
def api_test_ai():
    import os, json, urllib.request, re
    from dotenv import dotenv_values
    env_cfg = {}
    if os.path.exists("/etc/tinc-hub/config.env"):
        try:
            env_cfg = dotenv_values("/etc/tinc-hub/config.env")
        except Exception:
            pass

    gemini_key = env_cfg.get("GEMINI_API_KEY", "") or os.environ.get("GEMINI_API_KEY", "")
    openai_key = env_cfg.get("OPENAI_API_KEY", "") or os.environ.get("OPENAI_API_KEY", "")

    test_prompt = (
        "Respond with a single JSON object: "
        '{"status": "ok", "provider": "NAME", "deviceType": "switch", "port_count": 24}'
    )

    results = []

    # Test Gemini
    if gemini_key:
        try:
            ai_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={gemini_key}"
            req_data = json.dumps({
                "contents": [{"parts": [{"text": test_prompt.replace("NAME", "Gemini")}]}],
                "generationConfig": {"temperature": 0.1, "maxOutputTokens": 100}
            }).encode('utf-8')
            ai_req = urllib.request.Request(ai_url, data=req_data, headers={'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(ai_req, timeout=5) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                text = data.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '')
                results.append({"provider": "Google Gemini", "success": True, "message": "Bağlantı başarılı (gemini-1.5-flash)"})
        except Exception as e:
            results.append({"provider": "Google Gemini", "success": False, "message": f"Hata: {e}"})
    else:
        results.append({"provider": "Google Gemini", "success": False, "message": "API Key tanımlı değil"})

    # Test OpenAI
    if openai_key:
        try:
            ai_url = "https://api.openai.com/v1/chat/completions"
            req_data = json.dumps({
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": test_prompt.replace("NAME", "OpenAI")}],
                "temperature": 0.1,
                "max_tokens": 100
            }).encode('utf-8')
            ai_req = urllib.request.Request(ai_url, data=req_data, headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {openai_key}'
            }, method='POST')
            with urllib.request.urlopen(ai_req, timeout=5) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                results.append({"provider": "OpenAI ChatGPT", "success": True, "message": "Bağlantı başarılı (gpt-4o-mini)"})
        except Exception as e:
            results.append({"provider": "OpenAI ChatGPT", "success": False, "message": f"Hata: {e}"})
    else:
        results.append({"provider": "OpenAI ChatGPT", "success": False, "message": "API Key tanımlı değil"})

    return jsonify({"ok": True, "results": results})

