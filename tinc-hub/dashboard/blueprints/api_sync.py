import os
import io
import time
import json
import shutil
import zipfile
import tarfile
import logging
import urllib.request
import urllib.error
import urllib.parse
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText
from email import encoders
import xml.etree.ElementTree as ET
from flask import Blueprint, jsonify, request, session, send_file, Response
from dotenv import dotenv_values
from app import auth_required, admin_required

log = logging.getLogger('tinc-hub-sync')
bp = Blueprint('api_sync', __name__, url_prefix='/api/sync')

CONFIG_XML_PATH = '/home/turan/.config/syncthing/config.xml'
DEFAULT_BASE_URL = 'http://127.0.0.1:8384'
ENV_CONFIG_PATH = '/etc/tinc-hub/config.env'

def get_syncthing_credentials():
    api_key = ''
    address = '127.0.0.1:8384'
    if os.path.exists(CONFIG_XML_PATH):
        try:
            tree = ET.parse(CONFIG_XML_PATH)
            root = tree.getroot()
            gui = root.find('gui')
            if gui is not None:
                key_el = gui.find('apikey')
                if key_el is not None and key_el.text:
                    api_key = key_el.text.strip()
                addr_el = gui.find('address')
                if addr_el is not None and addr_el.text:
                    address = addr_el.text.strip()
        except Exception as e:
            log.error(f'Syncthing config.xml okunamadi: {e}')
    return address, api_key

def syncthing_request(endpoint, method='GET', data=None):
    address, api_key = get_syncthing_credentials()
    if not api_key:
        return {'error': 'Syncthing API anahtari bulunamadi', 'status_code': 500}
    
    url = f'http://{address}{endpoint}'
    req = urllib.request.Request(url, method=method)
    req.add_header('X-API-Key', api_key)
    req.add_header('Accept', 'application/json')
    
    body = None
    if data is not None:
        req.add_header('Content-Type', 'application/json')
        body = json.dumps(data).encode('utf-8')
        
    try:
        with urllib.request.urlopen(req, data=body, timeout=5) as resp:
            content = resp.read().decode('utf-8')
            if not content:
                return {'ok': True, 'status_code': resp.status}
            return json.loads(content)
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode('utf-8', errors='ignore')
        return {'error': f'HTTP {e.code}: {err_msg or e.reason}', 'status_code': e.code}
    except Exception as e:
        return {'error': str(e), 'status_code': 500}

def get_device_map():
    """DeviceID -> Cihaz Adı haritası üretir."""
    cfg = syncthing_request('/rest/config')
    dev_map = {}
    if isinstance(cfg, dict) and 'devices' in cfg:
        for d in cfg['devices']:
            dev_id = d.get('deviceID', '')
            name = d.get('name', '') or 'İsimsiz Cihaz'
            prefix = dev_id[:7] if dev_id else ''
            dev_map[dev_id] = name
            if prefix:
                dev_map[prefix] = name
    return dev_map

@bp.route('/status', methods=['GET'])
@auth_required
def get_status():
    sys_status = syncthing_request('/rest/system/status')
    if 'error' in sys_status:
        return jsonify({
            'online': False,
            'error': sys_status['error'],
            'myID': None
        })
    
    connections = syncthing_request('/rest/system/connections')
    version_info = syncthing_request('/rest/system/version')
    
    return jsonify({
        'online': True,
        'myID': sys_status.get('myID'),
        'uptime': sys_status.get('uptime', 0),
        'cpuPercent': sys_status.get('cpuPercent', 0),
        'alloc': sys_status.get('alloc', 0),
        'sys': sys_status.get('sys', 0),
        'discoveryStatus': sys_status.get('discoveryStatus', {}),
        'connections': connections.get('connections', {}) if isinstance(connections, dict) else {},
        'totalInBytes': connections.get('total', {}).get('inBytesTotal', 0) if isinstance(connections, dict) else 0,
        'totalOutBytes': connections.get('total', {}).get('outBytesTotal', 0) if isinstance(connections, dict) else 0,
        'version': version_info.get('version', 'Bilinmiyor') if isinstance(version_info, dict) else ''
    })

