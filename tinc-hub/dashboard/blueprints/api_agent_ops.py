import os
import sys
import json
import time
import socket
import logging
import subprocess
from datetime import datetime
from flask import Blueprint, jsonify, request, Response, stream_with_context
from app import admin_required, auth_required, RUN_USER, RUN_UID
from registry import load_apps, save_apps, get_app, delete_app

bp = Blueprint('api_agent_ops', __name__)
log = logging.getLogger("tinc-hub.ops")

def _send_sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

# ── 1. CANLI AKIŞLI GERÇEK KALDIRMA MOTORU ────────────────────────────────────
@bp.route("/api/apps/<app_id>/uninstall-stream", methods=["GET"])
@admin_required
def api_uninstall_stream(app_id):
    level = request.args.get("level", "purge") # "board", "disable", "purge"

    def generate():
        yield _send_sse({"type": "init", "title": f"Uygulama Kaldırma: {app_id}", "level": level})
        time.sleep(0.2)

        apps = load_apps()
        app_data = next((a for a in apps if a.get("id") == app_id), None)
        if not app_data:
            yield _send_sse({"type": "log", "level": "WARN", "text": f"⚠️ '{app_id}' kayıt defterinde bulunamadı, sistem temizliğine devam ediliyor..."})
            service_name = app_id
        else:
            service_name = app_data.get("service") or app_id

        yield _send_sse({"type": "log", "level": "INFO", "text": f"📌 İşlem Seviyesi: {level.upper()} (Servis: {service_name})"})

        # SEVİYE 1: Sadece Hub Panosundan Gizle
        if level == "board":
            yield _send_sse({"type": "log", "level": "INFO", "text": "🗑️ Pano kaydı siliniyor..."})
            delete_app(app_id)
            yield _send_sse({"type": "log", "level": "OK", "text": "✅ Uygulama Hub panosundan başarıyla kaldırıldı. Arka plan servisleri korundu."})
            yield _send_sse({"type": "done", "ok": True, "message": "Pano kaydı silindi."})
            return

        # SEVİYE 2 & 3: Servisi Durdur & Devre Dışı Bırak
        if service_name:
            yield _send_sse({"type": "log", "level": "INFO", "text": f"⏹️ Servis durduruluyor: {service_name}..."})
            p_stop = subprocess.run(["systemctl", "stop", service_name], capture_output=True, text=True)
            if p_stop.returncode == 0:
                yield _send_sse({"type": "log", "level": "OK", "text": f"✅ {service_name} durduruldu."})
            else:
                yield _send_sse({"type": "log", "level": "WARN", "text": f"⚠️ Servis durdurma uyarısı: {p_stop.stderr.strip() or 'Servis zaten çalışmıyordu.'}"})

            yield _send_sse({"type": "log", "level": "INFO", "text": f"🛑 Servis otomatik başlatma kapatılıyor (disable)..."})
            p_dis = subprocess.run(["systemctl", "disable", service_name], capture_output=True, text=True)
            if p_dis.returncode == 0:
                yield _send_sse({"type": "log", "level": "OK", "text": f"✅ {service_name} devre dışı bırakıldı."})
            else:
                yield _send_sse({"type": "log", "level": "INFO", "text": f"ℹ️ {service_name} servisi otomatik başlatmada bulunamadı veya yüklü değildi."})

        # SEVİYE 3: Kökten Temizleme (Purge)
        if level == "purge":
            yield _send_sse({"type": "log", "level": "INFO", "text": "🧹 Sistem birim dosyaları taranıyor..."})
            unit_candidates = [
                f"/etc/systemd/system/{service_name}.service",
                f"/etc/systemd/system/{service_name}",
                f"/lib/systemd/system/{service_name}.service",
                f"/etc/systemd/system/multi-user.target.wants/{service_name}.service"
            ]
            found_units = [u for u in unit_candidates if os.path.exists(u)]
            for u in found_units:
                try:
                    os.remove(u)
                    yield _send_sse({"type": "log", "level": "OK", "text": f"🗑️ Systemd birimi silindi: {u}"})
                except Exception as ex:
                    yield _send_sse({"type": "log", "level": "WARN", "text": f"⚠️ Dosya silinemedi ({u}): {ex}"})

            yield _send_sse({"type": "log", "level": "INFO", "text": "🔄 Systemd daemon-reload çalıştırılıyor..."})
            subprocess.run(["systemctl", "daemon-reload"], capture_output=True, text=True)
            subprocess.run(["systemctl", "reset-failed"], capture_output=True, text=True)
            yield _send_sse({"type": "log", "level": "OK", "text": "✅ Systemd yöneticisi yenilendi."})

            # Snap paket tespiti ve kaldırma (Örn: cctv-viewer)
            try:
                snap_candidates = [app_id, f"{app_id}-viewer", f"{app_id}_viewer", service_name]
                for sc in set(snap_candidates):
                    if not sc: continue
                    s_chk = subprocess.run(["snap", "list", sc], capture_output=True, text=True)
                    if s_chk.returncode == 0 and sc in s_chk.stdout:
                        yield _send_sse({"type": "log", "level": "INFO", "text": f"📦 Snap paketi tespit edildi ({sc}), sistemden kaldırılıyor..."})
                        s_rem = subprocess.run(["sudo", "snap", "remove", sc], capture_output=True, text=True)
                        if s_rem.returncode == 0:
                            yield _send_sse({"type": "log", "level": "OK", "text": f"✅ Snap paketi ({sc}) sistemden başarıyla kaldırıldı."})
                        else:
                            yield _send_sse({"type": "log", "level": "WARN", "text": f"⚠️ Snap kaldırma hatası: {s_rem.stderr.strip()}"})
            except Exception as ex:
                yield _send_sse({"type": "log", "level": "WARN", "text": f"Snap kontrol hatası: {ex}"})

            # Özel servis temizlikleri
            if app_id == "ollama" or service_name == "ollama":
                yield _send_sse({"type": "log", "level": "INFO", "text": "🧠 Ollama ikili dosyası temizleniyor (/usr/local/bin/ollama)..."})
                if os.path.exists("/usr/local/bin/ollama"):
                    try:
                        os.remove("/usr/local/bin/ollama")
                        yield _send_sse({"type": "log", "level": "OK", "text": "✅ /usr/local/bin/ollama silindi."})
                    except Exception as ex:
                        yield _send_sse({"type": "log", "level": "WARN", "text": f"Ollama binary silinemedi: {ex}"})

            # Docker temizliği kontrolü
            try:
                d_check = subprocess.run(["docker", "ps", "-a", "--filter", f"name={app_id}", "--format", "{{.ID}}"], capture_output=True, text=True, timeout=3)
                if d_check.returncode == 0 and d_check.stdout.strip():
                    cid = d_check.stdout.strip().split("\n")[0]
                    yield _send_sse({"type": "log", "level": "INFO", "text": f"🐳 İlgili Docker konteyneri durdurulup siliniyor ({cid})..."})
                    subprocess.run(["docker", "rm", "-f", cid], capture_output=True, text=True)
                    yield _send_sse({"type": "log", "level": "OK", "text": f"✅ Docker konteyneri silindi: {cid}"})
            except Exception:
                pass

        # Pano kaydını sil
        delete_app(app_id)
        yield _send_sse({"type": "log", "level": "OK", "text": f"✅ Pano kaydı ({app_id}) temizlendi."})
        yield _send_sse({"type": "done", "ok": True, "message": f"'{app_id}' başarıyla sistemden kaldırıldı."})

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}
    )


