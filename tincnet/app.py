#!/usr/bin/env python3
"""
TincNet — Network Topology, Analyzer & Monitoring Microservice
Standalone Service running on Port 9011 (or configurable via config.json / TINCNET_PORT).
"""
import os
import sys
import json
import logging
from flask import Flask, render_template, redirect, url_for, session, request, jsonify

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

def load_port():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r") as f:
                cfg = json.load(f)
                if "port" in cfg:
                    return int(cfg["port"])
        except Exception:
            pass
    return int(os.environ.get("TINCNET_PORT", 9011))

DEFAULT_PORT = load_port()
DEFAULT_HOST = os.environ.get("TINCNET_HOST", "0.0.0.0")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [TINCNET] %(levelname)s %(message)s")
log = logging.getLogger("tincnet")

app = Flask(__name__, template_folder="templates", static_folder="static")
app.secret_key = os.environ.get("TINCNET_SECRET", "tincnet-secret-key-2026")

# Mock auth_required for standalone operation
import api_network
api_network.auth_required = lambda f: f

app.register_blueprint(api_network.bp)

@app.route("/")
def index():
    return render_template("network.html", now="", has_auth=False, role="admin")

@app.route("/api/tincnet/port", methods=["GET", "POST"])
def manage_port():
    if request.method == "POST":
        data = request.get_json() or {}
        new_port = int(data.get("port", DEFAULT_PORT))
        with open(CONFIG_PATH, "w") as f:
            json.dump({"port": new_port}, f, indent=2)
        return jsonify({"ok": True, "port": new_port})
    return jsonify({"ok": True, "port": load_port()})

if __name__ == "__main__":
    port = load_port()
    log.info(f"TincNet Başlatılıyor: http://{DEFAULT_HOST}:{port}")
    app.run(host=DEFAULT_HOST, port=port, debug=False)
