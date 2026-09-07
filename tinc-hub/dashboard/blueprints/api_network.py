import syslog_server
import alarm_manager
import metrics_collector
import service_monitor
import changelog_manager
from flask import Blueprint, jsonify, request
import subprocess
import re
import time
import json
import os
from app import auth_required


bp = Blueprint('api_network', __name__, url_prefix='/api/network')

_network_cache = {"data": [], "timestamp": 0}
TOPOLOGY_FILE = "/opt/tinc-hub/shared/topology.json"

def get_topology_data():
    if os.path.exists(TOPOLOGY_FILE):
        try:
            with open(TOPOLOGY_FILE, 'r') as f:
                return json.load(f)
        except Exception:
            pass
    return {"nodes": {}, "edges": {}}

def save_topology_data(data):
    try:
        os.makedirs(os.path.dirname(TOPOLOGY_FILE), exist_ok=True)
        with open(TOPOLOGY_FILE, 'w') as f:
            json.dump(data, f, indent=4)
        return True
    except Exception as e:
        print(f"Topology save error: {e}")
        return False

def resolve_hostname(ip):
    try:
        r = subprocess.run(['host', '-W', '1', ip], capture_output=True, text=True, timeout=2)
        if 'domain name pointer' in r.stdout:
            return r.stdout.split('pointer')[1].strip().rstrip('.')
    except Exception:
        pass
    return ip

def scan_ports(ip, common_ports=[80, 443, 22, 8080, 9010, 3000, 5000, 8443, 32400]):
    open_ports = []
    for port in common_ports:
        try:
            r = subprocess.run(['nc', '-z', '-w1', ip, str(port)], capture_output=True, timeout=1.5)
            if r.returncode == 0:
                open_ports.append(port)
        except Exception:
            pass
    return open_ports

def scan_network():
    devices = []
    
    # Yöntem 1: arp-scan
    try:
        r = subprocess.run(['sudo', 'arp-scan', '--localnet'],
                          capture_output=True, text=True, timeout=15)
        for line in r.stdout.splitlines():
            match = re.match(r'(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f:]+)\s+(.*)', line, re.IGNORECASE)
            if match:
                devices.append({
                    'ip': match.group(1),
                    'mac': match.group(2),
                    'vendor': match.group(3).strip(),
                    'hostname': resolve_hostname(match.group(1)),
                    'ports': [],
                    'type': 'auto'
                })
    except FileNotFoundError:
        pass
    except Exception:
        pass
    
    # Yöntem 2: nmap fallback
    if not devices:
        try:
            r = subprocess.run(['nmap', '-sn', '192.168.1.0/24'],
                              capture_output=True, text=True, timeout=30)
            current_ip = None
            current_mac = None
            for line in r.stdout.splitlines():
                ip_match = re.search(r'(\d+\.\d+\.\d+\.\d+)', line)
                mac_match = re.search(r'([0-9A-F:]{17})', line, re.IGNORECASE)
                if 'Nmap scan report' in line and ip_match:
                    if current_ip:
                        devices.append({
                            'ip': current_ip, 'mac': current_mac or '',
                            'vendor': '', 'hostname': resolve_hostname(current_ip),
                            'ports': [], 'type': 'auto'
                        })
                    current_ip = ip_match.group(1)
                    current_mac = None
                if mac_match:
                    current_mac = mac_match.group(1)
            if current_ip:
                devices.append({
                    'ip': current_ip, 'mac': current_mac or '',
                    'vendor': '', 'hostname': resolve_hostname(current_ip),
                    'ports': [], 'type': 'auto'
                })
        except Exception:
            pass
    
    # Yöntem 3: /proc/net/arp fallback (hiçbir araç yoksa)
    if not devices:
        try:
            with open('/proc/net/arp', 'r') as f:
                for line in f.readlines()[1:]:
                    parts = line.split()
                    if len(parts) >= 4 and parts[3] != '00:00:00:00:00:00':
                        devices.append({
                            'ip': parts[0], 'mac': parts[3],
                            'vendor': '', 'hostname': resolve_hostname(parts[0]),
                            'ports': [], 'type': 'auto'
                        })
        except Exception:
            pass
    
    return devices

@bp.route('/scan')
@auth_required
def api_network_scan():
    global _network_cache
    if time.time() - _network_cache["timestamp"] < 120 and _network_cache["data"]:
        return jsonify(_network_cache["data"])
        
    data = scan_network()
    
    # Sadece küçük çapta port taraması yap
    for device in data[:10]:
        device['ports'] = scan_ports(device['ip'])
    
    _network_cache["data"] = data
    _network_cache["timestamp"] = time.time()
    return jsonify(data)


