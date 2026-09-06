from flask import Blueprint, jsonify, request
from app import auth_required
import os, sys, uuid

bp = Blueprint('api_rules', __name__, url_prefix='/api/rules')

SHARED_DIR = os.environ.get("TINC_HUB_SHARED", "/opt/tinc-hub/shared")
if SHARED_DIR not in sys.path:
    sys.path.insert(0, SHARED_DIR)

try:
    from rules_engine import load_rules, save_rules
except Exception:
    pass

@bp.route('', methods=['GET'])
@auth_required
def get_rules():
    return jsonify(load_rules())

@bp.route('', methods=['POST'])
@auth_required
def add_rule():
    rules = load_rules()
    data = request.json
    data['id'] = str(uuid.uuid4())
    rules.append(data)
    save_rules(rules)
    return jsonify({"ok": True})

@bp.route('/<rule_id>', methods=['PUT'])
@auth_required
def update_rule(rule_id):
    rules = load_rules()
    data = request.json
    for i, r in enumerate(rules):
        if r.get('id') == rule_id:
            rules[i] = data
            break
    save_rules(rules)
    return jsonify({"ok": True})

@bp.route('/<rule_id>', methods=['DELETE'])
@auth_required
def delete_rule(rule_id):
    rules = load_rules()
    rules = [r for r in rules if r.get('id') != rule_id]
    save_rules(rules)
    return jsonify({"ok": True})
