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
        gemini_models = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-1.5-flash"]
        gemini_ok = False
        last_err = ""
        for gm in gemini_models:
            try:
                ai_url = f"https://generativelanguage.googleapis.com/v1beta/models/{gm}:generateContent?key={gemini_key}"
                req_data = json.dumps({
                    "contents": [{"parts": [{"text": test_prompt.replace("NAME", "Gemini")}]}],
                    "generationConfig": {"temperature": 0.1, "maxOutputTokens": 100}
                }).encode('utf-8')
                ai_req = urllib.request.Request(ai_url, data=req_data, headers={'Content-Type': 'application/json'}, method='POST')
                with urllib.request.urlopen(ai_req, timeout=6) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
                    results.append({"provider": "Google Gemini", "success": True, "message": f"Bağlantı başarılı ({gm})"})
                    gemini_ok = True
                    break
            except Exception as e:
                last_err = str(e)
        if not gemini_ok:
            results.append({"provider": "Google Gemini", "success": False, "message": f"Hata: {last_err}"})
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


# ── Router & Modem Settings (Router Guardian) ─────────────────────────────────

def _update_turan_crontab(hour: int, minute: int, enabled: bool):
    try:
        user = "turan"
        r = subprocess.run(["crontab", "-u", user, "-l"], capture_output=True, text=True)
        lines = r.stdout.splitlines() if r.returncode == 0 else []
        new_lines = []
        found = False
        target_cmd = "/home/turan/router_reboot.py"
        new_cron_line = f"{minute} {hour} * * * {target_cmd} >> /home/turan/router_reboot.log 2>&1"
        if not enabled:
            new_cron_line = f"# DISABLED {new_cron_line}"

        for line in lines:
            if target_cmd in line:
                new_lines.append(new_cron_line)
                found = True
            else:
                new_lines.append(line)
        if not found:
            new_lines.append(new_cron_line)

        final_crontab = "\n".join(new_lines).strip() + "\n"
        subprocess.run(["crontab", "-u", user, "-"], input=final_crontab, text=True, check=True)
    except Exception as e:
        import logging
        logging.warning(f"Crontab update error: {e}")


@bp.route("/api/settings/router", methods=["GET"])
@admin_required
def api_get_router_settings():
    import os
    from dotenv import dotenv_values
    env_cfg = {}
    if os.path.exists("/etc/tinc-hub/config.env"):
        try:
            env_cfg = dotenv_values("/etc/tinc-hub/config.env")
        except Exception:
            pass

    ip = env_cfg.get("ROUTER_IP", "192.168.1.1")
    user = env_cfg.get("ROUTER_USER", "admin")
    pw = env_cfg.get("ROUTER_PASS", "")
    time_val = env_cfg.get("ROUTER_REBOOT_TIME", "06:00")
    enabled = env_cfg.get("ROUTER_REBOOT_ENABLED", "true").lower() == "true"

    def mask_pw(k):
        if not k or k == "your_password_here": return ""
        if len(k) <= 6: return "****"
        return k[:4] + "...." + k[-3:]

    return jsonify({
        "ok": True,
        "ip": ip,
        "user": user,
        "has_pass": bool(pw and pw != "your_password_here"),
        "pass_masked": mask_pw(pw),
        "time": time_val,
        "enabled": enabled
    })


