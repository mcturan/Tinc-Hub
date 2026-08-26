#!/usr/bin/env python3
"""
TINC Köle — Dashboard
Tüm agent'ların durumunu gösteren web arayüzü.
Port: 9010
"""

import os
import sys
import json
import logging
from datetime import datetime, timedelta
from flask import Flask, render_template, jsonify, request, abort

# Shared DB modülünü import et
sys.path.insert(0, '/opt/kole/shared')
try:
    import db
    db.init_db()
except Exception as e:
    print(f"[UYARI] DB başlatılamadı: {e}")
    db = None

# Config
from dotenv import dotenv_values
config = dotenv_values('/etc/kole/config.env')

PORT = int(config.get('DASHBOARD_PORT', 9010))
HOST = config.get('DASHBOARD_HOST', '0.0.0.0')
SECRET = config.get('DASHBOARD_SECRET_KEY', 'kole-secret-2024')

# Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [DASHBOARD] %(levelname)s %(message)s',
    handlers=[
        logging.FileHandler('/var/log/kole/dashboard.log'),
        logging.StreamHandler()
    ]
)
log = logging.getLogger('kole-dashboard')

app = Flask(__name__)
app.secret_key = SECRET


# ─────────────────────────────────────────────
# Yardımcı fonksiyonlar
# ─────────────────────────────────────────────

def safe_db(func, *args, fallback=None, **kwargs):
    """DB hata yönetimi."""
    if db is None:
        return fallback
    try:
        return func(*args, **kwargs)
    except Exception as e:
        log.error(f"DB hatası ({func.__name__}): {e}")
        return fallback


def agent_health(agent: dict) -> str:
    """Agent'ın son görülme zamanına göre sağlık durumu döner."""
    if not agent.get('last_seen'):
        return 'unknown'
    try:
        last = datetime.fromisoformat(agent['last_seen'])
        delta = datetime.utcnow() - last
        if delta < timedelta(minutes=2):
            return 'healthy'
        elif delta < timedelta(minutes=10):
            return 'warning'
        else:
            return 'dead'
    except Exception:
        return 'unknown'


def format_uptime(since_str: str) -> str:
    """'2024-01-01T00:00:00' → '2g 3s 15d'"""
    if not since_str:
        return 'Bilinmiyor'
    try:
        since = datetime.fromisoformat(since_str)
        delta = datetime.now() - since
        days = delta.days
        hours = delta.seconds // 3600
        minutes = (delta.seconds % 3600) // 60
        parts = []
        if days:
            parts.append(f"{days}g")
        if hours:
            parts.append(f"{hours}s")
        parts.append(f"{minutes}d")
        return ' '.join(parts)
    except Exception:
        return since_str


# ─────────────────────────────────────────────
# Routes — HTML Sayfalar
# ─────────────────────────────────────────────

@app.route('/')
def index():
    agents = safe_db(db.get_all_agents, fallback=[])
    for a in agents:
        a['health'] = agent_health(a)
        a['uptime_str'] = format_uptime(a.get('last_seen'))

    recent_events = safe_db(db.get_recent_events, limit=20, hours=6, fallback=[])
    wan_history = safe_db(db.get_wan_history, limit=5, fallback=[])

    # Özet istatistikler
    total = len(agents)
    healthy = sum(1 for a in agents if a['health'] == 'healthy')
    warning = sum(1 for a in agents if a['health'] == 'warning')
    dead = sum(1 for a in agents if a['health'] == 'dead')

    # Disk / RAM son metrik
    disk_metric = safe_db(db.get_latest_metric, 'disk-sentinel', 'disk_percent', fallback=None)
    ram_metric = safe_db(db.get_latest_metric, 'ram-cleaner', 'ram_percent', fallback=None)
    swap_metric = safe_db(db.get_latest_metric, 'ram-cleaner', 'swap_percent', fallback=None)
    wan_metric = safe_db(db.get_latest_metric, 'wan-tracker', 'wan_ip', fallback=None)

    return render_template('index.html',
        agents=agents,
        recent_events=recent_events,
        wan_history=wan_history,
        total=total, healthy=healthy, warning=warning, dead=dead,
        disk_metric=disk_metric,
        ram_metric=ram_metric,
        swap_metric=swap_metric,
        wan_metric=wan_metric,
        now=datetime.now().strftime('%d.%m.%Y %H:%M:%S')
    )