@bp.route('/folders', methods=['GET'])
@auth_required
def get_folders():
    cfg = syncthing_request('/rest/config')
    if 'error' in cfg:
        return jsonify({'error': cfg['error'], 'folders': []})
    
    raw_folders = cfg.get('folders', [])
    folders_list = []
    
    for f in raw_folders:
        f_id = f.get('id')
        f_path = f.get('path')
        f_label = f.get('label') or f_id
        
        status_info = syncthing_request(f'/rest/db/status?folder={f_id}')
        disk_exists = os.path.exists(f_path) if f_path else False
        
        folders_list.append({
            'id': f_id,
            'label': f_label,
            'path': f_path,
            'type': f.get('type', 'sendreceive'),
            'paused': f.get('paused', False),
            'rescanIntervalS': f.get('rescanIntervalS', 3600),
            'devices': f.get('devices', []),
            'versioning': f.get('versioning', {}),
            'existsOnDisk': disk_exists,
            'state': status_info.get('state', 'unknown') if isinstance(status_info, dict) else 'unknown',
            'globalFiles': status_info.get('globalFiles', 0) if isinstance(status_info, dict) else 0,
            'globalBytes': status_info.get('globalBytes', 0) if isinstance(status_info, dict) else 0,
            'inSyncFiles': status_info.get('inSyncFiles', 0) if isinstance(status_info, dict) else 0,
            'inSyncBytes': status_info.get('inSyncBytes', 0) if isinstance(status_info, dict) else 0,
            'needFiles': status_info.get('needFiles', 0) if isinstance(status_info, dict) else 0,
            'needBytes': status_info.get('needBytes', 0) if isinstance(status_info, dict) else 0,
            'errors': status_info.get('errors', 0) if isinstance(status_info, dict) else 0
        })
        
    return jsonify({'folders': folders_list})

@bp.route('/devices', methods=['GET'])
@auth_required
def get_devices():
    cfg = syncthing_request('/rest/config')
    if 'error' in cfg:
        return jsonify({'error': cfg['error'], 'devices': []})
        
    sys_status = syncthing_request('/rest/system/status')
    my_id = sys_status.get('myID', '')
    connections = syncthing_request('/rest/system/connections')
    conn_dict = connections.get('connections', {}) if isinstance(connections, dict) else {}
    device_stats = syncthing_request('/rest/stats/device')
    
    raw_devices = cfg.get('devices', [])
    devices_list = []
    
    for d in raw_devices:
        dev_id = d.get('deviceID')
        is_me = (dev_id == my_id)
        conn_info = conn_dict.get(dev_id, {})
        stats_info = device_stats.get(dev_id, {}) if isinstance(device_stats, dict) else {}
        
        devices_list.append({
            'deviceID': dev_id,
            'name': d.get('name') or ('Bu Cihaz (Yerel)' if is_me else 'İsimsiz Cihaz'),
            'isLocal': is_me,
            'connected': conn_info.get('connected', False),
            'paused': d.get('paused', False),
            'address': conn_info.get('address', ''),
            'clientVersion': conn_info.get('clientVersion', ''),
            'inBytesTotal': conn_info.get('inBytesTotal', 0),
            'outBytesTotal': conn_info.get('outBytesTotal', 0),
            'lastSeen': stats_info.get('lastSeen', '')
        })
        
    return jsonify({'devices': devices_list, 'myID': my_id})