@bp.route("/api/settings/router", methods=["POST"])
@admin_required
def api_save_router_settings():
    data = request.json or {}
    new_ip = data.get("ip", "192.168.1.1").strip()
    new_user = data.get("user", "admin").strip()
    new_pw = data.get("password")
    new_time = data.get("time", "06:00").strip()
    enabled = bool(data.get("enabled", True))

    import re
    if not re.match(r"^\d{1,2}:\d{2}$", new_time):
        return jsonify({"ok": False, "error": "Geçersiz saat formatı (Örn: 06:00)"}), 400

    parts = new_time.split(":")
    hour = int(parts[0])
    minute = int(parts[1])
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return jsonify({"ok": False, "error": "Geçersiz saat/dakika değeri"}), 400

    env_file = "/etc/tinc-hub/config.env"
    lines = []
    import os
    if os.path.exists(env_file):
        with open(env_file, "r") as f:
            lines = f.readlines()

    updates = {
        "ROUTER_IP": new_ip,
        "ROUTER_USER": new_user,
        "ROUTER_REBOOT_TIME": f"{hour:02d}:{minute:02d}",
        "ROUTER_REBOOT_CRON": f'"{minute} {hour} * * *"',
        "ROUTER_REBOOT_ENABLED": "true" if enabled else "false"
    }
    if new_pw is not None and new_pw.strip():
        updates["ROUTER_PASS"] = new_pw.strip()

    seen_keys = set()
    new_lines = []
    for line in lines:
        matched_key = None
        for k in updates:
            if line.startswith(f"{k}="):
                matched_key = k
                break
        if matched_key:
            new_lines.append(f"{matched_key}={updates[matched_key]}\n")
            seen_keys.add(matched_key)
        else:
            new_lines.append(line)

    for k, v in updates.items():
        if k not in seen_keys:
            new_lines.append(f"{k}={v}\n")

    with open(env_file, "w") as f:
        f.writelines(new_lines)

    # Crontab senkronize et
    _update_turan_crontab(hour, minute, enabled)

    # Router guardian servisini yeniden başlat (varsa)
    try:
        subprocess.run(["systemctl", "restart", "tinc-hub-router-guardian.service"], check=False)
    except Exception:
        pass

    return jsonify({"ok": True, "message": "Modem otomasyon ayarları başarıyla kaydedildi."})


@bp.route("/api/settings/router/test", methods=["POST"])
@admin_required
def api_test_router():
    import sys, os
    shared_dir = os.environ.get("TINC_HUB_SHARED", "/opt/tinc-hub/shared")
    if shared_dir not in sys.path:
        sys.path.insert(0, shared_dir)

    try:
        from router_util import test_router_login
    except Exception as e:
        return jsonify({"ok": False, "error": f"router_util modülü yüklenemedi: {e}"}), 500

    from dotenv import dotenv_values
    env_cfg = {}
    if os.path.exists("/etc/tinc-hub/config.env"):
        env_cfg = dotenv_values("/etc/tinc-hub/config.env")

    data = request.json or {}
    ip = (data.get("ip") or env_cfg.get("ROUTER_IP") or "192.168.1.1").strip()
    user = (data.get("user") or env_cfg.get("ROUTER_USER") or "admin").strip()
    pw = data.get("password")
    if not pw:
        pw = env_cfg.get("ROUTER_PASS", "")

    if not pw or pw == "your_password_here":
        return jsonify({"ok": False, "error": "Modem şifresi tanımlı değil."}), 400

    ok, msg = test_router_login(ip, user, pw)
    return jsonify({"ok": ok, "message": msg if ok else None, "error": msg if not ok else None})


@bp.route("/api/settings/router/reboot", methods=["POST"])
@admin_required
def api_reboot_router_now():
    import sys, os
    shared_dir = os.environ.get("TINC_HUB_SHARED", "/opt/tinc-hub/shared")
    if shared_dir not in sys.path:
        sys.path.insert(0, shared_dir)

    try:
        from router_util import reboot_router
    except Exception as e:
        return jsonify({"ok": False, "error": f"router_util modülü yüklenemedi: {e}"}), 500

    from dotenv import dotenv_values
    env_cfg = {}
    if os.path.exists("/etc/tinc-hub/config.env"):
        env_cfg = dotenv_values("/etc/tinc-hub/config.env")

    data = request.json or {}
    ip = (data.get("ip") or env_cfg.get("ROUTER_IP") or "192.168.1.1").strip()
    user = (data.get("user") or env_cfg.get("ROUTER_USER") or "admin").strip()
    pw = data.get("password")
    if not pw:
        pw = env_cfg.get("ROUTER_PASS", "")

    if not pw or pw == "your_password_here":
        return jsonify({"ok": False, "error": "Modem şifresi tanımlı değil."}), 400

    ok, msg = reboot_router(ip, user, pw)
    return jsonify({"ok": ok, "message": msg if ok else None, "error": msg if not ok else None})