# ── 2. CANLI KOMUT VE GÖREV ÇALIŞTIRMA (STREAMING SHELL) ──────────────────────
@bp.route("/api/system/task-stream", methods=["POST"])
@admin_required
def api_task_stream():
    data = request.get_json() or {}
    commands = data.get("commands", [])
    title = data.get("title", "Sistem Görevi İcrası")

    if isinstance(commands, str):
        commands = [c.strip() for c in commands.split("\n") if c.strip()]

    def generate():
        yield _send_sse({"type": "init", "title": title, "total": len(commands)})
        time.sleep(0.1)

        # Tehlikeli komut kalıpları
        _BLOCKED_PATTERNS = [
            'mkfs', ':(){', 'dd if=/dev', '> /dev/', 'bash -i',
            '/dev/tcp', '/dev/udp', 'base64 -d', 'chmod 777',
            'chmod +s', '/etc/passwd', '/etc/shadow'
        ]

        for i, cmd in enumerate(commands, 1):
            # Güvenlik kontrolü
            _cmd_lower = cmd.lower()
            _blocked = next((p for p in _BLOCKED_PATTERNS if p in _cmd_lower), None)
            if _blocked:
                yield _send_sse({"type": "log", "level": "ERROR", "text": f"❌ Güvenlik kısıtlaması: '{_blocked}' kalıbı bu endpoint'te engellidir."})
                continue

            yield _send_sse({"type": "cmd_start", "index": i, "cmd": cmd})
            yield _send_sse({"type": "log", "level": "CMD", "text": f"$ {cmd}"})

            try:
                proc = subprocess.Popen(
                    cmd,
                    shell=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1
                )
                for line in proc.stdout:
                    line = line.rstrip()
                    if line:
                        yield _send_sse({"type": "log", "level": "OUT", "text": line})
                proc.wait()
                if proc.returncode == 0:
                    yield _send_sse({"type": "log", "level": "OK", "text": f"✅ Komut tamamlandı (kod 0)"})
                else:
                    yield _send_sse({"type": "log", "level": "ERROR", "text": f"❌ Komut hata verdi (çıkış kodu {proc.returncode})"})
            except Exception as e:
                yield _send_sse({"type": "log", "level": "ERROR", "text": f"Hata: {e}"})

        yield _send_sse({"type": "done", "ok": True, "message": "Tüm komutlar icra edildi."})

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}
    )


