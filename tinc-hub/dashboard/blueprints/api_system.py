from flask import Blueprint, render_template, jsonify, request, redirect, url_for, session, Response, stream_with_context
from app import *
from blueprints.auth import _get_discovery

bp = Blueprint('api_system', __name__)

@bp.route("/api/auditor/scan")
@auth_required
def api_auditor_scan():
    
    logs = []
    logs.append("====== TINC HUB AKILLI DENETÇİ (AI-AUDITOR) ======")
    logs.append("Sistem analizi başlatıldı...\n")
    
    # 1. Disk Kontrolü
    import shutil
    disk = shutil.disk_usage("/")
    disk_percent = disk.used / disk.total * 100
    if disk_percent > 85:
        logs.append(f"[UYARI] Disk kullanımınız çok yüksek (%{disk_percent:.1f}).")
        logs.append("  Öneri: Tinc Hub üzerinden 'ram-cleaner' veya 'disk-sentinel' ajanlarını çalıştırabilirsiniz.")
        logs.append("  Veya terminalden 'sudo apt autoremove' ile yer açabilirsiniz.\n")
    else:
        logs.append(f"[OK] Disk kullanımı sağlıklı (%{disk_percent:.1f}).\n")
        
    # 2. Yetim Servis (Orphaned Service) Kontrolü
    logs.append("Başıboş (Yetim) Tinc / Kole Servisleri Taranıyor...")
    apps = load_apps()
    registered_services = [a.get("service") for a in apps if a.get("service")]
    
    try:
        r = subprocess.run(["systemctl", "list-units", "--type=service", "--state=running", "--no-pager", "--no-legend"], capture_output=True, text=True)
        running_services = []
        for line in r.stdout.split('\n'):
            parts = line.split()
            if len(parts) > 0 and (parts[0].startswith("tinc-") or parts[0].startswith("kole-")):
                running_services.append(parts[0])
                
        orphans = [s for s in running_services if s not in registered_services and s != "tinc-hub.service"]
        
        if orphans:
            logs.append(f"[TESPİT] Dashboard'da olmayan ama arka planda çalışan servisler buldum: {', '.join(orphans)}")
            logs.append("  Öneri: Bu uygulamaları daha önce silmişsiniz ama servisleri arka planda kalmış olabilir.")
            logs.append(f"  Temizlemek için terminalde şunu çalıştırın:")
            for o in orphans:
                logs.append(f"    sudo systemctl stop {o} && sudo systemctl disable {o}")
            logs.append("")
        else:
            logs.append("[OK] Başıboş Tinc/Kole servisi bulunamadı.\n")
    except Exception as e:
        logs.append(f"[HATA] Servis taraması başarısız: {e}\n")
        
    # 3. RAM ve Zombi Süreçler
    import psutil
    ram = psutil.virtual_memory()
    if ram.percent > 90:
        logs.append(f"[UYARI] RAM kullanımı çok yüksek (%{ram.percent:.1f})!")
        logs.append("  Öneri: RAM Cleaner ajanını kurup otomatik boşaltma sağlayabilirsiniz.\n")
    else:
        logs.append(f"[OK] RAM durumu normal (%{ram.percent:.1f}).\n")
        
    logs.append("====== DENETİM TAMAMLANDI ======")
    
    return jsonify({"ok": True, "log": "\n".join(logs)})


@bp.route("/api/docker/<container_id>", methods=["DELETE"])
@auth_required
def api_delete_docker(container_id):
    try:
        r = subprocess.run(["sudo", "docker", "rm", "-f", container_id], capture_output=True, timeout=10, text=True)
        if r.returncode == 0:
            return jsonify({"ok": True, "log": "Docker container silindi:\n" + r.stdout + "\n" + r.stderr})
        else:
            return jsonify({"ok": False, "error": r.stderr, "log": "HATA OLUŞTU:\n" + r.stderr})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "log": str(e)}), 500



@bp.route("/api/discovery")
@auth_required
def api_discovery():
    disc = _get_discovery()
    return jsonify(disc)



@bp.route("/api/discovery/refresh", methods=["POST"])
@auth_required
def api_discovery_refresh():
    _disc_cache["at"] = None   # TTL sıfırla
    disc = _get_discovery()
    return jsonify({"ok": True, "services": len(disc.get("services", [])),
                    "ports": len(disc.get("ports", {}))})



@bp.route("/api/system/version")
@auth_required
def api_system_version():
    from installer import check_system_update
    res = check_system_update()
    return jsonify(res)



@bp.route("/api/system/update", methods=["POST"])
@auth_required
def api_system_self_update():
    from installer import perform_self_update
    res = perform_self_update()
    return jsonify(res), (200 if res.get("ok") else 500)


# ── API: Sistem Özeti ────────────────────────────────────────────────────────

def _system_summary() -> dict:
    import shutil
    try:
        import psutil
        ram  = psutil.virtual_memory()
        swap = psutil.swap_memory()
        cpu  = psutil.cpu_percent(interval=0.2)
        disk = shutil.disk_usage("/")
        return {
            "cpu_percent":  round(cpu, 1),
            "ram_percent":  round(ram.percent, 1),
            "ram_used_gb":  round(ram.used  / 1024**3, 1),
            "ram_total_gb": round(ram.total / 1024**3, 1),
            "swap_percent": round(swap.percent, 1),
            "disk_percent": round(disk.used / disk.total * 100, 1),
            "disk_used_gb": round(disk.used  / 1024**3, 1),
            "disk_total_gb":round(disk.total / 1024**3, 1),
        }
    except Exception as e:
        import logging
        logging.warning(f"Exception caught: {e}")
        return {}



