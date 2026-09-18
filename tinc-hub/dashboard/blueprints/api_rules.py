from flask import Blueprint, jsonify, request
from app import auth_required, admin_required
import os, sys, uuid, time

bp = Blueprint('api_rules', __name__, url_prefix='/api/rules')

SHARED_DIR = os.environ.get("TINC_HUB_SHARED", "/opt/tinc-hub/shared")
if SHARED_DIR not in sys.path:
    sys.path.insert(0, SHARED_DIR)

try:
    from rules_engine import load_rules, save_rules, engine as _autopilot_engine
    _engine_available = True
except Exception:
    _engine_available = False
    def load_rules(): return []
    def save_rules(r): pass
    _autopilot_engine = None


# ── CRUD ──────────────────────────────────────────────────────────────────────

@bp.route('', methods=['GET'])
@auth_required
def get_rules():
    return jsonify(load_rules())


@bp.route('', methods=['POST'])
@admin_required
def add_rule():
    rules = load_rules()
    data = request.json or {}
    data['id'] = data.get('id') or str(uuid.uuid4())[:8]
    data.setdefault('enabled', True)
    data.setdefault('cooldown', 300)
    rules.append(data)
    save_rules(rules)
    return jsonify({"ok": True, "id": data['id']})


@bp.route('/<rule_id>', methods=['PUT'])
@admin_required
def update_rule(rule_id):
    rules = load_rules()
    data = request.json or {}
    data['id'] = rule_id
    for i, r in enumerate(rules):
        if r.get('id') == rule_id:
            rules[i] = data
            break
    save_rules(rules)
    return jsonify({"ok": True})


@bp.route('/<rule_id>', methods=['DELETE'])
@admin_required
def delete_rule(rule_id):
    rules = load_rules()
    rules = [r for r in rules if r.get('id') != rule_id]
    save_rules(rules)
    return jsonify({"ok": True})


@bp.route('/<rule_id>/toggle', methods=['POST'])
@admin_required
def toggle_rule(rule_id):
    """Kuralı etkinleştir / devre dışı bırak."""
    rules = load_rules()
    for r in rules:
        if r.get('id') == rule_id:
            r['enabled'] = not r.get('enabled', True)
            save_rules(rules)
            return jsonify({"ok": True, "enabled": r['enabled']})
    return jsonify({"ok": False, "error": "Kural bulunamadı"}), 404


# ── Autopilot Durum & Anlık Çalıştırma ────────────────────────────────────────

@bp.route('/status', methods=['GET'])
@auth_required
def autopilot_status():
    """Autopilot motor durumu ve son tetiklenme zamanlarını döner."""
    if not _engine_available or _autopilot_engine is None:
        return jsonify({"ok": False, "running": False,
                        "error": "rules_engine modülü yüklenemedi"})
    triggered = {
        rule_id: {
            "last_triggered": ts,
            "last_triggered_human": _fmt_ts(ts)
        }
        for rule_id, ts in _autopilot_engine.last_triggered.items()
    }
    return jsonify({
        "ok": True,
        "running": True,
        "rule_count": len(load_rules()),
        "engine_available": _engine_available,
        "last_triggered": triggered
    })


@bp.route('/<rule_id>/run', methods=['POST'])
@admin_required
def run_rule_now(rule_id):
    """Belirtilen kuralı soğuma süresini gözetmeksizin anında çalıştırır."""
    if not _engine_available or _autopilot_engine is None:
        return jsonify({"ok": False, "error": "Autopilot motoru hazır değil"}), 503

    rules = load_rules()
    rule = next((r for r in rules if r.get('id') == rule_id), None)
    if not rule:
        return jsonify({"ok": False, "error": "Kural bulunamadı"}), 404

    # Soğuma süresini bypass et — koşul kontrolü olmadan eylemleri çalıştır
    actions = rule.get("actions") or ([rule["action"]] if rule.get("action") else [])
    results = []
    for act in actions:
        ok = _autopilot_engine.executor.execute(act, rule_name=rule.get("name", rule_id))
        results.append({"type": act.get("type"), "ok": ok})
    _autopilot_engine.last_triggered[rule_id] = time.time()

    return jsonify({"ok": True, "rule": rule.get("name"), "results": results})


@bp.route('/run-all', methods=['POST'])
@admin_required
def run_all_rules():
    """Tüm etkin kuralları anlık olarak değerlendirir (koşul kontrolü yapılır)."""
    if not _engine_available or _autopilot_engine is None:
        return jsonify({"ok": False, "error": "Autopilot motoru hazır değil"}), 503
    _autopilot_engine.evaluate_all()
    return jsonify({"ok": True, "message": "Tüm kurallar değerlendirildi."})


@bp.route('/examples', methods=['GET'])
@auth_required
def get_examples():
    """Örnek kural şablonları döner."""
    examples = [
        {
            "name": "Disk %85'i geçince temizle",
            "condition": {"type": "metric_threshold", "metric": "disk_percent",
                          "operator": ">", "value": 85},
            "actions": [
                {"type": "run_command", "command": "journalctl --vacuum-time=7d"},
                {"type": "telegram", "message": "⚠️ Disk doluluk %85 aşıldı, otomatik temizlik yapıldı."}
            ],
            "cooldown": 3600
        },
        {
            "name": "nginx çöktüğünde yeniden başlat",
            "condition": {"type": "service_down", "service": "nginx"},
            "actions": [
                {"type": "restart_service", "service": "nginx"},
                {"type": "telegram", "message": "🔄 nginx çöktü, otomatik yeniden başlatıldı."}
            ],
            "cooldown": 300
        },
        {
            "name": "RAM %90'ı geçince uyar",
            "condition": {"type": "metric_threshold", "metric": "ram_percent",
                          "operator": ">", "value": 90},
            "action": {"type": "telegram",
                       "message": "🔴 RAM kullanımı kritik seviyede!"},
            "cooldown": 1800
        },
        {
            "name": "Her gün 03:00'da modem yeniden başlat",
            "condition": {"type": "time_match", "time": "03:00"},
            "action": {"type": "restart_service", "service": "tinc-hub-router-guardian"},
            "cooldown": 82800
        },
        {
            "name": "CPU %95 üzerinde uyar",
            "condition": {"type": "metric_threshold", "metric": "cpu_percent",
                          "operator": ">", "value": 95},
            "action": {"type": "telegram",
                       "message": "🔥 CPU kullanımı %95 üzerinde!"},
            "cooldown": 600
        }
    ]
    return jsonify(examples)


# ── Yardımcı ─────────────────────────────────────────────────────────────────

def _fmt_ts(ts: float) -> str:
    """Unix timestamp'i okunabilir formata çevirir."""
    try:
        from datetime import datetime
        return datetime.fromtimestamp(ts).strftime("%d.%m.%Y %H:%M:%S")
    except Exception:
        return str(ts)