@bp.route('/topology', methods=['GET'])
@auth_required
def get_topology():
    topo = get_topology_data()
    # Haritadaki tüm veriyi tarama verisi ile harmanlayarak gönder
    global _network_cache
    scanned = _network_cache.get("data", [])
    if not scanned or time.time() - _network_cache.get("timestamp", 0) > 300:
        scanned = scan_network()
        _network_cache["data"] = scanned
        _network_cache["timestamp"] = time.time()

    # scanned cihazları nodes içerisine göm, eksikse ekle
    # Ancak manuel cihazlar da var.
    
    client_ip = request.remote_addr
    result_nodes = dict(topo.get("nodes", {}))
    
    # Kendi IP'sini (Tarayıcıyı açan bilgisayarı) zorla listeye ekle ki "Neden kendi PC'mi göremiyorum" demesin
    client_found = False
    for dev in scanned:
        if dev['ip'] == client_ip:
            client_found = True
            break
    if not client_found and client_ip and client_ip != "127.0.0.1":
        scanned.append({
            "ip": client_ip,
            "mac": "Bilinmiyor (Senin Cihazın)",
            "vendor": "Mevcut Tarayıcı İstemcisi",
            "hostname": "Kendi Bilgisayarın"
        })

    
    for dev in scanned:
        ip = dev['ip']
        if ip not in result_nodes:
            hostname = dev.get('hostname')
            if hostname and hostname != ip:
                lbl = f"{hostname}\n{ip}"
            else:
                lbl = ip
            result_nodes[ip] = {
                "id": ip,
                "label": lbl,
                "ip": ip,
                "mac": dev.get('mac'),
                "vendor": dev.get('vendor'),
                "type": "auto",
                "ports": dev.get('ports', [])
            }
        else:
            # Sadece taranan bilgileri güncelle, x, y ve credentials vs ezme
            result_nodes[ip]["mac"] = dev.get('mac')
            result_nodes[ip]["vendor"] = dev.get('vendor')
            if not result_nodes[ip].get("ports"):
                result_nodes[ip]["ports"] = dev.get('ports', [])

    return jsonify({
        "nodes": list(result_nodes.values()),
        "edges": topo.get("edges", []),
        "shapes": topo.get("shapes", []),
        "floor_plan": topo.get("floor_plan", None)
    })

@bp.route('/topology/save', methods=['POST'])
@auth_required
def save_topology():
    data = request.json
    if not data:
        return jsonify({"success": False, "error": "No data"})
        
    topo = get_topology_data()
    
    # Update nodes (x, y, credentials, manual additions)
    for node in data.get('nodes', []):
        nid = node.get('id')
        if nid:
            if nid not in topo['nodes']:
                topo['nodes'][nid] = {}
            topo['nodes'][nid].update(node)
            
    # Remove deleted nodes? E.g. if a manual node is removed
    deleted_nodes = data.get('deleted_nodes', [])
    for nid in deleted_nodes:
        if nid in topo['nodes']:
            del topo['nodes'][nid]
            
    # Update edges
    topo['edges'] = data.get('edges', topo.get('edges', []))

    # Update shapes (dikdörtgen, daire vb. çizim alanları)
    if 'shapes' in data:
        topo['shapes'] = data.get('shapes', [])

    # Update floor_plan (Kat planı / Kroki altlığı)
    if 'floor_plan' in data:
        topo['floor_plan'] = data.get('floor_plan')
    
    success = save_topology_data(topo)
    # Her kayıtta changelog snapshot al
    try:
        changelog_manager.save_snapshot(topo)
    except Exception as e:
        print(f'Changelog error: {e}')
    return jsonify({"success": success})


import concurrent.futures

def ping_host(ip):
    try:
        r = subprocess.run(['ping', '-c', '1', '-W', '1', ip], capture_output=True, timeout=1.5)
        return r.returncode == 0
    except Exception:
        return False

@bp.route('/liveness', methods=['POST'])
@auth_required
def check_liveness():
    data = request.json
    ips = data.get('ips', [])
    results = {}
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
        future_to_ip = {executor.submit(ping_host, ip): ip for ip in ips}
        for future in concurrent.futures.as_completed(future_to_ip):
            ip = future_to_ip[future]
            try:
                results[ip] = future.result()
            except Exception:
                results[ip] = False

    # Alarm kurallarını liveness sonuçlarıyla kontrol et (Telegram bildirimleri burada tetiklenir)
    try:
        alarm_manager.check_alarms(results)
    except Exception as e:
        print(f"[Alarms] check_alarms error: {e}")

    return jsonify(results)

@bp.route('/syslog/<ip>')
@auth_required
def get_syslog(ip):
    syslog_server.load_logs()
    logs = syslog_server.logs_db.get(ip, [])
    return jsonify({"ip": ip, "logs": logs})

@bp.route('/traffic_local')
@auth_required
def get_local_traffic():
    try:
        with open('/proc/net/dev', 'r') as f:
            lines = f.readlines()
        data = {}
        for line in lines[2:]:
            parts = line.split(':')
            if len(parts) == 2:
                iface = parts[0].strip()
                stats = parts[1].split()
                # rx_bytes, tx_bytes
                data[iface] = {"rx": int(stats[0]), "tx": int(stats[8])}
        return jsonify({"success": True, "data": data})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})

@bp.route('/backup', methods=['POST'])
@auth_required
def perform_backup():
    req = request.json
    ip = req.get('ip')
    user = req.get('username') or 'root'
    pw = req.get('password') or ''
    device_type = req.get('deviceType')
    
    if not ip:
        return jsonify({"success": False, "error": "IP required"})
        
    backup_dir = "/opt/tinc-hub/shared/backups"
    os.makedirs(backup_dir, exist_ok=True)
    filename = f"{backup_dir}/{ip}_{time.strftime('%Y%m%d_%H%M%S')}.cfg"
    
    cmd = ""
    if device_type == 'router' or device_type == 'switch':
        # Simulated backup for cisco/mikrotik
        cmd = f"sshpass -p '{pw}' ssh -o StrictHostKeyChecking=no {user}@{ip} 'show running-config' > {filename}"
    else:
        # Linux / generic
        cmd = f"sshpass -p '{pw}' ssh -o StrictHostKeyChecking=no {user}@{ip} 'cat /etc/network/interfaces || cat /etc/netplan/*.yaml || ip a' > {filename}"
        
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, timeout=10)
        if r.returncode == 0:
            return jsonify({"success": True, "message": f"Backup saved to {filename}"})
        else:
            return jsonify({"success": False, "error": r.stderr.decode('utf-8') or 'Unknown SSH error'})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})

