from flask import Blueprint, render_template, jsonify, request, redirect, url_for, session, Response, stream_with_context
from app import *
from registry import load_apps, save_apps, add_app

bp = Blueprint('api_store', __name__)

def _get_store_path():
    candidates = [
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "store.json"),
        "/etc/tinc-hub/store.json",
        os.path.join(os.path.dirname(__file__), "store.json")
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]

@bp.route("/api/store", methods=["GET"])
@auth_required
def api_get_store():
    import json
    store_file = _get_store_path()
    try:
        with open(store_file, "r", encoding="utf-8") as f:
            store_apps = json.load(f)

        # Check which apps are installed
        installed_apps = load_apps()
        installed_ids = [a.get("id") for a in installed_apps]

        for app in store_apps:
            app["is_installed"] = app["id"] in installed_ids

        return jsonify(store_apps)
    except Exception as e:
        return jsonify([])

@bp.route("/api/store/install", methods=["POST"])
@auth_required
def api_store_install():
    data = request.get_json() or {}
    store_app_id = data.get("id")
    if not store_app_id:
        return jsonify({"ok": False, "error": "App ID gerekli."}), 400

    import json
    store_file = _get_store_path()
    store_data = []
    if os.path.exists(store_file):
        with open(store_file, "r", encoding="utf-8") as f:
            store_data = json.load(f)

    app_meta = next((a for a in store_data if a.get("id") == store_app_id), None)
    if not app_meta:
        return jsonify({"ok": False, "error": "Uygulama şablonu bulunamadı."}), 404

    # If the app has a repo, try installer
    if app_meta.get("repo"):
        try:
            from installer import install_app_from_store
            res = install_app_from_store(store_app_id)
            if res.get("ok"):
                return jsonify(res)
        except Exception:
            pass

    # Direct 1-Click addition to apps.yaml
    apps = load_apps()
    if not any(a.get("id") == store_app_id for a in apps):
        new_app = {
            "id": app_meta["id"],
            "name": app_meta["name"],
            "description": app_meta.get("description", ""),
            "url": app_meta.get("url", f"http://192.168.1.10:{app_meta.get('port', 8080)}"),
            "internal_url": app_meta.get("internal_url", f"http://127.0.0.1:{app_meta.get('port', 8080)}"),
            "health_url": app_meta.get("health_url", f"http://127.0.0.1:{app_meta.get('port', 8080)}"),
            "service": app_meta.get("service", app_meta["id"]),
            "port": app_meta.get("port"),
            "category": app_meta.get("category", "Uygulama"),
            "icon": app_meta.get("icon", "📦"),
            "health_check": "http" if app_meta.get("health_url") else "systemd",
            "pinned": True
        }
        apps.append(new_app)
        save_apps(apps)
        return jsonify({"ok": True, "message": f"{app_meta['name']} TincHub paneline başarıyla eklendi!"})
    else:
        return jsonify({"ok": True, "message": f"{app_meta['name']} zaten panelde mevcut."})