@bp.route("/api/system")
@auth_required
def api_system():
    return jsonify(_system_summary())

@bp.route("/api/system/history")
@auth_required
def api_system_history():
    hours = int(request.args.get('hours', 1))
    try:
        import sys, os
        SHARED_DIR = os.environ.get("TINC_HUB_SHARED", "/opt/tinc-hub/shared")
        if SHARED_DIR not in sys.path: sys.path.insert(0, SHARED_DIR)
        import db as tinchub_db
    except Exception:
        return jsonify([])
    cpu_data = tinchub_db.get_metrics_series("system", "cpu_percent", hours=hours)
    # Return directly just time and cpu_percent, since that's what the frontend expects
    result = []
    for c in cpu_data:
        result.append({
            "time": c["created_at"],
            "cpu_percent": c["value"],
        })
    result.reverse() # Time series is sorted by created_at DESC, frontend needs ASC
    return jsonify(result)



@bp.route("/api/wan")
@auth_required
def api_wan():
    if tinchub_db:
        history = tinchub_db.get_wan_history(limit=5)
        latest  = tinchub_db.get_latest_metric("wan-tracker", "wan_ip")
        return jsonify({"history": history, "current": latest})
    return jsonify({"history": [], "current": None})


# ── SSE: Canlı Log Akışı ─────────────────────────────────────────────────────


@bp.route("/api/logs/stream/<path:service_name>")
@auth_required
def stream_logs(service_name):
    """
    Server-Sent Events ile journalctl -f akışı.
    Nginx için: proxy_buffering off; X-Accel-Buffering: no
    """
    # Güvenlik: sadece harf, rakam, kısa çizgi, @ ve nokta
    import re as _re
    if not _re.match(r'^[\w@.\-]+$', service_name):
        return "Geçersiz servis adı", 400

    lines = int(request.args.get("lines", 100))
    unit  = service_name if service_name.endswith(".service") else f"{service_name}.service"
    
    app_data = next((a for a in load_apps() if a.get("service") == service_name or a.get("service") == unit), None)
    is_user = app_data.get("is_user_service", False) if app_data else False
    
    if is_user:
        cmd = ["sudo", "-u", RUN_USER, "XDG_RUNTIME_DIR=/run/user/{RUN_UID}", "journalctl", "--user", "-u", unit, "-f", f"-n{lines}", "--no-pager", "--output=short-iso"]
    else:
        cmd = ["journalctl", "-u", unit, "-f", f"-n{lines}", "--no-pager", "--output=short-iso"]

    def generate():
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1
        )
        try:
            yield f"data: {json.dumps({'type': 'connected', 'service': service_name})}\n\n"
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    payload = json.dumps({"type": "line", "line": line,
                                          "ts": datetime.now().isoformat()})
                    yield f"data: {payload}\n\n"
        except GeneratorExit:
            pass
        finally:
            proc.terminate()
            proc.wait(timeout=3)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":       "no-cache",
            "X-Accel-Buffering":   "no",
            "Connection":          "keep-alive",
        }
    )



@bp.route("/api/logs/lines/<path:service_name>")
@auth_required
def log_lines(service_name):
    """Son N log satırını JSON olarak döner (statik, SSE değil)."""
    import re as _re
    if not _re.match(r'^[\w@.\-]+$', service_name):
        return jsonify({"error": "Geçersiz servis adı"}), 400
    lines = int(request.args.get("n", 200))
    unit  = service_name if service_name.endswith(".service") else f"{service_name}.service"
    
    app_data = next((a for a in load_apps() if a.get("service") == service_name or a.get("service") == unit), None)
    is_user = app_data.get("is_user_service", False) if app_data else False
    
    if is_user:
        cmd = ["sudo", "-u", RUN_USER, "XDG_RUNTIME_DIR=/run/user/{RUN_UID}", "journalctl", "--user", "-u", unit, f"-n{lines}", "--no-pager", "--output=short-iso"]
    else:
        cmd = ["journalctl", "-u", unit, f"-n{lines}", "--no-pager", "--output=short-iso"]
        
    r = subprocess.run(
        cmd,
        capture_output=True, text=True, timeout=10
    )
    return jsonify({"lines": r.stdout.splitlines(), "service": service_name})


@bp.route("/api/logs/search")
@auth_required
def api_log_search():
    service = request.args.get('service', '')
    query = request.args.get('q', '')
    lines = int(request.args.get('n', 500))
    
    cmd = ['journalctl']
    if service:
        cmd += ['-u', service]
    cmd += [f'-n{lines}', '--no-pager', '--output=short-iso']
    if query:
        cmd += ['--grep', query]
    
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    return jsonify({'lines': r.stdout.splitlines()})

# ── Yardımcılar ───────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now().strftime("%d.%m.%Y %H:%M:%S")



@bp.route("/api/mobile/info", methods=["GET"])
def api_mobile_info():
    token = request.headers.get("X-Tinc-Token") or request.args.get("token")
    if token != os.environ.get("API_TOKEN"):
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
        
    return jsonify({
        "ok": True,
        "hub_id": os.environ.get("HUB_ID"),
        "version": "1.0.0",
        "system": _system_summary()
    })