@bp.route('/wireshark_stats')
@auth_required
def get_wireshark_stats():
    # tcpdump istatistiklerini json'dan okur.
    stats_file = "/opt/tinc-hub/shared/wireshark_stats.json"
    if os.path.exists(stats_file):
        try:
            with open(stats_file, 'r') as f:
                return jsonify({"success": True, "data": json.load(f)})
        except:
            pass
    return jsonify({"success": False, "error": "Stats not ready yet"})

@bp.route('/reboot', methods=['POST'])
@auth_required
def perform_reboot():
    req = request.json
    ip = req.get('ip')
    user = req.get('username') or 'root'
    pw = req.get('password') or ''
    device_type = req.get('deviceType')
    
    if not ip:
        return jsonify({"success": False, "error": "IP gerekli"})
    if not pw:
        return jsonify({"success": False, "error": "Cihaz şifresi girilmemiş!"})
        
    cmd = ""
    # Mikrotik or Cisco might need different commands, but generally 'reboot' works for Linux/OpenWrt
    if device_type == 'router' or device_type == 'switch':
        cmd = f"sshpass -p '{pw}' ssh -o StrictHostKeyChecking=no {user}@{ip} 'reboot || /system reboot' "
    else:
        cmd = f"sshpass -p '{pw}' ssh -o StrictHostKeyChecking=no {user}@{ip} 'sudo reboot || reboot'"
        
    try:
        # Popen without waiting since SSH connection will drop on reboot
        import subprocess
        subprocess.Popen(cmd, shell=True)
        return jsonify({"success": True, "message": "Reboot komutu gönderildi"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


# ─── Alarm Endpoints ──────────────────────────────────────────────────────────

@bp.route('/alarms', methods=['GET'])
@auth_required
def get_alarms():
    """Tüm alarm kurallarını ve son alarm loglarını döndürür."""
    log = []
    if os.path.exists(alarm_manager.ALARM_LOG_FILE):
        try:
            with open(alarm_manager.ALARM_LOG_FILE) as f:
                log = json.load(f)
        except Exception:
            pass
    return jsonify({"alarms": alarm_manager.load_alarms(), "log": log[-20:]})


@bp.route('/alarms', methods=['POST'])
@auth_required
def create_alarm():
    """Yeni alarm kuralı oluşturur."""
    d = request.json
    rule = alarm_manager.add_alarm(
        ip=d.get("ip", ""),
        label=d.get("label", d.get("ip", "")),
        threshold_sec=int(d.get("threshold_sec", 180)),
        channel=d.get("channel", "telegram"),
        telegram_token=d.get("telegram_token", ""),
        telegram_chat_id=d.get("telegram_chat_id", "")
    )
    return jsonify({"success": True, "alarm": rule})


@bp.route('/alarms/<alarm_id>', methods=['DELETE'])
@auth_required
def delete_alarm(alarm_id):
    """Alarm kuralını siler."""
    alarm_manager.delete_alarm(alarm_id)
    return jsonify({"success": True})


@bp.route('/alarms/test', methods=['POST'])
@auth_required
def test_alarm():
    """Telegram token/chat_id'yi doğrulamak için test mesajı gönderir."""
    d = request.json
    ok = alarm_manager.send_telegram(
        d.get("telegram_token", ""),
        d.get("telegram_chat_id", ""),
        "✅ *Tinc-Hub Test Mesajı*\n\nAlarm sistemi başarıyla yapılandırıldı!"
    )
    return jsonify({"success": ok, "error": "" if ok else "Token veya Chat ID hatalı"})


# ─── Metrics Endpoints ────────────────────────────────────────────────────────

@bp.route('/metrics/<ip>')
@auth_required
def get_device_metrics(ip):
    """
    Belirtilen IP için tarihsel ping latency verilerini döndürür.
    Frontend Chart.js ile bu veriyi grafik olarak çizer.
    """
    metrics = metrics_collector.load_metrics()
    device_data = metrics.get(ip, {"timestamps": [], "latency": []})
    return jsonify({"success": True, "ip": ip, "data": device_data})


@bp.route('/metrics/traffic/history')
@auth_required
def get_traffic_history():
    """
    Sunucu ağ arayüzlerinin tarihsel RX/TX Mbps verilerini döndürür.
    Son 288 veri noktası (24 saat) döner.
    """
    traffic = metrics_collector.load_traffic()
    return jsonify({"success": True, "data": traffic})


# ─── Servis İzleme ────────────────────────────────────────────────────────────

@bp.route('/service_check', methods=['POST'])
@auth_required
def service_check():
    """Belirtilen IP'de HTTP/TCP servis kontrolü yapar. Gerçek bağlantı - mock değil."""
    d = request.json
    ip = d.get('ip')
    services = d.get('services', [{'type': 'http', 'port': 80}, {'type': 'tcp', 'port': 22}])
    if not ip:
        return jsonify({'success': False, 'error': 'IP gerekli'})
    results = service_monitor.check_services(ip, services)
    return jsonify({'success': True, 'ip': ip, 'results': results})


# ─── Bakım Penceresi ─────────────────────────────────────────────────────────

MAINTENANCE_FILE = '/opt/tinc-hub/shared/maintenance.json'

@bp.route('/maintenance', methods=['GET'])
@auth_required
def get_maintenance():
    """Aktif bakım pencerelerini döndürür."""
    if os.path.exists(MAINTENANCE_FILE):
        try:
            with open(MAINTENANCE_FILE) as f:
                return jsonify({'success': True, 'data': json.load(f)})
        except Exception:
            pass
    return jsonify({'success': True, 'data': []})

@bp.route('/maintenance', methods=['POST'])
@auth_required
def set_maintenance():
    """Bakım penceresi ekler. Bu süre zarfında alarm gönderilmez."""
    d = request.json
    data = []
    if os.path.exists(MAINTENANCE_FILE):
        try:
            with open(MAINTENANCE_FILE) as f:
                data = json.load(f)
        except Exception:
            pass
    entry = {
        'id': f'maint-{int(time.time())}',
        'ip': d.get('ip', '*'),
        'label': d.get('label', ''),
        'start': d.get('start', ''),
        'end': d.get('end', ''),
        'created_at': time.strftime('%Y-%m-%d %H:%M:%S')
    }
    data.append(entry)
    os.makedirs(os.path.dirname(MAINTENANCE_FILE), exist_ok=True)
    with open(MAINTENANCE_FILE, 'w') as f:
        json.dump(data, f, indent=2)
    return jsonify({'success': True, 'entry': entry})

@bp.route('/maintenance/<maint_id>', methods=['DELETE'])
@auth_required
def delete_maintenance(maint_id):
    """Bakım penceresini siler."""
    data = []
    if os.path.exists(MAINTENANCE_FILE):
        try:
            with open(MAINTENANCE_FILE) as f:
                data = json.load(f)
        except Exception:
            pass
    data = [m for m in data if m['id'] != maint_id]
    with open(MAINTENANCE_FILE, 'w') as f:
        json.dump(data, f, indent=2)
    return jsonify({'success': True})


# ─── Değişiklik Günlüğü ───────────────────────────────────────────────────────

@bp.route('/changelog', methods=['GET'])
@auth_required
def get_changelog():
    """Topoloji snapshot listesini döndürür."""
    return jsonify({'success': True, 'snapshots': changelog_manager.list_snapshots()})

@bp.route('/changelog/<filename>', methods=['GET'])
@auth_required
def get_snapshot(filename):
    """Belirtilen snapshot'ı döndürür."""
    data = changelog_manager.load_snapshot(filename)
    return jsonify({'success': data is not None, 'data': data})

@bp.route('/changelog/diff', methods=['POST'])
@auth_required
def diff_changelog():
    """İki snapshot arasındaki farkları karşılaştırır."""
    d = request.json
    diff = changelog_manager.diff_snapshots(d.get('file1'), d.get('file2'))
    return jsonify({'success': True, 'diff': diff})


# ─── Envanter & CSV Export ────────────────────────────────────────────────────

@bp.route('/inventory/csv')
@auth_required
def export_inventory_csv():
    """Tüm cihazları CSV formatında dışa aktarır."""
    from flask import Response
    topo = get_topology_data()
    nodes = topo.get('nodes', {})
    rows = ['IP/ID,Etiket,Cihaz Türü,Ağ Geçidi,DNS,Roller,MAC,Üretici,Dış IP,Küme,Kullanıcı Adı,Not']
    for nid, n in nodes.items():
        roles = n.get('roles', [])
        roles_str = '; '.join(roles) if isinstance(roles, list) else str(roles)
        rows.append(','.join([
            str(n.get('id', nid)),
            str(n.get('rawLabel', n.get('label', ''))).replace(',', ';'),
            str(n.get('deviceType', '')),
            str(n.get('gateway', '')),
            str(n.get('dns', '')),
            f'"{roles_str}"',
            str(n.get('mac', '')),
            str(n.get('vendor', '')).replace(',', ';'),
            str(n.get('ext_ip', '')),
            str(n.get('groupName', '')),
            str(n.get('username', '')),
            str(n.get('notes', '')).replace('\n', ' ').replace(',', ';')
        ]))
    return Response('\n'.join(rows), mimetype='text/csv',
                   headers={'Content-Disposition': 'attachment; filename=tinc-hub-inventory.csv'})


# ─── LLDP Topoloji Keşfi ─────────────────────────────────────────────────────

@bp.route('/lldp_discover')
@auth_required
def lldp_discover():
    """
    LLDP komşu tablosunu okuyarak ağ topolojisini otomatik keşfeder.
    lldpd kurulu ve çalışıyorsa lldpcli, yoksa ip neighbor + nmap ile fallback.
    Döndürdüğü kenarlar (from/to çiftleri) haritada otomatik kablo olarak kullanılabilir.
    """
    edges = []

    # Yöntem 1: lldpcli (lldpd servisi çalışıyorsa)
    try:
        r = subprocess.run(['lldpcli', 'show', 'neighbors', 'detail'],
                          capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            # lldpcli çıktısını parse et
            current_chassis = None
            local_iface = None
            for line in r.stdout.splitlines():
                line = line.strip()
                if 'Interface:' in line:
                    local_iface = line.split('Interface:')[1].split(',')[0].strip()
                elif 'ChassisID:' in line or 'MgmtIP:' in line:
                    ip_match = re.search(r'(\d+\.\d+\.\d+\.\d+)', line)
                    if ip_match:
                        current_chassis = ip_match.group(1)
                elif current_chassis and local_iface:
                    # Sunucunun kendi IP'si
                    local_ip = None
                    try:
                        import socket
                        local_ip = socket.gethostbyname(socket.gethostname())
                    except Exception:
                        pass
                    if local_ip:
                        edges.append({
                            'from': local_ip,
                            'to': current_chassis,
                            'local_iface': local_iface,
                            'source': 'lldp'
                        })
                    current_chassis = None
                    local_iface = None
            if edges:
                return jsonify({'success': True, 'source': 'lldp', 'edges': edges})
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f'LLDP error: {e}')

    # Yöntem 2: ip neighbor (ARP tablosu) - LLDP yoksa fallback
    try:
        r = subprocess.run(['ip', 'neigh', 'show'],
                          capture_output=True, text=True, timeout=5)
        local_ip = None
        try:
            import socket
            local_ip = socket.gethostbyname(socket.gethostname())
        except Exception:
            pass

        for line in r.stdout.splitlines():
            ip_match = re.search(r'^(\d+\.\d+\.\d+\.\d+)', line)
            if ip_match and 'REACHABLE' in line and local_ip:
                edges.append({
                    'from': local_ip,
                    'to': ip_match.group(1),
                    'source': 'arp'
                })
        return jsonify({'success': True, 'source': 'arp_fallback', 'edges': edges})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e), 'edges': []})


