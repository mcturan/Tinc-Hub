from flask import Blueprint, render_template, jsonify, request, redirect, url_for, session, Response, stream_with_context
from app import *
from blueprints.auth import _enrich_apps

bp = Blueprint('api_apps', __name__)

@bp.route("/api/apps")
@auth_required
def api_apps():
    apps = _enrich_apps(load_apps())
    return jsonify(apps)



@bp.route("/api/app/<app_id>")
@auth_required
def api_app(app_id):
    app_data = get_app(app_id)
    if not app_data:
        return jsonify({"error": "Bulunamadı"}), 404
    return jsonify(_enrich_apps([app_data])[0])



@bp.route("/api/app/<app_id>/health")
@auth_required
def api_health(app_id):
    app_data = get_app(app_id)
    if not app_data:
        return jsonify({"error": "Bulunamadı"}), 404
    result = check_app(app_data)
    return jsonify(result)



@bp.route("/api/app/<app_id>/action", methods=["POST"])
@admin_required
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
        if app_data.get("is_user_service"):
            cmd = ["sudo", "-u", RUN_USER, f"XDG_RUNTIME_DIR=/run/user/{RUN_UID}", "systemctl", "--user", action, unit]
        else:
            cmd = ["systemctl", action, unit]
            
        r = subprocess.run(
            cmd,
            capture_output=True, text=True, timeout=15
        )
        ok = r.returncode == 0
        msg = r.stdout.strip() or r.stderr.strip() or f"{action} {'başarılı' if ok else 'başarısız'}"
        log.info(f"Eylem: {action} {unit} → {'OK' if ok else 'FAIL'}")
        return jsonify({"ok": ok, "message": msg})
    except Exception as e:
        return jsonify({"ok": False, "message": str(e)}), 500


# ── API: Settings ─────────────────────────────────────────────────────────────


@bp.route("/api/settings/apps", methods=["GET"])
@auth_required
def api_settings_apps_get():
    return jsonify(load_apps())



@bp.route("/api/settings/apps/add", methods=["POST"])
@admin_required
def api_add_app():
    data = request.get_json() or {}
    if not data.get("name"):
        return jsonify({"error": "İsim gerekli"}), 400
    app_data = add_app(data)
    return jsonify({"ok": True, "app": app_data}), 201



@bp.route("/api/settings/apps/<app_id>", methods=["PUT"])
@admin_required
def api_update_app(app_id):
    data = request.get_json() or {}
    updated = update_app(app_id, data)
    if not updated:
        return jsonify({"error": "Bulunamadı"}), 404
    return jsonify({"ok": True, "app": updated})



@bp.route("/api/settings/apps/<app_id>", methods=["DELETE"])
@admin_required
def api_delete_app(app_id):
    uninstall = request.args.get('uninstall', 'false') == 'true'
    logs = []
    
    if uninstall:
        app_data = next((a for a in load_apps() if a.get("id") == app_id), None)
        if app_data and app_data.get("service"):
            service = app_data["service"]
            is_user = app_data.get("is_user_service", False)
            try:
                if is_user:
                    p1 = subprocess.run(["sudo", f"XDG_RUNTIME_DIR=/run/user/{RUN_UID}", "-u", RUN_USER, "systemctl", "--user", "stop", service], capture_output=True, text=True, timeout=10)
                    p2 = subprocess.run(["sudo", f"XDG_RUNTIME_DIR=/run/user/{RUN_UID}", "-u", RUN_USER, "systemctl", "--user", "disable", service], capture_output=True, text=True, timeout=10)
                    logs.append(str(p1.stdout) + "\n" + str(p1.stderr))
                    logs.append(str(p2.stdout) + "\n" + str(p2.stderr))
                else:
                    p1 = subprocess.run(["sudo", "systemctl", "stop", service], capture_output=True, text=True, timeout=10)
                    p2 = subprocess.run(["sudo", "systemctl", "disable", service], capture_output=True, text=True, timeout=10)
                    logs.append(str(p1.stdout) + "\n" + str(p1.stderr))
                    logs.append(str(p2.stdout) + "\n" + str(p2.stderr))
            except Exception as e:
                return jsonify({"ok": False, "error": f"Servis durdurulamadı: {str(e)}"}), 500
                
            repo = app_data.get("repo")
            if repo and (repo.startswith("file://") or repo.startswith("http")):
                app_name_slug = repo.rstrip('/').split('/')[-1]
                repo_base = config.get("REPO_BASE_DIR", f"/home/{RUN_USER}/101")
                target_dir = f"{repo_base}/{app_name_slug}"
                import os
                uninstall_script = f"{target_dir}/uninstall.sh"
                if os.path.exists(uninstall_script):
                    p3 = subprocess.run(["sudo", "bash", uninstall_script], capture_output=True, text=True)
                    logs.append(str(p3.stdout) + "\n" + str(p3.stderr))
                else:
                    logs.append("\n[UYARI] uninstall.sh bulunamadı! Sadece servis durduruldu, uygulama dosyaları sistemde (apt, snap vb. ile kurulduysa) kalmış olabilir. Tamamen silmek için manuel müdahale gerekebilir.")
            else:
                logs.append("\n[UYARI] Bu uygulamanın özel bir kaldırıcı betiği yok. Sadece servis durduruldu. (apt, snap veya manuel kurulduysa dosyalar hala sistemdedir.)")
                
    ok = delete_app(app_id)
    return jsonify({"ok": ok, "log": "\n".join(logs)})


