#!/usr/bin/env python3
"""
TincProcess — Microsoft Process Explorer Equivalent for TincHub & Linux
Part of the TincSuite Home Server OS.
"""

import os
import sys
from pathlib import Path
from flask import Flask, render_template, jsonify, request, redirect

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from config import load_config, save_config
import process_engine

app = Flask(
    __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/static"
)
app.secret_key = os.urandom(24)

@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return response

@app.route("/")
def index():
    cfg = load_config()
    summary = process_engine.get_system_summary()
    return render_template("index.html", cfg=cfg, summary=summary)

@app.route("/api/system")
def api_system():
    return jsonify(process_engine.get_system_summary())

@app.route("/api/processes")
def api_processes():
    mode = request.args.get("mode", "tree").lower()
    processes = process_engine.get_all_processes()
    if mode == "tree":
        data = process_engine.build_process_tree(processes)
    else:
        # Sort flat list by cpu desc, then ram desc
        processes.sort(key=lambda x: (x["cpu"], x["ram_mb"]), reverse=True)
        data = processes
    return jsonify({"ok": True, "count": len(processes), "processes": data})

@app.route("/api/process/<int:pid>")
def api_process_detail(pid):
    detail = process_engine.get_process_detail(pid)
    return jsonify(detail)

@app.route("/api/process/<int:pid>/action", methods=["POST"])
def api_process_action(pid):
    data = request.get_json() or {}
    action = data.get("action", "")
    nice_val = data.get("nice")
    res = process_engine.execute_process_action(pid, action, nice_val=nice_val)
    status_code = 200 if res.get("ok") else 400
    return jsonify(res), status_code

@app.route("/api/ports")
def api_ports():
    ports_map = process_engine.get_listening_ports()
    # Invert mapping: port -> pid & process info
    flat_procs = {p["pid"]: p for p in process_engine.get_all_processes()}
    result = []
    for pid, port_list in ports_map.items():
        proc = flat_procs.get(pid, {})
        for p in port_list:
            result.append({
                "port": p["port"],
                "ip": p["ip"],
                "family": p["family"],
                "pid": pid,
                "name": proc.get("name", "Bilinmiyor"),
                "user": proc.get("user", "Bilinmiyor"),
                "cpu": proc.get("cpu", 0.0),
                "ram_mb": proc.get("ram_mb", 0.0)
            })
    result.sort(key=lambda x: x["port"])
    return jsonify({"ok": True, "count": len(result), "ports": result})

@app.route("/api/config/port", methods=["POST"])
def api_change_port():
    data = request.get_json() or {}
    new_port = data.get("port")
    if not new_port:
        return jsonify({"ok": False, "error": "Yeni port belirtilmedi"}), 400
    try:
        new_port = int(new_port)
        if new_port < 1024 or new_port > 65535:
            return jsonify({"ok": False, "error": "Port 1024-65535 aralığında olmalıdır"}), 400
    except ValueError:
        return jsonify({"ok": False, "error": "Geçersiz port formatı"}), 400

    cfg = load_config()
    cfg["port"] = new_port
    save_config(cfg)
    return jsonify({"ok": True, "port": new_port, "message": "Port güncellendi. Servis yeniden başlatılıyor."})

if __name__ == "__main__":
    cfg = load_config()
    port = int(cfg.get("port", 9014))
    host = cfg.get("host", "0.0.0.0")
    print(f"🔬 TincProcess — Process Explorer dinleniyor: http://{host}:{port}")
    app.run(host=host, port=port, debug=False)
