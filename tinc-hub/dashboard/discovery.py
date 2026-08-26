#!/usr/bin/env python3
import subprocess
import json

def get_running_docker_containers():
    try:
        r = subprocess.run(["sudo", "docker", "ps", "--format", "{{json .}}"], capture_output=True, text=True, timeout=5)
        containers = []
        for line in r.stdout.strip().split("\n"):
            if line:
                d = json.loads(line)
                containers.append({
                    "id": d.get("ID"),
                    "name": d.get("Names"),
                    "image": d.get("Image"),
                    "status": d.get("Status"),
                    "state": d.get("State"),
                    "state_str": d.get("State", "").upper(),
                    "running": d.get("State") == "running",
                    "ports": d.get("Ports", "").split(",")
                })
        return containers
    except Exception:
        return []

def discover_user_services():
    try:
        # User servisleri
        cmd1 = ["sudo", "XDG_RUNTIME_DIR=/run/user/1000", "-u", "turan", "systemctl", "--user", "list-units", "--type=service", "--state=running", "--no-pager", "--no-legend"]
        r1 = subprocess.run(cmd1, capture_output=True, text=True, timeout=5)
        
        # System servisleri
        cmd2 = ["systemctl", "list-units", "--type=service", "--state=running", "--no-pager", "--no-legend"]
        r2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=5)
        
        services = []
        
        # Parse user
        for line in r1.stdout.strip().split('\n'):
            if line.strip():
                parts = line.split()
                if len(parts) > 0 and parts[0].endswith(".service"):
                    services.append(parts[0] + " (user)")
                    
        # Parse system
        ignore_prefixes = ("systemd-", "dbus", "polkit", "NetworkManager", "wpa_supplicant", "cron", "rsyslog", "ssh", "getty", "snapd", "fwupd", "modemmanager", "accounts-daemon", "udisks2", "upower")
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