@app.route('/agent/<agent_id>')
def agent_detail(agent_id):
    agents = safe_db(db.get_all_agents, fallback=[])
    agent = next((a for a in agents if a['id'] == agent_id), None)
    if not agent:
        abort(404)
    agent['health'] = agent_health(agent)

    events = safe_db(db.get_recent_events, agent_id=agent_id, limit=100, hours=48, fallback=[])
    
    # Metrik serileri
    metrics_data = {}
    metric_names = {
        'router-guardian': ['ping_ms', 'wan_ip'],
        'disk-sentinel': ['disk_percent'],
        'ram-cleaner': ['ram_percent', 'swap_percent'],
        'service-watchdog': ['docker_running_count'],
        'wan-tracker': ['wan_ip'],
    }
    for metric in metric_names.get(agent_id, []):
        series = safe_db(db.get_metrics_series, agent_id, metric, hours=24, fallback=[])
        metrics_data[metric] = series

    return render_template('agent_detail.html',
        agent=agent,
        events=events,
        metrics_data=metrics_data,
        now=datetime.now().strftime('%d.%m.%Y %H:%M:%S')
    )


@app.route('/events')
def events_page():
    level = request.args.get('level')
    agent_id = request.args.get('agent')
    hours = int(request.args.get('hours', 24))
    events = safe_db(db.get_recent_events,
                     agent_id=agent_id, level=level,
                     limit=500, hours=hours, fallback=[])
    agents = safe_db(db.get_all_agents, fallback=[])
    return render_template('events.html',
        events=events, agents=agents,
        selected_level=level, selected_agent=agent_id,
        hours=hours,
        now=datetime.now().strftime('%d.%m.%Y %H:%M:%S')
    )


# ─────────────────────────────────────────────
# Routes — JSON API
# ─────────────────────────────────────────────

@app.route('/api/agents')
def api_agents():
    agents = safe_db(db.get_all_agents, fallback=[])
    for a in agents:
        a['health'] = agent_health(a)
    return jsonify(agents)


@app.route('/api/events')
def api_events():
    agent_id = request.args.get('agent')
    level = request.args.get('level')
    hours = int(request.args.get('hours', 6))
    limit = int(request.args.get('limit', 100))
    events = safe_db(db.get_recent_events,
                     agent_id=agent_id, level=level,
                     limit=limit, hours=hours, fallback=[])
    return jsonify(events)


@app.route('/api/metrics/<agent_id>/<metric>')
def api_metric(agent_id, metric):
    hours = int(request.args.get('hours', 24))
    series = safe_db(db.get_metrics_series, agent_id, metric, hours=hours, fallback=[])
    return jsonify(series)


@app.route('/api/summary')
def api_summary():
    agents = safe_db(db.get_all_agents, fallback=[])
    for a in agents:
        a['health'] = agent_health(a)
    
    disk = safe_db(db.get_latest_metric, 'disk-sentinel', 'disk_percent', fallback=None)
    ram = safe_db(db.get_latest_metric, 'ram-cleaner', 'ram_percent', fallback=None)
    swap = safe_db(db.get_latest_metric, 'ram-cleaner', 'swap_percent', fallback=None)
    wan = safe_db(db.get_latest_metric, 'wan-tracker', 'wan_ip', fallback=None)
    
    return jsonify({
        'agents': {
            'total': len(agents),
            'healthy': sum(1 for a in agents if a['health'] == 'healthy'),
            'warning': sum(1 for a in agents if a['health'] == 'warning'),
            'dead': sum(1 for a in agents if a['health'] == 'dead'),
        },
        'disk_percent': disk['value'] if disk else None,
        'ram_percent': ram['value'] if ram else None,
        'swap_percent': swap['value'] if swap else None,
        'wan_ip': wan['value_str'] if wan else None,
        'timestamp': datetime.utcnow().isoformat()
    })


@app.route('/api/wan-history')
def api_wan_history():
    history = safe_db(db.get_wan_history, limit=20, fallback=[])
    return jsonify(history)


if __name__ == '__main__':
    os.makedirs('/var/log/kole', exist_ok=True)
    log.info(f"TINC Köle Dashboard başlatılıyor → http://{HOST}:{PORT}")
    app.run(host=HOST, port=PORT, debug=False)