# ── Yerel Ağ UPnP / SSDP & mDNS Cihaz Keşfi ──────────────────────────────────
def discover_upnp_devices(timeout=2.5):
    """SSDP M-SEARCH UDP yayını ile ağdaki router, TV, kamera, switch ve yazıcıların model/üretici adlarını bulur."""
    import socket
    import urllib.request
    import xml.etree.ElementTree as ET

    ssdp_msg = (
        'M-SEARCH * HTTP/1.1\r\n'
        'HOST: 239.255.255.250:1900\r\n'
        'MAN: "ssdp:discover"\r\n'
        'MX: 2\r\n'
        'ST: ssdp:all\r\n\r\n'
    ).encode('utf-8')

    devices = {}
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.settimeout(timeout)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)

    try:
        sock.sendto(ssdp_msg, ('239.255.255.250', 1900))
        start_t = time.time()
        while time.time() - start_t < timeout:
            try:
                data, addr = sock.recvfrom(4096)
                ip = addr[0]
                resp_text = data.decode('utf-8', errors='ignore')
                loc_match = re.search(r'LOCATION:\s*(http[^\r\n]+)', resp_text, re.IGNORECASE)
                server_match = re.search(r'SERVER:\s*([^\r\n]+)', resp_text, re.IGNORECASE)
                
                dev_info = devices.get(ip, {'ip': ip, 'vendor': '', 'model': '', 'name': '', 'type': 'generic', 'source': 'upnp'})
                if server_match and not dev_info.get('model'):
                    dev_info['model'] = server_match.group(1).strip()
                
                # LOCATION URL'sindeki XML dosyasından dost canlısı cihaz ismi ve üreticiyi çek
                if loc_match and not dev_info.get('name'):
                    loc_url = loc_match.group(1).strip()
                    try:
                        req = urllib.request.Request(loc_url, headers={'User-Agent': 'TincHub-UPnP'})
                        with urllib.request.urlopen(req, timeout=1.5) as r_xml:
                            xml_str = r_xml.read()
                            root = ET.fromstring(xml_str)
                            # xmlns tag strip
                            ns = {'ns': root.tag.split('}')[0].strip('{')} if '}' in root.tag else {}
                            def find_val(tag):
                                el = root.find(f".//{tag}") if not ns else root.find(f".//ns:{tag}", ns)
                                return el.text.strip() if el is not None and el.text else ""
                            fn = find_val('friendlyName')
                            man = find_val('manufacturer')
                            mod = find_val('modelName') or find_val('modelNumber')
                            dt = find_val('deviceType')
                            if fn: dev_info['name'] = fn
                            if man: dev_info['vendor'] = man
                            if mod: dev_info['model'] = mod
                            if dt:
                                dt_l = dt.lower()
                                if 'router' in dt_l or 'igd' in dt_l or 'gateway' in dt_l: dev_info['type'] = 'router'
                                elif 'media' in dt_l or 'tv' in dt_l: dev_info['type'] = 'iptv'
                                elif 'printer' in dt_l: dev_info['type'] = 'printer'
                                elif 'camera' in dt_l: dev_info['type'] = 'camera'
                    except Exception:
                        pass
                devices[ip] = dev_info
            except socket.timeout:
                break
            except Exception:
                pass
    except Exception as e:
        print(f"SSDP broadcast error: {e}")
    finally:
        sock.close()
    return list(devices.values())