@bp.route("/api/settings/apps/<app_id>/update", methods=["POST"])
@admin_required
def api_pull_update_app(app_id):
    from installer import update_app_local
    data = request.get_json() or {}
    new_repo = data.get("repo")
    res = update_app_local(app_id, new_repo)
    return jsonify(res), (200 if res.get("ok") else 500)


@bp.route("/api/settings/apps/<app_id>/pin", methods=["POST"])
@auth_required
def api_pin_app(app_id):
    data = request.get_json() or {}
    pinned = bool(data.get("pinned", True))
    updated = update_app(app_id, {"pinned": pinned})
    return jsonify({"ok": bool(updated)})


@bp.route("/api/app/<app_id>/configure", methods=["POST"])
@admin_required
def api_configure_app(app_id):
    """CasaOS stili dinamik port ve uygulama yapılandırması"""
    import json
    data = request.get_json() or {}
    app_data = get_app(app_id)
    if not app_data:
        return jsonify({"error": "Uygulama bulunamadı"}), 404

    new_name = data.get("name", app_data.get("name"))
    new_port = data.get("port")
    new_url = data.get("url", app_data.get("url"))
    new_icon = data.get("icon", app_data.get("icon"))
    new_service = data.get("service", app_data.get("service"))
    new_cat = data.get("category", app_data.get("category"))

    updates = {
        "name": new_name,
        "icon": new_icon,
        "service": new_service,
        "category": new_cat,
    }

    port_changed = False
    if new_port:
        try:
            p = int(new_port)
            if p != app_data.get("port"):
                updates["port"] = p
                port_changed = True
                old_port = app_data.get("port")
                if old_port and new_url and f":{old_port}" in new_url:
                    new_url = new_url.replace(f":{old_port}", f":{p}")
                updates["url"] = new_url
                updates["internal_url"] = f"http://127.0.0.1:{p}"
                updates["health_url"] = f"http://127.0.0.1:{p}"
        except ValueError:
            pass

    if "url" not in updates and new_url:
        updates["url"] = new_url

    update_app(app_id, updates)

    service_restarted = False
    if port_changed and new_port:
        p = int(new_port)
        if app_id in ("tnote", "tincnote"):
            for cfg_dir in ("/opt/tinc-hub/TNOTE/data", "/home/turan/101/tinc-hub/TNOTE/data"):
                try:
                    os.makedirs(cfg_dir, exist_ok=True)
                    with open(os.path.join(cfg_dir, "config.json"), "w") as f:
                        json.dump({"port": p}, f, indent=2)
                except Exception:
                    pass
            subprocess.run(["systemctl", "restart", "tincnote"], capture_output=True)
            service_restarted = True
        elif app_id == "tincnet":
            for cfg_dir in ("/opt/tincnet", "/home/turan/101/tincnet"):
                try:
                    os.makedirs(cfg_dir, exist_ok=True)
                    with open(os.path.join(cfg_dir, "config.json"), "w") as f:
                        json.dump({"port": p}, f, indent=2)
                except Exception:
                    pass
            subprocess.run(["systemctl", "restart", "tincnet"], capture_output=True)
            service_restarted = True
        elif new_service:
            unit = new_service if new_service.endswith(".service") else f"{new_service}.service"
            subprocess.run(["systemctl", "restart", unit], capture_output=True)
            service_restarted = True

    return jsonify({"ok": True, "app": get_app(app_id), "service_restarted": service_restarted})


@bp.route("/api/system/check-port", methods=["POST"])
@admin_required
def api_check_port():
    data = request.get_json() or {}
    port = int(data.get("port", 0))
    if port <= 0 or port > 65535:
        return jsonify({"ok": False, "error": "Geçersiz port"}), 400
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(1.0)
    res = sock.connect_ex(('127.0.0.1', port))
    sock.close()
    in_use = (res == 0)
    return jsonify({"ok": True, "port": port, "in_use": in_use})


# ── API: Discovery ───────────────────────────────────────────────────────────


