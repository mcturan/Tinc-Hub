import socket
import threading
import json
import os
import time

LOG_FILE = "/opt/tinc-hub/shared/device_logs.json"
MAX_LOGS_PER_IP = 50

logs_db = {}

def load_logs():
    global logs_db
    if os.path.exists(LOG_FILE):
        try:
            with open(LOG_FILE, 'r') as f:
                logs_db = json.load(f)
        except:
            pass

def save_logs():
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, 'w') as f:
            json.dump(logs_db, f)
    except:
        pass

def syslog_listener():
    load_logs()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.bind(("0.0.0.0", 10514))
    except Exception as e:
        print(f"Syslog bind error: {e}")
        return

    while True:
        try:
            data, addr = sock.recvfrom(1024)
            ip = addr[0]
            msg = data.decode('utf-8', errors='ignore').strip()
            
            if ip not in logs_db:
                logs_db[ip] = []
                
            logs_db[ip].append({
                "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                "message": msg
            })
            
            if len(logs_db[ip]) > MAX_LOGS_PER_IP:
                logs_db[ip].pop(0)
                
            save_logs()
        except Exception as e:
            time.sleep(1)

def start_syslog_server():
    t = threading.Thread(target=syslog_listener, daemon=True)
    t.start()
