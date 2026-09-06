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


# ── API: Discovery ───────────────────────────────────────────────────────────


