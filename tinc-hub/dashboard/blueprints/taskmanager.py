from flask import Blueprint, render_template, jsonify, request, redirect, url_for, session, Response, stream_with_context
from app import *
from blueprints.api_system import _system_summary
from blueprints.api_system import _now

bp = Blueprint('taskmanager', __name__)

@bp.route('/taskmanager')
@auth_required
def taskmanager_page():
    return render_template('taskmanager.html', now=_now(), has_auth=bool(PASSWORD))


@bp.route('/api/taskmanager')
@auth_required  
def api_taskmanager():
    # Get all managed services with their resource usage
    from discovery import get_service_detail, get_process_info, get_docker_containers
    
    apps = load_apps()
    processes = []
    
    for app_data in apps:
        svc = app_data.get('service')
        if not svc:
            continue
        is_user = app_data.get('is_user_service', False)
        detail = get_service_detail(svc, is_user_service=is_user)
        pid = detail.get('pid')
        running = detail.get('active_state') == 'active'

        # User service veya port fallback
        if not pid and is_user:
            try:
                import psutil
                script_name = (svc or "").split("@")[0].replace("-", "_") + ".py"
                for proc in psutil.process_iter(['pid', 'cmdline']):
                    try:
                        cmd_line = ' '.join(proc.info['cmdline'] or []).lower()
                        if script_name in cmd_line:
                            pid = proc.info['pid']
                            running = True
                            break
                    except Exception:
                        pass
            except Exception:
                pass

        proc_info = get_process_info(pid) if pid else None
        
        processes.append({
            'id': app_data.get('id'),
            'name': app_data.get('name', svc),
            'icon': app_data.get('icon', '📦'),
            'service': svc,
            'type': 'systemd',
            'pid': pid,
            'running': running,
            'cpu_percent': proc_info['cpu_percent'] if proc_info else None,
            'ram_mb': proc_info['ram_mb'] if proc_info else None,
            'since': detail.get('since', ''),
            'is_user_service': is_user
        })
    
    # Add Docker containers
    docker = get_docker_containers()
    for c in docker:
        processes.append({
            'id': c['id'],
            'name': c['name'],
            'icon': '🐳',
            'service': c['name'],
            'type': 'docker',
            'pid': None,
            'running': c['running'],
            'cpu_percent': None,
            'ram_mb': None,
            'since': c.get('state_str', ''),
            'is_user_service': False
        })
    
    # System summary
    system = _system_summary()
    
    return jsonify({'processes': processes, 'system': system})


# ── Ajanlar (Agents) ───────────────────────────────────────────────────────────


