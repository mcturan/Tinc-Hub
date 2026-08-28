#!/usr/bin/env python3
"""
Tinc Hub — Otomatik Servis Keşif Motoru

systemd servisleri, açık portları ve Docker container'larını otomatik tarar.
"""

import subprocess
import re
import os
import socket
import json
from datetime import datetime


def _run(cmd: list[str], timeout: int = 5) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout
    except Exception:
        return ""


# ─── Port → Process Mapping ──────────────────────────────────────────────────

def get_port_process_map() -> dict:
    """
    ss -tlnp çıktısını parse eder.
    Dönüş: {port: {pid, process, addr}}
    """
    out = _run(["ss", "-tlnp"])
    result = {}
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 4:
            continue
        local = parts[3]                            # 0.0.0.0:5000 veya *:32400
        users = parts[5] if len(parts) > 5 else "" # users:(("python",pid=599969,fd=4))
        try:
            port = int(local.split(":")[-1])
        except ValueError:
            continue

        pid_match = re.search(r"pid=(\d+)", users)
        name_match = re.search(r'"([^"]+)"', users)
        pid = int(pid_match.group(1)) if pid_match else None
        proc = name_match.group(1) if name_match else None

        # localhost-only mı?
        is_local = local.startswith("127.") or local.startswith("[::1]")

        result[port] = {
            "port": port,
            "pid": pid,
            "process": proc,
            "addr": local,
            "local_only": is_local,
        }
    return result


# ─── systemd Servis Keşfi ────────────────────────────────────────────────────

# Dashboard'da göstermek istemediğimiz sistem servisleri (gürültüyü azaltır)
_SKIP_SERVICES = {
    "accounts-daemon", "avahi-daemon", "colord", "cron", "cups",
    "cups-browsed", "dbus", "devmon@devmon", "fwupd", "getty@tty1",
    "lightdm", "ModemManager", "polkit", "power-profiles-daemon",
    "rtkit-daemon", "snapd", "switcheroo-control", "systemd-journald",
    "systemd-logind", "systemd-timesyncd", "systemd-udevd", "udisks2",
    "upower", "unattended-upgrades", "user@1000", "wpa_supplicant",
    "NetworkManager", "nmbd", "smbd", "winbind", "containerd",
}


def get_systemd_services(all_states: bool = False) -> list[dict]:
    """
    Çalışan (ve isteğe bağlı tüm) systemd servislerini döner.
    """
    cmd = ["systemctl", "list-units", "--type=service", "--no-legend", "--no-pager"]
    if all_states:
        cmd.append("--all")
    out = _run(cmd)
    services = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        unit = parts[0]
        load_state = parts[1] if len(parts) > 1 else ""
        active = parts[2] if len(parts) > 2 else ""
        sub = parts[3] if len(parts) > 3 else ""

        # .service uzantısını kaldır
        name = unit.removesuffix(".service")

        # Sistem gürültüsünü filtrele
        base_name = re.split(r"[@.]", name)[0]
        if base_name in _SKIP_SERVICES:
            continue
        # Snap, loop, dev gibi şeyleri atla
        if any(name.startswith(p) for p in ("snap.", "dev-", "sys-", "run-", "tmp-", "proc-")):
            continue

        services.append({
            "name": name,
            "unit": unit,
            "load": load_state,
            "active": active,
            "sub": sub,
            "running": active == "active" and sub == "running",
        })
    return services


def get_service_detail(service_name: str) -> dict:
    """Tek bir servisin detaylarını döner."""
    unit = service_name if service_name.endswith(".service") else f"{service_name}.service"
    out = _run(["systemctl", "show", unit,
                "--property=ActiveState,SubState,MainPID,ActiveEnterTimestamp,Description,ExecStart"])
    detail = {}
    for line in out.splitlines():
        k, _, v = line.partition("=")
        detail[k.strip()] = v.strip()

    pid = detail.get("MainPID", "0")
    try:
        pid = int(pid)
    except ValueError:
        pid = 0

    return {
        "active_state": detail.get("ActiveState", "unknown"),
        "sub_state": detail.get("SubState", "unknown"),
        "pid": pid if pid else None,
        "since": detail.get("ActiveEnterTimestamp", ""),
        "description": detail.get("Description", ""),
        "exec_start": detail.get("ExecStart", ""),
    }


# ─── Docker Container Keşfi ──────────────────────────────────────────────────

