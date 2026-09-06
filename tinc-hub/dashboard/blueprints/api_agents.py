from flask import Blueprint, render_template, jsonify, request, redirect, url_for, session, Response, stream_with_context
from app import *
from blueprints.api_system import _now

bp = Blueprint('api_agents', __name__)

@bp.route('/api/agents')
@auth_required
def api_agents_list():
    if not tinchub_db:
        return jsonify([])
    agents = tinchub_db.get_all_agents()
    for agent in agents:
        # Add latest metrics
        if agent['id'] == 'disk-sentinel':
            m = tinchub_db.get_latest_metric('disk-sentinel', 'disk_percent')
            agent['latest_metric'] = f"{m['value']:.0f}%" if m and m.get('value') is not None else None
            agent['metric_label'] = 'Disk Kullanımı'
        elif agent['id'] == 'ram-cleaner':
            m = tinchub_db.get_latest_metric('ram-cleaner', 'ram_percent')
            agent['latest_metric'] = f"{m['value']:.0f}%" if m and m.get('value') is not None else None
            agent['metric_label'] = 'RAM Kullanımı'
        elif agent['id'] == 'wan-tracker':
            m = tinchub_db.get_latest_metric('wan-tracker', 'wan_ip')
            agent['latest_metric'] = m.get('value_str') if m else None
            agent['metric_label'] = 'WAN IP'
        elif agent['id'] == 'router-guardian':
            m = tinchub_db.get_latest_metric('router-guardian', 'gateway_status')
            agent['latest_metric'] = '✅ Bağlı' if m and m.get('value') == 1 else '❌ Kesik' if m else None
            agent['metric_label'] = 'Gateway'
        else:
            agent['latest_metric'] = None
            agent['metric_label'] = ''
    return jsonify(agents)


@bp.route('/api/agents/<agent_id>/events')
@auth_required
def api_agent_events(agent_id):
    if not tinchub_db:
        return jsonify([])
    hours = int(request.args.get('hours', 24))
    events = tinchub_db.get_recent_events(agent_id=agent_id, hours=hours, limit=50)
    return jsonify(events)


@bp.route('/api/agents/<agent_id>/metrics')
@auth_required
def api_agent_metrics(agent_id):
    if not tinchub_db:
        return jsonify([])
    metric = request.args.get('metric', 'cpu_percent')
    hours = int(request.args.get('hours', 24))
    data = tinchub_db.get_metrics_series(agent_id, metric, hours=hours)
    return jsonify(data)


@bp.route('/agents')
@auth_required
def agents_page():
    if not tinchub_db:
        agents = []
        events = []
    else:
        agents = tinchub_db.get_all_agents()
        events = tinchub_db.get_recent_events(limit=20, hours=24)
    return render_template('agents.html', agents=agents, events=events, now=_now(), has_auth=bool(PASSWORD))





