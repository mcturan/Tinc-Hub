import os
import signal
import time
import psutil
from datetime import datetime

# Initialize CPU percentage tracking
try:
    psutil.cpu_percent(interval=None)
except Exception:
    pass

def get_system_summary():
    """Returns general system resources summary."""
    try:
        cpu_percent = psutil.cpu_percent(interval=None)
        cpu_count = psutil.cpu_count(logical=True)
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        uptime_seconds = int(time.time() - psutil.boot_time())
        
        # Load average (1, 5, 15 min)
        load_avg = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)

        return {
            "cpu_percent": round(cpu_percent, 1),
            "cpu_count": cpu_count,
            "load_avg": [round(x, 2) for x in load_avg],
            "ram_total_mb": round(mem.total / (1024 * 1024), 1),
            "ram_used_mb": round(mem.used / (1024 * 1024), 1),
            "ram_percent": mem.percent,
            "swap_used_mb": round(swap.used / (1024 * 1024), 1),
            "swap_percent": swap.percent,
            "uptime_seconds": uptime_seconds,
            "process_count": len(psutil.pids()),
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        return {"error": str(e)}

def get_listening_ports():
    """Maps PID to list of listening ports/sockets."""
    pid_to_ports = {}
    try:
        # psutil.net_connections requires root or access to /proc/net
        conns = psutil.net_connections(kind='inet')
        for c in conns:
            if c.status == psutil.CONN_LISTEN and c.laddr:
                pid = c.pid
                if pid is not None:
                    if pid not in pid_to_ports:
                        pid_to_ports[pid] = []
                    port_info = {
                        "port": c.laddr.port,
                        "ip": c.laddr.ip,
                        "family": "TCP" if c.type == 1 else "UDP"
                    }
                    if port_info not in pid_to_ports[pid]:
                        pid_to_ports[pid].append(port_info)
    except Exception:
        pass
    return pid_to_ports

def get_all_processes():
    """Fetches list of all processes with detailed metadata."""
    ports_map = get_listening_ports()
    processes = []

    attrs = [
        'pid', 'ppid', 'name', 'username', 'status',
        'cpu_percent', 'memory_info', 'memory_percent',
        'num_threads', 'create_time', 'nice'
    ]

    for p in psutil.process_iter(attrs=attrs, ad_value=None):
        try:
            info = p.info
            pid = info.get('pid')
            if not pid:
                continue

            mem_info = info.get('memory_info')
            rss_mb = round(mem_info.rss / (1024 * 1024), 1) if mem_info else 0.0
            vms_mb = round(mem_info.vms / (1024 * 1024), 1) if mem_info else 0.0

            listening = ports_map.get(pid, [])

            proc_item = {
                "pid": pid,
                "ppid": info.get('ppid') or 0,
                "name": info.get('name') or "unknown",
                "user": info.get('username') or "unknown",
                "status": info.get('status') or "unknown",
                "cpu": round(info.get('cpu_percent') or 0.0, 1),
                "ram_mb": rss_mb,
                "ram_vms_mb": vms_mb,
                "ram_pct": round(info.get('memory_percent') or 0.0, 1),
                "threads": info.get('num_threads') or 1,
                "nice": info.get('nice') or 0,
                "created": datetime.fromtimestamp(info.get('create_time') or time.time()).strftime('%H:%M:%S'),
                "ports": listening,
                "children": []
            }
            processes.append(proc_item)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    return processes

def build_process_tree(processes):
    """Organizes processes into a hierarchical parent-child tree structure."""
    proc_map = {p["pid"]: p for p in processes}
    root_nodes = []

    for p in processes:
        ppid = p.get("ppid")
        # If parent exists in process map and isn't the process itself
        if ppid and ppid in proc_map and ppid != p["pid"]:
            proc_map[ppid]["children"].append(p)
        else:
            root_nodes.append(p)

    # Sort children recursively by cpu desc, then ram desc
    def sort_node(node):
        if node["children"]:
            node["children"].sort(key=lambda x: (x["cpu"], x["ram_mb"]), reverse=True)
            for child in node["children"]:
                sort_node(child)

    root_nodes.sort(key=lambda x: (x["cpu"], x["ram_mb"]), reverse=True)
    for root in root_nodes:
        sort_node(root)

    return root_nodes

def get_process_detail(pid: int):
    """Returns deep inspection data for a single process."""
    try:
        p = psutil.Process(pid)
        with p.oneshot():
            mem_info = p.memory_info()
            try:
                cmdline = " ".join(p.cmdline())
            except Exception:
                cmdline = p.name()

            try:
                exe = p.exe()
            except Exception:
                exe = ""

            try:
                cwd = p.cwd()
            except Exception:
                cwd = ""

            try:
                open_files = [f.path for f in p.open_files()][:50]
            except Exception:
                open_files = []

            try:
                connections = []
                for c in p.connections(kind='inet'):
                    connections.append({
                        "fd": c.fd,
                        "family": "TCP" if c.type == 1 else "UDP",
                        "laddr": f"{c.laddr.ip}:{c.laddr.port}" if c.laddr else "",
                        "raddr": f"{c.raddr.ip}:{c.raddr.port}" if c.raddr else "",
                        "status": c.status
                    })
            except Exception:
                connections = []

            try:
                environ = dict(p.environ())
            except Exception:
                environ = {}

            return {
                "ok": True,
                "pid": p.pid,
                "ppid": p.ppid(),
                "name": p.name(),
                "exe": exe,
                "cwd": cwd,
                "cmdline": cmdline,
                "username": p.username(),
                "status": p.status(),
                "cpu_percent": round(p.cpu_percent(interval=0.1), 1),
                "ram_rss_mb": round(mem_info.rss / (1024 * 1024), 2),
                "ram_vms_mb": round(mem_info.vms / (1024 * 1024), 2),
                "num_threads": p.num_threads(),
                "num_fds": p.num_fds() if hasattr(p, "num_fds") else len(open_files),
                "nice": p.nice(),
                "created": datetime.fromtimestamp(p.create_time()).strftime('%Y-%m-%d %H:%M:%S'),
                "open_files": open_files,
                "connections": connections,
                "environ_keys": list(environ.keys())[:30]
            }
    except psutil.NoSuchProcess:
        return {"ok": False, "error": f"Süreç (PID {pid}) artık çalışmıyor."}
    except psutil.AccessDenied:
        return {"ok": False, "error": f"PID {pid} bilgilerine erişim yetkisi yetersiz."}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def execute_process_action(pid: int, action: str, nice_val: int = None):
    """Executes Process Explorer actions: kill, terminate, suspend, resume, nice."""
    try:
        p = psutil.Process(pid)
        if action == "kill":
            p.send_signal(signal.SIGKILL)
            return {"ok": True, "message": f"PID {pid} anında sonlandırıldı (SIGKILL)."}
        elif action == "terminate":
            p.send_signal(signal.SIGTERM)
            return {"ok": True, "message": f"PID {pid} nazikçe sonlandırıldı (SIGTERM)."}
        elif action == "suspend":
            p.send_signal(signal.SIGSTOP)
            return {"ok": True, "message": f"PID {pid} donduruldu (SIGSTOP)."}
        elif action == "resume":
            p.send_signal(signal.SIGCONT)
            return {"ok": True, "message": f"PID {pid} devam ettirildi (SIGCONT)."}
        elif action == "nice":
            if nice_val is not None:
                val = max(-20, min(19, int(nice_val)))
                p.nice(val)
                return {"ok": True, "message": f"PID {pid} önceliği {val} olarak ayarlandı."}
            return {"ok": False, "error": "Geçerli bir öncelik değeri verilmedi"}
        else:
            return {"ok": False, "error": f"Bilinmeyen eylem: {action}"}
    except psutil.NoSuchProcess:
        return {"ok": False, "error": f"Süreç (PID {pid}) bulunamadı."}
    except psutil.AccessDenied:
        return {"ok": False, "error": f"PID {pid} için bu eylemi gerçekleştirme izni yok (Root gerektirebilir)."}
    except Exception as e:
        return {"ok": False, "error": str(e)}