# ── 3. PORT DEDEKTİFİ & ÇAKIŞMA TESTİ ─────────────────────────────────────────
@bp.route("/api/apps/port-check/<int:port>", methods=["GET"])
@auth_required
def api_port_check(port):
    if port < 1 or port > 65535:
        return jsonify({"ok": False, "error": "Geçersiz port"}), 400

    in_use = False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        res = s.connect_ex(('127.0.0.1', port))
        in_use = (res == 0)

    process_info = None
    pid = None
    if in_use:
        try:
            r = subprocess.run(f"lsof -i :{port} -sTCP:LISTEN -t", shell=True, capture_output=True, text=True, timeout=2)
            if r.stdout.strip():
                pid = r.stdout.strip().split("\n")[0]
                r_proc = subprocess.run(f"ps -p {pid} -o comm=", shell=True, capture_output=True, text=True, timeout=2)
                process_info = r_proc.stdout.strip()
        except Exception:
            pass

    # Tinc ayrılmış port kontrolü
    is_tinc_reserved = (9010 <= port <= 9019)
    reserved_name = {
        9010: "TincHub Manager",
        9011: "TincNet Harita",
        9012: "Web Terminal",
        9013: "TincNote",
        9014: "TincProcess",
        9015: "APRS Manager",
        9016: "Socies Game",
        9017: "TincStream",
        9018: "TincBackup",
        9019: "TincGateway"
    }.get(port, None)

    return jsonify({
        "ok": True,
        "port": port,
        "in_use": in_use,
        "process": process_info or ("Dinleniyor" if in_use else "Müsait"),
        "pid": pid,
        "is_tinc_reserved": is_tinc_reserved,
        "reserved_name": reserved_name
    })