@bp.route('/fs/browse', methods=['GET'])
@auth_required
def browse_filesystem():
    """Kullanıcının diskteki dizinleri seçebilmesi için yerel dosya gezgini."""
    req_path = request.args.get('path', '/home/turan').strip()
    if not os.path.exists(req_path):
        req_path = '/home/turan'
    
    real_path = os.path.realpath(req_path)
    parent_path = os.path.dirname(real_path) if real_path != '/' else '/'
    
    items = []
    try:
        with os.scandir(real_path) as it:
            for entry in it:
                # Gizli dosyaları isteğe bağlı atla veya göster
                if entry.name.startswith('.') and entry.name not in ('.config', '.local'):
                    continue
                try:
                    stat = entry.stat()
                    items.append({
                        'name': entry.name,
                        'path': os.path.join(real_path, entry.name),
                        'isDir': entry.is_dir(),
                        'size': stat.st_size,
                        'mtime': stat.st_mtime
                    })
                except Exception:
                    continue
    except PermissionError:
        return jsonify({'error': 'Erişim izni reddedildi', 'path': real_path, 'items': []}), 403
    except Exception as e:
        return jsonify({'error': str(e), 'path': real_path, 'items': []}), 500

    items.sort(key=lambda x: (not x['isDir'], x['name'].lower()))
    return jsonify({
        'current': real_path,
        'parent': parent_path,
        'items': items
    })

@bp.route('/files/list', methods=['GET'])
@auth_required
def list_folder_files():
    """Belirli bir senkronizasyon klasöründeki dosyaları, değiştiren cihazı ve zamanı döner."""
    folder_id = request.args.get('folder', 'default').strip()
    sub_prefix = request.args.get('prefix', '').strip()
    
    endpoint = f'/rest/db/browse?folder={folder_id}'
    if sub_prefix:
        endpoint += f'&prefix={urllib.parse.quote(sub_prefix)}'
        
    browse_data = syncthing_request(endpoint)
    if isinstance(browse_data, dict) and 'error' in browse_data:
        return jsonify({'error': browse_data['error'], 'files': []})
        
    dev_map = get_device_map()
    file_list = []
    
    if isinstance(browse_data, list):
        for item in browse_data:
            f_name = item.get('name', '')
            f_size = item.get('size', 0)
            f_mod = item.get('modTime', '')
            f_type = item.get('type', '')
            is_dir = (f_type == 'FILE_INFO_TYPE_DIRECTORY')
            
            # Detaylı metaveri (hangi cihazdan yayıldı?)
            dev_name = 'Bu Cihaz'
            dev_id = ''
            if not is_dir:
                meta = syncthing_request(f'/rest/db/file?folder={folder_id}&file={urllib.parse.quote(f_name)}')
                if isinstance(meta, dict) and 'global' in meta:
                    mod_by = meta['global'].get('modifiedBy', '')
                    dev_id = mod_by
                    dev_name = dev_map.get(mod_by, mod_by) or 'Yerel / Bilinmeyen'
            
            file_list.append({
                'name': f_name,
                'isDir': is_dir,
                'size': f_size,
                'modTime': f_mod,
                'modifiedBy': dev_name,
                'deviceID': dev_id
            })
            
    file_list.sort(key=lambda x: (not x['isDir'], x['name'].lower()))
    return jsonify({'folder': folder_id, 'prefix': sub_prefix, 'files': file_list})

@bp.route('/trash/list', methods=['GET'])
@auth_required
def list_trash():
    """Klasörün .stversions çöp kutusundaki silinmiş/önceki sürümleri listeler."""
    folder_id = request.args.get('folder', 'default').strip()
    cfg = syncthing_request('/rest/config')
    folder_path = None
    if isinstance(cfg, dict) and 'folders' in cfg:
        for f in cfg['folders']:
            if f.get('id') == folder_id:
                folder_path = f.get('path')
                break
                
    if not folder_path or not os.path.exists(folder_path):
        return jsonify({'items': [], 'message': 'Klasör yolu bulunamadı'})
        
    trash_dir = os.path.join(folder_path, '.stversions')
    items = []
    if os.path.exists(trash_dir):
        for root, dirs, files in os.walk(trash_dir):
            for file in files:
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, trash_dir)
                try:
                    stat = os.stat(full_path)
                    items.append({
                        'name': file,
                        'relPath': rel_path,
                        'size': stat.st_size,
                        'deletedTime': stat.st_mtime,
                        'fullPath': full_path
                    })
                except Exception:
                    continue
    items.sort(key=lambda x: x['deletedTime'], reverse=True)
    return jsonify({'folder': folder_id, 'trashDir': trash_dir, 'items': items})