@bp.route('/discover/enhanced')
@auth_required
def api_network_enhanced_discover():
    """
    Yerel ağdaki cihazları UPnP SSDP ve ARP / Nmap ile derinlemesine keşfeder,
    cihazların tam donanım marka, model ve isimlerini harmanlar.
    """
    upnp_devs = discover_upnp_devices(timeout=2.0)
    upnp_map = {d['ip']: d for d in upnp_devs}

    base_devs = scan_network()
    enhanced = []
    for b in base_devs:
        ip = b['ip']
        u = upnp_map.get(ip, {})
        brand = u.get('vendor') or b.get('vendor') or ''
        model = u.get('model') or ''
        name = u.get('name') or b.get('hostname') or ''
        d_type = u.get('type') or b.get('type') or 'generic'
        
        enhanced.append({
            'ip': ip,
            'mac': b.get('mac', ''),
            'vendor': brand,
            'model': model,
            'hostname': name or ip,
            'deviceType': d_type,
            'source': 'upnp+arp' if ip in upnp_map else 'arp'
        })
    
    # Haritadaki cihazları güncellemek üzere döndür
    return jsonify({'success': True, 'devices': enhanced, 'count': len(enhanced)})


# ── AI & Web Cihaz Özellik Arayıcısı (Hardware Spec Lookup) ───────────────────

DEVICE_SPECS_CACHE_FILE = "/opt/tinc-hub/shared/device_specs_cache.json"

