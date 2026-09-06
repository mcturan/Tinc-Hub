from flask import Blueprint, render_template, jsonify, request, redirect, url_for, session, Response, stream_with_context
from app import *

bp = Blueprint('api_store', __name__)

@bp.route("/api/store", methods=["GET"])
@auth_required
def api_get_store():
    import json
    import os
    store_file = os.path.join(os.path.dirname(__file__), "store.json")
    try:
        with open(store_file, "r") as f:
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
    data = request.get_json()
    store_app_id = data.get("id")
    if not store_app_id:
        return jsonify({"ok": False, "error": "App ID gerekli."}), 400
        
    from installer import install_app_from_store
    res = install_app_from_store(store_app_id)
    return jsonify(res), (200 if res.get("ok") else 500)


