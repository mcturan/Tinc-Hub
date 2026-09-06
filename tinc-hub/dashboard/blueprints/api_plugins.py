from flask import Blueprint, jsonify, request
from app import auth_required
import os, sys

bp = Blueprint('api_plugins', __name__, url_prefix='/api/plugins')

SHARED_DIR = os.environ.get("TINC_HUB_SHARED", "/opt/tinc-hub/shared")
if SHARED_DIR not in sys.path:
    sys.path.insert(0, SHARED_DIR)

try:
    from plugin_manager import plugin_manager
except Exception:
    plugin_manager = None

@bp.route('', methods=['GET'])
@auth_required
def list_plugins():
    if not plugin_manager:
        return jsonify({})
    return jsonify(plugin_manager.plugins)

@bp.route('/install', methods=['POST'])
@auth_required
def install_plugin():
    if not plugin_manager:
        return jsonify({"ok": False, "error": "Plugin sistemi yüklenemedi"}), 500
    data = request.get_json()
    repo_url = data.get('repo_url', '').strip()
    if not repo_url:
        return jsonify({"ok": False, "error": "repo_url gerekli"}), 400
    result = plugin_manager.install(repo_url)
    return jsonify(result), 200 if result.get("ok") else 400

@bp.route('/<plugin_id>', methods=['DELETE'])
@auth_required
def uninstall_plugin(plugin_id):
    if not plugin_manager:
        return jsonify({"ok": False, "error": "Plugin sistemi yüklenemedi"}), 500
    result = plugin_manager.uninstall(plugin_id)
    return jsonify(result), 200 if result.get("ok") else 400