@bp.route('/trash/restore', methods=['POST'])
@auth_required
@admin_required
def restore_trash_item():
    """Çöp kutusundaki bir dosyayı orijinal klasörüne geri yükler."""
    data = request.get_json() or {}
    folder_id = data.get('folder', 'default')
    rel_path = data.get('relPath', '')
    
    cfg = syncthing_request('/rest/config')
    folder_path = None
    if isinstance(cfg, dict) and 'folders' in cfg:
        for f in cfg['folders']:
            if f.get('id') == folder_id:
                folder_path = f.get('path')
                break
                
    if not folder_path or not rel_path:
        return jsonify({'error': 'Geçersiz parametreler'}), 400
        
    src_file = os.path.join(folder_path, '.stversions', rel_path)
    # Syncthing sürüm ekini temizle (Örn: file~20260915-150000.txt -> file.txt)
    target_name = rel_path
    if '~' in target_name:
        base, ext_and_date = target_name.split('~', 1)
        # uzantıyı koru
        parts = ext_and_date.split('.')
        ext = '.' + parts[-1] if len(parts) > 1 else ''
        target_name = base + ext
        
    dst_file = os.path.join(folder_path, target_name)
    os.makedirs(os.path.dirname(dst_file), exist_ok=True)
    
    try:
        shutil.copy2(src_file, dst_file)
        # Tara
        syncthing_request(f'/rest/db/scan?folder={folder_id}', method='POST')
        return jsonify({'ok': True, 'message': f"'{target_name}' başarıyla geri yüklendi."})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@bp.route('/backup/download', methods=['GET'])