def _load_device_specs_cache():
    if os.path.exists(DEVICE_SPECS_CACHE_FILE):
        try:
            with open(DEVICE_SPECS_CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def _save_device_specs_cache(cache):
    try:
        os.makedirs(os.path.dirname(DEVICE_SPECS_CACHE_FILE), exist_ok=True)
        with open(DEVICE_SPECS_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Device cache save error: {e}")

@bp.route('/device/lookup', methods=['GET', 'POST'])
def lookup_device_specs():
    """
    Kullanıcının girdiği marka/model bilgisine göre internetten veya yerel önbellekten
    cihazın teknik özelliklerini (port sayısı, hız, PoE, cihaz türü) çıkarır.
    """
    model_query = ""
    if request.method == 'POST':
        data = request.get_json() or {}
        model_query = data.get('query', '').strip()
    else:
        model_query = request.args.get('q', '').strip()

    if not model_query or len(model_query) < 2:
        return jsonify({'success': False, 'error': 'Lütfen geçerli bir marka/model girin.'}), 400

    cache_key = model_query.lower().strip()
    cache = _load_device_specs_cache()

    if cache_key in cache:
        res = cache[cache_key]
        res['cached'] = True
        return jsonify({'success': True, 'data': res})

    # Gemini AI Entegrasyonu (Varsa öncelikli kullanılır)
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    if not gemini_key and os.path.exists("/etc/tinc-hub/config.env"):
        try:
            from dotenv import dotenv_values
            env_cfg = dotenv_values("/etc/tinc-hub/config.env")
            gemini_key = env_cfg.get("GEMINI_API_KEY", "").strip()
        except Exception:
            pass

    if gemini_key:
        prompt_text = (
            f"You are a network hardware spec analyzer. Analyze this network device or computer: '{model_query}'.\n"
            f"Respond ONLY with a valid JSON object (no markdown, no backticks, no extra text) with these exact keys:\n"
            f'{{\n'
            f'  "deviceType": "switch" | "router" | "modem" | "server" | "pc" | "laptop" | "phone" | "camera" | "nvr" | "printer" | "generic",\n'
            f'  "port_count": integer (LAN port count, e.g. 1, 4, 8, 24, 48),\n'
            f'  "port_speed": "100 Mbps" | "1 Gbps" | "2.5 Gbps" | "10 Gbps",\n'
            f'  "wan_port": "none" | "100m" | "1g" | "2.5g",\n'
            f'  "wifi_type": "none" | "2.4ghz" | "dual" | "wifi6",\n'
            f'  "poe": true | false,\n'
            f'  "poe_power": float or integer (watts, or 0 if no PoE),\n'
            f'  "description": short one-sentence Turkish description\n'
            f'}}'
        )
        req_data = json.dumps({
            "contents": [{"parts": [{"text": prompt_text}]}],
            "generationConfig": {"temperature": 0.1, "maxOutputTokens": 300}
        }).encode('utf-8')
        
        gemini_models = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-1.5-flash"]
        for gm in gemini_models:
            try:
                import urllib.request
                ai_url = f"https://generativelanguage.googleapis.com/v1beta/models/{gm}:generateContent?key={gemini_key}"
                ai_req = urllib.request.Request(ai_url, data=req_data, headers={'Content-Type': 'application/json'}, method='POST')
                with urllib.request.urlopen(ai_req, timeout=6) as ai_resp:
                    raw_ai = json.loads(ai_resp.read().decode('utf-8'))
                    ai_text = raw_ai.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '')
                    ai_clean = re.sub(r'```(?:json)?\s*', '', ai_text).replace('```', '').strip()
                    parsed_ai = json.loads(ai_clean)
                    if isinstance(parsed_ai, dict) and 'deviceType' in parsed_ai:
                        ai_result = {
                            'model': model_query,
                            'deviceType': parsed_ai.get('deviceType', 'generic'),
                            'port_speed': parsed_ai.get('port_speed', '1 Gbps'),
                            'port_count': int(parsed_ai.get('port_count', 1)),
                            'wan_port': parsed_ai.get('wan_port', 'none'),
                            'wifi_type': parsed_ai.get('wifi_type', 'none'),
                            'poe': bool(parsed_ai.get('poe', False)),
                            'poe_power': float(parsed_ai.get('poe_power', 0)),
                            'bandwidth_mbps': 1000 if '1 Gbps' in parsed_ai.get('port_speed', '') else 100,
                            'description': parsed_ai.get('description', ''),
                            'source': f'gemini_ai ({gm})'
                        }
                        cache[cache_key] = ai_result
                        _save_device_specs_cache(cache)
                        return jsonify({'success': True, 'data': ai_result})
            except Exception as ai_err:
                print(f"Gemini API lookup ({gm}) exception: {ai_err}")

    # OpenAI / ChatGPT Fallback Entegrasyonu
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if not openai_key and os.path.exists("/etc/tinc-hub/config.env"):
        try:
            from dotenv import dotenv_values
            env_cfg = dotenv_values("/etc/tinc-hub/config.env")
            openai_key = env_cfg.get("OPENAI_API_KEY", "").strip()
        except Exception:
            pass

    if openai_key:
        try:
            import urllib.request
            ai_url = "https://api.openai.com/v1/chat/completions"
            prompt_text = (
                f"You are a network hardware spec analyzer. Analyze this network device or computer: '{model_query}'.\n"
                f"Respond ONLY with a valid JSON object (no markdown, no backticks, no extra text) with these exact keys:\n"
                f'{{\n'
                f'  "deviceType": "switch" | "router" | "modem" | "server" | "pc" | "laptop" | "phone" | "camera" | "nvr" | "printer" | "generic",\n'
                f'  "port_count": integer (LAN port count, e.g. 1, 4, 8, 24, 48),\n'
                f'  "port_speed": "100 Mbps" | "1 Gbps" | "2.5 Gbps" | "10 Gbps",\n'
                f'  "wan_port": "none" | "100m" | "1g" | "2.5g",\n'
                f'  "wifi_type": "none" | "2.4ghz" | "dual" | "wifi6",\n'
                f'  "poe": true | false,\n'
                f'  "poe_power": float or integer (watts, or 0 if no PoE),\n'
                f'  "description": short one-sentence Turkish description\n'
                f'}}'
            )
            req_data = json.dumps({
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": prompt_text}],
                "temperature": 0.1,
                "max_tokens": 300
            }).encode('utf-8')
            ai_req = urllib.request.Request(ai_url, data=req_data, headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {openai_key}'
            }, method='POST')
            with urllib.request.urlopen(ai_req, timeout=6) as ai_resp:
                raw_ai = json.loads(ai_resp.read().decode('utf-8'))
                ai_text = raw_ai.get('choices', [{}])[0].get('message', {}).get('content', '')
                ai_clean = re.sub(r'```(?:json)?\s*', '', ai_text).replace('```', '').strip()
                parsed_ai = json.loads(ai_clean)
                if isinstance(parsed_ai, dict) and 'deviceType' in parsed_ai:
                    ai_result = {
                        'model': model_query,
                        'deviceType': parsed_ai.get('deviceType', 'generic'),
                        'port_speed': parsed_ai.get('port_speed', '1 Gbps'),
                        'port_count': int(parsed_ai.get('port_count', 1)),
                        'wan_port': parsed_ai.get('wan_port', 'none'),
                        'wifi_type': parsed_ai.get('wifi_type', 'none'),
                        'poe': bool(parsed_ai.get('poe', False)),
                        'poe_power': float(parsed_ai.get('poe_power', 0)),
                        'bandwidth_mbps': 1000 if '1 Gbps' in parsed_ai.get('port_speed', '') else 100,
                        'description': parsed_ai.get('description', ''),
                        'source': 'openai_ai'
                    }
                    cache[cache_key] = ai_result
                    _save_device_specs_cache(cache)
                    return jsonify({'success': True, 'data': ai_result})
        except Exception as ai_err:
            print(f"OpenAI API lookup exception: {ai_err}")

    # Varsayılan başlangıç şablonu
    result = {
        'model': model_query,
        'deviceType': 'generic',
        'port_speed': '1 Gbps',
        'port_count': 1,
        'poe': False,
        'poe_power': 0,
        'bandwidth_mbps': 10,
        'description': '',
        'source': 'heuristic'
    }

    q_lower = model_query.lower()

    # 1. Hızlı Sezgisel (Heuristic) Analiz
    if any(w in q_lower for w in ['switch', 'sw', 'catalyst', 'procurve', 'netgear gs', 'tl-sg', 'edgeswitch', 'unifi switch']):
        result['deviceType'] = 'switch'
        result['port_speed'] = '1 Gbps'
        result['port_count'] = 24 if '2960' in q_lower else 8
        result['bandwidth_mbps'] = 1000
        if any(w in q_lower for w in ['pe', 'poe', 'pwr', '802.3']):
            result['poe'] = True
            result['poe_power'] = 64
    elif any(w in q_lower for w in ['router', 'gateway', 'mikrotik', 'hex', 'rb750', 'rb760', 'edge router', 'edgerouter', 'vigor', 'draytek']):
        result['deviceType'] = 'router'
        result['port_speed'] = '1 Gbps'
        result['port_count'] = 5
        result['bandwidth_mbps'] = 1000
    elif any(w in q_lower for w in ['fortinet', 'fortigate', 'firewall', 'pfsense', 'opnsense', 'sophos', 'watchguard', 'sonicwall']):
        result['deviceType'] = 'router'
        result['port_speed'] = '1 Gbps'
        result['port_count'] = 10 if ('60f' in q_lower or '60e' in q_lower or '40f' in q_lower) else 8
        result['bandwidth_mbps'] = 1000
    elif any(w in q_lower for w in ['nas', 'synology', 'diskstation', 'qnap', 'truenas', 'asustor', 'terramaster']):
        result['deviceType'] = 'server'
        result['port_speed'] = '1 Gbps'
        result['port_count'] = 2 if ('ds920' in q_lower or 'ds220' in q_lower or 'ds720' in q_lower) else 4
        result['bandwidth_mbps'] = 1000
    elif any(w in q_lower for w in ['cam', 'camera', 'ipc', 'hfw', 'hdw', 'ds-2cd', 'bullet', 'dome', 'ptz', 'hikvision', 'dahua', 'axis', 'uniview']):
        result['deviceType'] = 'camera'
        result['port_speed'] = '100 Mbps'
        result['port_count'] = 1
        result['poe'] = True
        result['poe_power'] = 7
        result['bandwidth_mbps'] = 6
    elif any(w in q_lower for w in ['nvr', 'dvr', 'ds-7', 'xvr', 'surveillance']):
        result['deviceType'] = 'nvr'
        result['port_speed'] = '1 Gbps'
        result['port_count'] = 8
        result['bandwidth_mbps'] = 80
    elif any(w in q_lower for w in ['ap', 'access point', 'u6', 'uap', 'unifi ap', 'omada', 'eap', 'wap']):
        result['deviceType'] = 'router'
        result['port_speed'] = '1 Gbps'
        result['port_count'] = 1
        result['poe'] = True
        result['poe_power'] = 13
        result['bandwidth_mbps'] = 300
    elif any(w in q_lower for w in ['server', 'poweredge', 'proliant', 'primergy', 'thinksystem']):
        result['deviceType'] = 'server'
        result['port_speed'] = '1 Gbps'
        result['port_count'] = 4
        result['bandwidth_mbps'] = 1000
    elif any(w in q_lower for w in ['printer', 'laserjet', 'deskjet', 'ecotank', 'epson', 'brother']):
        result['deviceType'] = 'printer'
        result['port_speed'] = '100 Mbps'
        result['port_count'] = 1
        result['bandwidth_mbps'] = 2

    # Port adedi tespiti (örn: 24-port, 48p, 16 port, 8-port)
    port_match = re.search(r'(\d+)\s*(?:-| )*(?:port|ports|p\b)', q_lower)
    if port_match:
        try:
            val = int(port_match.group(1))
            if val in [2, 4, 5, 8, 10, 16, 24, 28, 48, 52]:
                result['port_count'] = val
                if result['deviceType'] == 'generic':
                    result['deviceType'] = 'switch'
        except Exception:
            pass

    # 10G / SFP+ tespiti
    if any(w in q_lower for w in ['10g', '10gbe', 'sfp+', '10 gigabit', 'qsfp']):
        result['port_speed'] = '10 Gbps'
        result['bandwidth_mbps'] = 10000
    elif any(w in q_lower for w in ['2.5g', '2.5gbe', 'multi-gig']):
        result['port_speed'] = '2.5 Gbps'
        result['bandwidth_mbps'] = 2500
    elif any(w in q_lower for w in ['fast ethernet', '10/100', '100m']):
        result['port_speed'] = '100 Mbps'
        result['bandwidth_mbps'] = 100

    # 2. İnternet Üzerinden Canlı Arama & Çıkarım (DuckDuckGo Search)
    try:
        import urllib.request
        import urllib.parse

        search_query = f"{model_query} specifications datasheet"
        url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(search_query)
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
            snippets = re.findall(r'<a[^>]*class="result__snippet"[^>]*>(.*?)</a>', html, re.DOTALL)
            joined_text = " ".join([re.sub(r'<[^>]+>', '', s).strip() for s in snippets[:4]]).lower()

            if joined_text:
                result['description'] = snippets[0].strip() if snippets else ''
                result['source'] = 'web'

                # Web metninden cihaz türü teyidi/düzeltmesi
                if 'camera' in joined_text or 'ip camera' in joined_text or 'bullet' in joined_text or 'dome' in joined_text:
                    result['deviceType'] = 'camera'
                    result['port_speed'] = '100 Mbps'
                    result['bandwidth_mbps'] = 6
                elif 'switch' in joined_text:
                    result['deviceType'] = 'switch'
                elif 'router' in joined_text or 'gateway' in joined_text:
                    result['deviceType'] = 'router'
                elif 'access point' in joined_text or 'wireless ap' in joined_text:
                    result['deviceType'] = 'router'
                elif 'nvr' in joined_text or 'network video recorder' in joined_text:
                    result['deviceType'] = 'nvr'

                # Web metninden port hızı
                if any(w in joined_text for w in ['10 gigabit', '10gbe', 'sfp+', '10 gbps']):
                    result['port_speed'] = '10 Gbps'
                    result['bandwidth_mbps'] = 10000
                elif any(w in joined_text for w in ['gigabit ethernet', '1000base-t', '10/100/1000', '1 gbps']):
                    result['port_speed'] = '1 Gbps'
                    result['bandwidth_mbps'] = 1000
                elif any(w in joined_text for w in ['fast ethernet', '10/100mbps', '10/100 base-t']):
                    result['port_speed'] = '100 Mbps'
                    result['bandwidth_mbps'] = 100

                # Web metninden port sayısı
                m_ports = re.search(r'(\d+)\s*(?:x|\*|-)?\s*(?:gigabit|fast ethernet|ports|port|rj45)', joined_text)
                if m_ports:
                    try:
                        p_val = int(m_ports.group(1))
                        if 1 <= p_val <= 64:
                            result['port_count'] = p_val
                    except Exception:
                        pass

                # Web metninden PoE kontrolü
                if 'poe' in joined_text or '802.3af' in joined_text or '802.3at' in joined_text or '802.3bt' in joined_text:
                    result['poe'] = True
                    m_watt = re.search(r'(\d+(?:\.\d+)?)\s*(?:w|watt)', joined_text)
                    if m_watt:
                        try:
                            result['poe_power'] = float(m_watt.group(1))
                        except Exception:
                            pass
                    elif result['deviceType'] == 'camera':
                        result['poe_power'] = 7.5
    except Exception as e:
        print(f"Device web lookup exception: {e}")

    # Önbelleğe kaydet (bir daha aratıldığında milisaniyede gelsin)
    cache[cache_key] = result
    _save_device_specs_cache(cache)

    return jsonify({'success': True, 'data': result})


