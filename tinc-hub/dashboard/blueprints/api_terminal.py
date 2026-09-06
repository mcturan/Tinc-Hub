from flask import Blueprint, jsonify, request, session
from app import auth_required
import subprocess

bp = Blueprint('api_terminal', __name__, url_prefix='/api/terminal')

@bp.route('/exec', methods=['POST'])
@auth_required
def api_terminal_exec():
    if session.get('role') != 'admin':
        return jsonify({'error': 'Bu işlem için admin yetkisi gerekli.'}), 403

    data = request.get_json() or {}
    cmd = data.get('command', '').strip()

    if not cmd:
        return jsonify({'error': 'Komut belirtilmedi.'}), 400

    if len(cmd) > 500:
        return jsonify({'error': 'Komut uzunluğu 500 karakter sınırını aşıyor.'}), 400

    BLOCKED = ['rm -rf', 'mkfs', ':(){', 'dd if=', 'wget ', 'curl ', '> /dev', 'nc ', 'ncat', 'python3 -c', 'python -c', 'bash -i', '/dev/tcp', '/dev/udp']
    for b in BLOCKED:
        if b in cmd:
            return jsonify({'error': f'Güvenlik kısıtlaması: "{b}" komut kalıbı engellendi.'}), 403
    
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
