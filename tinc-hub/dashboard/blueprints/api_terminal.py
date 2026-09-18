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

    BLOCKED = [
        'rm -rf', 'rm -fr', 'mkfs', ':(){', 'dd if=',
        '> /dev', 'bash -i', 'bash -c', '/dev/tcp', '/dev/udp',
        'ncat', 'python3 -c', 'python -c',
        'base64 -d', 'base64 -D',        # encoded payload execution
        'chmod 777', 'chmod +s',          # dangerous permission changes
        '/etc/shadow', '/etc/passwd',     # sensitive file access
        'systemctl disable tinc-hub',     # self-destruct
        '$(', '`',                        # command substitution
    ]
    # Normalize: boşluk eki, büyük/küçük harf varyantları
    cmd_check = ' '.join(cmd.split())  # çoklu boşlukları normalize et
    for b in BLOCKED:
        if b in cmd_check or b in cmd_check.lower():
            return jsonify({'error': f'Güvenlik kısıtlaması: Bu komut kalıbı engellendi.'}), 403
    
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
