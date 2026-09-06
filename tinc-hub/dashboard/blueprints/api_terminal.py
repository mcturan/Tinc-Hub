from flask import Blueprint, jsonify, request
from app import auth_required
import subprocess

bp = Blueprint('api_terminal', __name__, url_prefix='/api/terminal')

@bp.route('/exec', methods=['POST'])
@auth_required
def api_terminal_exec():
    data = request.get_json()
    cmd = data.get('command', '')
    
    BLOCKED = ['rm -rf /', 'mkfs', ':(){', 'dd if=']
    for b in BLOCKED:
        if b in cmd:
            return jsonify({'error': 'Bu komut engellendi.'}), 403
    
    try:
        r = subprocess.run(
            ['bash', '-c', cmd],
            capture_output=True, text=True, timeout=30,
            cwd='/home/turan'
        )
        return jsonify({
            'stdout': r.stdout,
            'stderr': r.stderr,
            'returncode': r.returncode
        })
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Komut zaman aşımına uğradı (30s)'}), 408
