from blueprints.api_system import _system_summary
from flask import Blueprint, jsonify, request
from app import auth_required, config, load_apps, tinchub_db
import requests

bp = Blueprint('api_remote', __name__, url_prefix='/api/remote')

@bp.route('/summary')
def api_remote_summary():
    token = request.headers.get('X-Hub-Token')
    if config.get('HUB_API_TOKEN') and token != config.get('HUB_API_TOKEN'):
        return jsonify({'error': 'Unauthorized'}), 401
    
    from health import get_cached_health
    apps_data = []
    for a in load_apps():
        svc = a.get('service')
        health = get_cached_health().get(svc, {})
        apps_data.append({
            'name': a.get('name', svc),
            'service': svc,
            'running': health.get('status') == 'healthy',
            'icon': a.get('icon', '📦')
        })
    
    return jsonify({
        'name': config.get('HUB_NAME', 'Local Hub'),
        'system': _system_summary(),
        'apps': apps_data,
        'agents': tinchub_db.get_all_agents() if tinchub_db else [],
        'alerts': tinchub_db.get_recent_events(hours=1, limit=5) if tinchub_db else []
    })

# Simulating slave list from config or DB
def get_slaves():
    import json
    slaves_str = config.get('SLAVE_HUBS', '[]')
    try:
        return json.loads(slaves_str)
    except:
        return []

@bp.route('/slaves')
@auth_required
def api_remote_slaves():
    slaves = get_slaves()
    results = []
    for slave in slaves:
        try:
            r = requests.get(
                f"{slave['url'].rstrip('/')}/api/remote/summary",
                headers={'X-Hub-Token': slave.get('token', '')},
                timeout=5
            )
            if r.status_code == 200:
                results.append({"status": "ok", "slave": slave, "data": r.json()})
            else:
                results.append({"status": "error", "slave": slave, "error": f"HTTP {r.status_code}"})
        except Exception as e:
            results.append({"status": "error", "slave": slave, "error": str(e)})
    return jsonify(results)

@bp.route('/action', methods=['POST'])
def api_remote_action():
    """Uzak master'ın bu slave üzerinde servis yönetmesi için."""
    token = request.headers.get('X-Hub-Token')
    if config.get('HUB_API_TOKEN') and token != config.get('HUB_API_TOKEN'):
        return jsonify({'error': 'Unauthorized'}), 401
    
    data = request.get_json()
    action = data.get('action')      # start, stop, restart
    service = data.get('service')     # servis adı
    
    if not action or not service:
        return jsonify({'error': 'action ve service gerekli'}), 400
    
    if action not in ('start', 'stop', 'restart'):
        return jsonify({'error': 'Geçersiz aksiyon'}), 400
    
    try:
        import subprocess
        r = subprocess.run(
            ['sudo', 'systemctl', action, service],
            capture_output=True, text=True, timeout=15
        )
        return jsonify({
            'ok': r.returncode == 0,
            'stdout': r.stdout,
            'stderr': r.stderr
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@bp.route('/slaves/<int:idx>/action', methods=['POST'])
@auth_required
def api_slave_action(idx):
    """Master'dan bir slave'e uzaktan komut gönder."""
    slaves = get_slaves()
    if idx >= len(slaves):
        return jsonify({'error': 'Slave bulunamadı'}), 404
    
    slave = slaves[idx]
    data = request.get_json()
    
    try:
        r = requests.post(
            f"{slave['url'].rstrip('/')}/api/remote/action",
            headers={'X-Hub-Token': slave.get('token', '')},
            json=data,
            timeout=15
        )
        return jsonify(r.json()), r.status_code
    except Exception as e:
        return jsonify({'error': str(e)}), 500