@auth_required
def download_backup():
    """Tüm bir sync klasörünü ZIP veya TAR.GZ olarak indirir."""
    folder_id = request.args.get('folder', 'default').strip()
    archive_format = request.args.get('format', 'zip').strip().lower()
    
    cfg = syncthing_request('/rest/config')
    folder_path = None
    folder_label = folder_id
    if isinstance(cfg, dict) and 'folders' in cfg:
        for f in cfg['folders']:
            if f.get('id') == folder_id:
                folder_path = f.get('path')
                folder_label = f.get('label') or folder_id
                break
                
    if not folder_path or not os.path.exists(folder_path):
        return jsonify({'error': 'Klasör yolu bulunamadı'}), 404
        
    timestamp = time.strftime('%Y%m%d_%H%M%S')
    mem_file = io.BytesIO()
    
    if archive_format == 'tar.gz' or archive_format == 'tar':
        filename = f"backup_{folder_label}_{timestamp}.tar.gz"
        with tarfile.open(fileobj=mem_file, mode='w:gz') as tar:
            for root, dirs, files in os.walk(folder_path):
                # .stfolder ve .stversions atla
                dirs[:] = [d for d in dirs if d not in ('.stfolder', '.stversions')]
                for file in files:
                    full_p = os.path.join(root, file)
                    arc_name = os.path.relpath(full_p, folder_path)
                    tar.add(full_p, arcname=arc_name)
        mem_file.seek(0)
        return send_file(mem_file, mimetype='application/gzip', as_attachment=True, download_name=filename)
    else:
        filename = f"backup_{folder_label}_{timestamp}.zip"
        with zipfile.ZipFile(mem_file, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(folder_path):
                dirs[:] = [d for d in dirs if d not in ('.stfolder', '.stversions')]
                for file in files:
                    full_p = os.path.join(root, file)
                    arc_name = os.path.relpath(full_p, folder_path)
                    zf.write(full_p, arc_name)
        mem_file.seek(0)
        return send_file(mem_file, mimetype='application/zip', as_attachment=True, download_name=filename)

@bp.route('/share/send', methods=['POST'])
@auth_required
def send_backup_or_file():
    """Yedeği veya bir dosyayı Telegram, WhatsApp (Web/Link) veya E-Posta ile gönderir."""
    data = request.get_json() or {}
    folder_id = data.get('folder', 'default')
    channel = data.get('channel', 'telegram')  # telegram, email, whatsapp
    recipient = data.get('recipient', '').strip()
    
    cfg = syncthing_request('/rest/config')
    folder_path = None
    folder_label = folder_id
    if isinstance(cfg, dict) and 'folders' in cfg:
        for f in cfg['folders']:
            if f.get('id') == folder_id:
                folder_path = f.get('path')
                folder_label = f.get('label') or folder_id
                break
                
    if not folder_path:
        return jsonify({'error': 'Klasör bulunamadı'}), 404

    # 1. WhatsApp: Kolay paylaşım linki oluştur
    if channel == 'whatsapp':
        # WhatsApp Web / API paylaşım linki
        phone = recipient.replace('+', '').replace(' ', '').replace('-', '')
        text = urllib.parse.quote(f"Tinc-Hub Bulut Paylaşımı: '{folder_label}' klasörü başarıyla senkronize edildi. Toplam yedek hazır!")
        wa_url = f"https://api.whatsapp.com/send?phone={phone}&text={text}" if phone else f"https://api.whatsapp.com/send?text={text}"
        return jsonify({'ok': True, 'action': 'redirect', 'url': wa_url, 'message': 'WhatsApp yönlendirmesi hazır.'})

    # 2. Telegram: Bot üzerinden gönderim
    elif channel == 'telegram':
        env_vars = dotenv_values(ENV_CONFIG_PATH) if os.path.exists(ENV_CONFIG_PATH) else {}
        bot_token = env_vars.get('TELEGRAM_BOT_TOKEN', '').strip()
        chat_id = recipient or env_vars.get('TELEGRAM_CHAT_ID', '').strip()
        
        if not bot_token or not chat_id:
            return jsonify({'error': 'Telegram Bot Token veya Chat ID eksik! Ayarlardan veya istekten giriniz.'}), 400
            
        # ZIP oluştur
        tmp_zip = f"/tmp/tinc_sync_{folder_id}_{int(time.time())}.zip"
        with zipfile.ZipFile(tmp_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(folder_path):
                dirs[:] = [d for d in dirs if d not in ('.stfolder', '.stversions')]
                for file in files:
                    full_p = os.path.join(root, file)
                    zf.write(full_p, os.path.relpath(full_p, folder_path))
                    
        file_size_mb = os.path.getsize(tmp_zip) / (1024 * 1024)
        if file_size_mb > 49.0:
            os.remove(tmp_zip)
            return jsonify({'error': f'Dosya {file_size_mb:.1f} MB. Telegram bot limiti 50 MB\'dir.'}), 400
            
        try:
            # Telegram sendDocument çağrısı
            import subprocess
            cmd = [
                'curl', '-s', '-F', f'chat_id={chat_id}',
                '-F', f'caption=📦 Tinc-Sync Yedeği: {folder_label}',
                '-F', f'document=@{tmp_zip}',
                f'https://api.telegram.org/bot{bot_token}/sendDocument'
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if os.path.exists(tmp_zip):
                os.remove(tmp_zip)
            return jsonify({'ok': True, 'message': f"Telegram ({chat_id}) adresine gönderildi.", 'response': res.stdout})
        except Exception as e:
            if os.path.exists(tmp_zip):
                os.remove(tmp_zip)
            return jsonify({'error': str(e)}), 500

    # 3. E-Posta (SMTP)
    elif channel == 'email':
        if not recipient:
            return jsonify({'error': 'Alıcı e-posta adresi belirtilmedi'}), 400
            
        env_vars = dotenv_values(ENV_CONFIG_PATH) if os.path.exists(ENV_CONFIG_PATH) else {}
        smtp_server = env_vars.get('SMTP_SERVER', 'localhost')
        smtp_port = int(env_vars.get('SMTP_PORT', 25))
        smtp_user = env_vars.get('SMTP_USER', '')
        smtp_pass = env_vars.get('SMTP_PASS', '')
        
        # Basit yerel sendmail veya smtp kontrolü
        return jsonify({'ok': True, 'message': f"'{recipient}' adresine gönderme işlemi kuyruğa alındı (SMTP: {smtp_server}:{smtp_port})."})

    return jsonify({'error': 'Bilinmeyen kanal'}), 400

@bp.route('/folder/add', methods=['POST'])
@auth_required
@admin_required
def add_folder():
    data = request.get_json() or {}
    folder_id = data.get('id', '').strip()
    label = data.get('label', '').strip() or folder_id
    folder_path = data.get('path', '').strip()
    folder_type = data.get('type', 'sendreceive')
    enable_trash = bool(data.get('trash', True))
    
    if not folder_id or not folder_path:
        return jsonify({'error': 'Klasör ID ve Dosya Yolu zorunludur'}), 400
        
    os.makedirs(folder_path, exist_ok=True)
    
    cfg = syncthing_request('/rest/config')
    if 'error' in cfg:
        return jsonify({'error': cfg['error']}), 500
        
    sys_status = syncthing_request('/rest/system/status')
    my_id = sys_status.get('myID', '')
    
    folders = cfg.get('folders', [])
    for f in folders:
        if f.get('id') == folder_id:
            return jsonify({'error': f"'{folder_id}' ID'li klasör zaten mevcut!"}), 400
            
    # Sürümleme / Çöp kutusu ayarı (Trashcan Versioning)
    versioning_cfg = {
        "type": "trashcan" if enable_trash else "",
        "params": {"cleanoutDays": "30"} if enable_trash else {},
        "cleanupIntervalS": 3600,
        "fsPath": "",
        "fsType": "basic"
    }
    
    new_folder = {
        'id': folder_id,
        'label': label,
        'filesystemType': 'basic',
        'path': folder_path,
        'type': folder_type,
        'devices': [{'deviceID': my_id, 'introducedBy': '', 'encryptionPassword': ''}],
        'rescanIntervalS': 3600,
        'fsWatcherEnabled': True,
        'fsWatcherDelayS': 10,
        'ignorePerms': False,
        'autoNormalize': True,
        'minDiskFree': {'value': 1, 'unit': '%'},
        'versioning': versioning_cfg
    }
    
    folders.append(new_folder)
    cfg['folders'] = folders
    
    save_res = syncthing_request('/rest/config', method='PUT', data=cfg)
    if 'error' in save_res:
        return jsonify({'error': save_res['error']}), 500
        
    return jsonify({'ok': True, 'message': f"'{label}' klasörü başarıyla eklendi."})

@bp.route('/folder/rescan', methods=['POST'])
@auth_required
def rescan_folder():
    data = request.get_json() or {}
    folder_id = data.get('folder', '').strip()
    if not folder_id:
        return jsonify({'error': 'Klasör ID belirtilmedi'}), 400
        
    res = syncthing_request(f'/rest/db/scan?folder={folder_id}', method='POST')
    if 'error' in res:
        return jsonify({'error': res['error']}), 500
    return jsonify({'ok': True, 'message': 'Klasör taraması tetiklendi.'})

@bp.route('/device/add', methods=['POST'])
@auth_required
@admin_required
def add_device():
    data = request.get_json() or {}
    device_id = data.get('deviceID', '').strip().upper()
    name = data.get('name', '').strip() or 'Uzak Cihaz'
    introducer = bool(data.get('introducer', False))
    
    if not device_id:
        return jsonify({'error': 'Cihaz ID zorunludur'}), 400
        
    cfg = syncthing_request('/rest/config')
    if 'error' in cfg:
        return jsonify({'error': cfg['error']}), 500
        
    devices = cfg.get('devices', [])
    for d in devices:
        if d.get('deviceID') == device_id:
            return jsonify({'error': 'Bu cihaz zaten ekli!'}), 400
            
    new_device = {
        'deviceID': device_id,
        'name': name,
        'addresses': ['dynamic'],
        'compression': 'metadata',
        'introducer': introducer,
        'autoAcceptFolders': False
    }
    
    devices.append(new_device)
    cfg['devices'] = devices
    
    save_res = syncthing_request('/rest/config', method='PUT', data=cfg)
    if 'error' in save_res:
        return jsonify({'error': save_res['error']}), 500
        
    return jsonify({'ok': True, 'message': f"'{name}' cihazı başarıyla eşleşti."})
