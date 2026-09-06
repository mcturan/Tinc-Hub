from flask import Blueprint, jsonify, request
import os, sys

bp = Blueprint('api_notifications', __name__, url_prefix='/api/notifications')

SHARED_DIR = os.environ.get("TINC_HUB_SHARED", "/opt/tinc-hub/shared")
if SHARED_DIR not in sys.path:
    sys.path.insert(0, SHARED_DIR)

try:
    import db as tinchub_db
except Exception:
    tinchub_db = None

from app import auth_required

@bp.route('')
@auth_required
def api_notifications():
    """Son 50 bildirimi döner."""
    if not tinchub_db:
        return jsonify([])
    events = tinchub_db.get_recent_events(limit=50, hours=48)
    notifications = [e for e in events if e.get('level') in ('WARN', 'ERROR', 'CRITICAL')]
    return jsonify(notifications)

@bp.route('/count')
@auth_required
def api_notification_count():
    """Okunmamış bildirim sayısını döner."""
    if not tinchub_db:
        return jsonify({"count": 0})
    events = tinchub_db.get_recent_events(limit=100, hours=1)
    critical = [e for e in events if e.get('level') in ('WARN', 'ERROR', 'CRITICAL')]
    return jsonify({"count": len(critical)})