# ── 4. TINCOPS KURAL TABANLI OTOMASYON (ANAHTAR KELİME -> EYLEM & BASH) ────────
@bp.route("/api/ai/agent-task", methods=["POST"])
@admin_required
def api_ai_agent_task():
    data = request.get_json() or {}
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"ok": False, "error": "Lütfen bir görev veya komut girin."}), 400

    p_lower = prompt.lower()

    # Kural Tabanlı Otomasyon Motoru — anahtar kelime eşleştirmesiyle görev üretir
    # 1. Kaldırma İstekleri
    if any(w in p_lower for w in ["kaldır", "sil", "temizle", "purge", "uninstall", "remove"]):
        target = None
        # Kayıtlı uygulamalardan id listesini dinamik olarak oluştur
        _registered_ids = [a.get("id", "") for a in load_apps()]
        _registered_services = [a.get("service", "") for a in load_apps() if a.get("service")]
        _all_targets = list(set(_registered_ids + _registered_services + ["nginx", "docker"]))
        for app in _all_targets:
            if app in p_lower:
                target = app
                break

        if target:
            commands = [
                f"systemctl stop {target}",
                f"systemctl disable {target}",
                f"rm -f /etc/systemd/system/{target}.service",
                "systemctl daemon-reload",
                "systemctl reset-failed"
            ]
            if target == "ollama":
                commands.append("rm -f /usr/local/bin/ollama")
            return jsonify({
                "ok": True,
                "title": f"'{target.capitalize()}' Sistemden Kökten Kaldırma",
                "explanation": f"{target.capitalize()} servisi durdurulacak, systemd birimi ve ikili dosyaları sistemden tamamen temizlenecektir.",
                "risk_level": "high",
                "commands": commands
            })

    # 2. Yeniden Başlatma / Durum İstekleri
    if "yeniden başlat" in p_lower or "restart" in p_lower:
        for app in ["tincnet", "tincnote", "tincprocess", "tinc-hub", "nginx", "ollama", "docker"]:
            if app in p_lower or app.replace("-", "") in p_lower:
                return jsonify({
                    "ok": True,
                    "title": f"'{app}' Servisini Yeniden Başlatma",
                    "explanation": f"{app} servisi yeniden başlatılacak ve durum çıktısı alınacaktır.",
                    "risk_level": "low",
                    "commands": [
                        f"systemctl restart {app}",
                        f"systemctl status {app} --no-pager"
                    ]
                })

    # 3.1. Akıllı Uygulama Kurma / Yükleme İstekleri (TincOps Kurulum Motoru)
    if any(w in p_lower for w in ["kur", "yükle", "install", "getir", "ekle"]):
        import re
        # "X uygulamasını kur", "install X", "X kur"
        clean_text = p_lower
        for w in ["uygulamayı", "uygulamasını", "programını", "paketini", "lütfen", "hemen", "sisteme", "kur", "yükle", "install", "ekle"]:
            clean_text = clean_text.replace(w, " ")
        candidate = clean_text.strip().split()
        app_target = candidate[0] if candidate else ""

        if app_target:
            # 1. Özel TincSuite kontrolü (tincsync, tincnet, tincprocess, tnote vb.)
            if "sync" in app_target or "tincsync" in app_target:
                return jsonify({
                    "ok": True,
                    "title": "TincSync Bulut Motoru Kurulumu",
                    "explanation": "TincSync servisi systemd altında etkinleştirilecek ve Port 9015 üzerinde çalıştırılacaktır.",
                    "risk_level": "low",
                    "commands": [
                        "systemctl enable --now tincsync",
                        "systemctl status tincsync --no-pager"
                    ]
                })

            # 2. Genel Linux Paket Yöneticisi (APT / Flatpak / Snap)
            return jsonify({
                "ok": True,
                "title": f"'{app_target}' Uygulamasını Sisteme Kurma",
                "explanation": f"Pardus / Debian depolarından '{app_target}' paketi taranacak ve otomatik kurulacaktır.",
                "risk_level": "medium",
                "commands": [
                    "echo '📦 [TincOps] Paket depoları güncelleniyor...'",
                    "apt-get update",
                    f"echo '⬇️ [TincOps] {app_target} kuruluyor...'",
                    f"DEBIAN_FRONTEND=noninteractive apt-get install -y {app_target}",
                    f"which {app_target} || echo 'Kurulum tamamlandı.'"
                ]
            })

    # 4. Port Dedektifi / Port Sorgusu
    if "port" in p_lower:
        import re
        port_match = re.search(r'\b(90\d\d|\d{2,5})\b', prompt)
        port_num = port_match.group(1) if port_match else "9015"
        return jsonify({
            "ok": True,
            "title": f"Port {port_num} Analizi ve Dinleyici Tespiti",
            "explanation": f"{port_num} portunun dinlenip dinlenmediği, hangi PID ve servisin kullandığı incelenecektir.",
            "risk_level": "low",
            "commands": [
                f"ss -tulpn | grep ':{port_num} ' || echo 'Port {port_num} şu an tamamen boş ve müsait.'",
                f"lsof -i :{port_num} || true"
            ]
        })

    # 4. Disk ve RAM Temizliği
    if any(w in p_lower for w in ["disk", "ram", "bellek", "hafıza", "yer aç", "temizlik"]):
        return jsonify({
            "ok": True,
            "title": "Sistem Kaynak ve Log Temizliği",
            "explanation": "3 günden eski systemd logları vakumlanacak, apt artık paketleri temizlenecek ve en çok RAM tüketen süreçler listelenecektir.",
            "risk_level": "medium",
            "commands": [
                "journalctl --vacuum-time=3d",
                "apt-get autoremove -y",
                "ps aux --sort=-%mem | head -n 6"
            ]
        })

    # Genel / Diğer Durumlar İçin Güvenli Varsayılan
    return jsonify({
        "ok": True,
        "title": "TincOps Sistem Görevi",
        "explanation": f"'{prompt}' talebiniz analiz edildi. İlgili sistem kontrolleri hazırlanmıştır.",
        "risk_level": "low",
        "commands": [
            f"echo 'TincOps Görevi İcra Ediliyor: {prompt}'",
            "uptime",
            "free -h",
            "df -h /"
        ]
    })