@bp.route('/ping', methods=['POST'])
@auth_required
def api_network_ping():
    data = request.get_json() or {}
    ip = data.get('ip', '')
    if not re.match(r'^\d{1,3}(\.\d{1,3}){3}$', ip):
        return jsonify({'success': False, 'error': 'Geçersiz IP'}), 400
    try:
        r = subprocess.run(['ping', '-c', '4', '-W', '1', ip], 
                          capture_output=True, text=True, timeout=10)
        return jsonify({'success': True, 'output': r.stdout + r.stderr, 'reachable': r.returncode == 0})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@bp.route('/nmap', methods=['POST'])
@auth_required
def api_network_nmap():
    import shutil
    data = request.get_json() or {}
    ip = data.get('ip', '')
    if not re.match(r'^\d{1,3}(\.\d{1,3}){3}$', ip):
        return jsonify({'success': False, 'error': 'Geçersiz IP'}), 400
    if not shutil.which('nmap'):
        return jsonify({'success': False, 'error': 'nmap kurulu değil. sudo apt install nmap'}), 400
    try:
        r = subprocess.run(['nmap', '-T3', '--top-ports', '20', '--open', ip],
                          capture_output=True, text=True, timeout=30)
        return jsonify({'success': True, 'output': r.stdout})
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'error': 'Nmap zaman aşımı (30s)'}), 408
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