def get_docker_containers() -> list[dict]:
    """Docker API unix soketi üzerinden container listesi alır."""
    import http.client

    class _UnixHTTPConnection(http.client.HTTPConnection):
        def __init__(self, sock_path):
            super().__init__("localhost")
            self.sock_path = sock_path

        def connect(self):
            import socket as _socket
            s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
            s.connect(self.sock_path)
            self.sock = s

    sock = "/var/run/docker.sock"
    if not os.path.exists(sock):
        return []
    try:
        conn = _UnixHTTPConnection(sock)
        conn.request("GET", "/containers/json?all=1")
        resp = conn.getresponse()
        data = json.loads(resp.read())
        containers = []
        for c in data:
            ports = []
            for p in c.get("Ports", []):
                hp = p.get("PublicPort")
                if hp:
                    ports.append(hp)
            containers.append({
                "id": c.get("Id", "")[:12],
                "name": (c.get("Names") or ["?"])[0].lstrip("/"),
                "image": c.get("Image", ""),
                "status": c.get("State", "unknown"),
                "state_str": c.get("Status", ""),
                "ports": ports,
                "running": c.get("State") == "running",
            })
        return containers
    except Exception:
        return []


# ─── Süreç Bilgisi (psutil) ──────────────────────────────────────────────────

_process_cache = {}

def get_process_info(pid: int) -> dict | None:
    """PID'e göre CPU/RAM bilgisi döner."""
    try:
        import psutil
        if pid not in _process_cache:
            p = psutil.Process(pid)
            p.cpu_percent(interval=None) # Start measurement
            _process_cache[pid] = p
            
        p = _process_cache[pid]
        
        # Eğer süreç ölmüşse veya PID başka bir sürece geçmişse hata verebilir
        if not p.is_running():
            del _process_cache[pid]
            return None
            
        mem = p.memory_info()
        
        # CPU'yu 'interval=None' ile alarak son ölçümden (son sayfa yenilemesinden) bu yana ortalamayı alır.
        # Böylece %0 gözükme sorunu ortadan kalkar.
        cpu = p.cpu_percent(interval=None)
        
        return {
            "cpu_percent": round(cpu, 1),
            "ram_mb": round(mem.rss / 1024 / 1024, 1),
            "status": p.status(),
            "create_time": p.create_time(),
        }
    except Exception:
        if pid in _process_cache:
            del _process_cache[pid]
        return None


# ─── Ana Keşif Fonksiyonu ────────────────────────────────────────────────────

def discover_all() -> dict:
    """
    Sistemdeki tüm servisleri, portları ve container'ları keşfeder.
    Dönüş: {services: [...], ports: {...}, docker: [...], discovered_at: ...}
    """
    port_map = get_port_process_map()
    services = get_systemd_services(all_states=False)
    docker = get_docker_containers()

    # Her servisin hangi portta çalıştığını bul
    for svc in services:
        pid = None
        detail = get_service_detail(svc["name"])
        svc.update(detail)
        pid = detail.get("pid")

        svc["ports"] = []
        if pid:
            svc["ports"] = [
                p for p, info in port_map.items()
                if info.get("pid") == pid
            ]
            proc_info = get_process_info(pid)
            if proc_info:
                svc["cpu_percent"] = proc_info["cpu_percent"]
                svc["ram_mb"] = proc_info["ram_mb"]

    return {
        "services": services,
        "ports": port_map,
        "docker": docker,
        "discovered_at": datetime.now().isoformat(),
    }


def get_running_docker_containers():
    return get_docker_containers()

def discover_user_services():
    try:
        import subprocess
        cmd1 = ["sudo", "XDG_RUNTIME_DIR=/run/user/1000", "-u", "turan", "systemctl", "--user", "list-units", "--type=service", "--state=running", "--no-pager", "--no-legend"]
        r1 = subprocess.run(cmd1, capture_output=True, text=True, timeout=5)
        
        cmd2 = ["systemctl", "list-units", "--type=service", "--state=running", "--no-pager", "--no-legend"]
        r2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=5)
        
        services = []
        for line in r1.stdout.strip().split('\n'):
            if line.strip():
                parts = line.split()
                if len(parts) > 0 and parts[0].endswith(".service"):
                    services.append(parts[0] + " (user)")
                    
        ignore_prefixes = ("systemd-", "dbus", "polkit", "NetworkManager", "wpa_supplicant", "cron", "rsyslog", "ssh", "getty", "snapd", "fwupd", "modemmanager", "accounts-daemon", "udisks2", "upower", "tinc-hub")
        for line in r2.stdout.strip().split('\n'):
            if line.strip():
                parts = line.split()
                if len(parts) > 0 and parts[0].endswith(".service"):
                    srv = parts[0]
                    if not srv.startswith(ignore_prefixes):
                        services.append(srv)
        
        return sorted(list(set(services)))
    except Exception:
        return []
