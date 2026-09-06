import yaml
import os
import time
import subprocess

RULES_FILE = "/etc/tinc-hub/rules.yaml"

def load_rules():
    if not os.path.exists(RULES_FILE):
        return []
    try:
        with open(RULES_FILE, "r") as f:
            data = yaml.safe_load(f)
            return data.get("rules", []) if data else []
    except:
        return []

def save_rules(rules):
    os.makedirs(os.path.dirname(RULES_FILE), exist_ok=True)
    with open(RULES_FILE, "w") as f:
        yaml.safe_dump({"rules": rules}, f)

class RulesEngine:
    def __init__(self):
        self.last_triggered = {}
    
    def evaluate_all(self, current_metrics, services):
        rules = load_rules()
        now = time.time()
        for rule in rules:
            if not rule.get('enabled', True):
                continue
            
            if self.check_condition(rule, current_metrics, services):
                cooldown = rule.get('cooldown', 60)
                last = self.last_triggered.get(rule['id'], 0)
                if now - last >= cooldown:
                    self.execute_action(rule)
                    self.last_triggered[rule['id']] = now

    def check_condition(self, rule, metrics, services):
        cond = rule.get('condition', {})
        ctype = cond.get('type')
        if ctype == 'metric_threshold':
            val = metrics.get(cond.get('metric'))
            if val is None: return False
            op = cond.get('operator')
            ref = float(cond.get('value', 0))
            if op == '>': return val > ref
            elif op == '<': return val < ref
            elif op == '>=': return val >= ref
            elif op == '<=': return val <= ref
            elif op == '==': return val == ref
        elif ctype == 'service_down':
            svc = cond.get('service')
            return svc in services and not services[svc]
        return False
        
    def execute_action(self, rule):
        action = rule.get('action', {})
        atype = action.get('type')
        if atype == 'restart_service':
            subprocess.run(['sudo', 'systemctl', 'restart', action.get('service')])
        elif atype == 'stop_service':
            subprocess.run(['sudo', 'systemctl', 'stop', action.get('service')])
        elif atype == 'start_service':
            subprocess.run(['sudo', 'systemctl', 'start', action.get('service')])
        elif atype == 'run_commands':
            for cmd in action.get('commands', []):
                subprocess.run(cmd, shell=True)

engine = RulesEngine()
