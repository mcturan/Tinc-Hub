#!/usr/bin/env python3
import os
import sys
import yaml
import time
import subprocess
import threading
import webbrowser
import pystray
from pystray import MenuItem as item, Menu
from PIL import Image, ImageDraw

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

APPS_YAML = "/etc/tinc-hub/apps.yaml"

def run_cmd(cmd):
    try:
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        return res.returncode == 0, res.stdout.strip()
    except Exception:
        return False, ""

def is_service_running(service_name, is_user=False):
    if not service_name:
        return False
    cmd = f"systemctl --user is-active {service_name}" if is_user else f"systemctl is-active {service_name}"
    success, out = run_cmd(cmd)
    return out == "active"

def start_service(service_name, is_user=False):
    if not service_name: return
    cmd = f"systemctl --user start {service_name}" if is_user else f"sudo systemctl start {service_name}"
    run_cmd(cmd)

def stop_service(service_name, is_user=False):
    if not service_name: return
    cmd = f"systemctl --user stop {service_name}" if is_user else f"sudo systemctl stop {service_name}"
    run_cmd(cmd)

class TincHubTray:
    def __init__(self):
        self.apps = []
        self.service_states = {} # service_name -> bool
        self.cpu = 0.0
        self.ram_used = 0.0
        self.ram_total = 0.0
        self.disk = 0.0
        self.running_count = 0
        self.stopped_count = 0
        
        self.icon = pystray.Icon("Tinc Hub")
        self.update_data()
        self.icon.icon = self.create_image()
        self.icon.title = self.get_tooltip()
        self.icon.menu = self.build_menu()
        
        self.running = True
        self.thread = threading.Thread(target=self.refresh_loop, daemon=True)
        self.thread.start()

    def get_tooltip(self):
        return f"Tinc Hub — CPU: %{self.cpu} | RAM: {self.ram_used:.1f}/{self.ram_total:.1f} GB | {self.running_count} running, {self.stopped_count} stopped"

    def create_image(self):
        # Determine state
        state = "normal"
        if self.cpu > 90 or self.disk > 95:
            state = "critical"
        elif self.stopped_count > 0:
            state = "warning"

        width = 64
        height = 64
        
        if state == "critical":
            color1 = (220, 38, 38) # Red
        elif state == "warning":
            color1 = (202, 138, 4) # Yellow
        else:
            color1 = (30, 41, 59) # Blue/slate
            
        color2 = (226, 232, 240)
        
        image = Image.new('RGB', (width, height), color=color1)
        dc = ImageDraw.Draw(image)
        try:
            dc.text((16, 24), "TH", fill=color2)
        except:
            pass
            
        return image

    def update_data(self):
        # Update metrics
        if HAS_PSUTIL:
            try:
                self.cpu = psutil.cpu_percent(interval=None)
                mem = psutil.virtual_memory()
                self.ram_used = mem.used / (1024**3)
                self.ram_total = mem.total / (1024**3)
                disk_usage = psutil.disk_usage('/')
                self.disk = disk_usage.percent
            except Exception:
                pass
        
        # Update apps
        try:
            with open(APPS_YAML, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f) or {}
                self.apps = data.get("apps", [])
        except Exception:
            self.apps = []
            
        old_states = dict(self.service_states)
        self.running_count = 0
        self.stopped_count = 0
        
        for app in self.apps:
            srv = app.get("service")
            if not srv: continue
            
            is_user = app.get("is_user_service", False)
            is_running = is_service_running(srv, is_user)
            self.service_states[srv] = is_running
            
            if is_running:
                self.running_count += 1
            else:
                self.stopped_count += 1
                
            # Notifications
            if srv in old_states and old_states[srv] != is_running:
                state_str = "Başlatıldı" if is_running else "Durduruldu"
                try:
                    self.icon.notify(f"{app.get('name', srv)} {state_str}", "Servis Durumu Değişti")
                except Exception:
                    pass

    def build_menu(self):
        items = []
        
        # 1. System info
        info_str = f"Sistem: CPU %{self.cpu} | RAM {self.ram_used:.1f}/{self.ram_total:.1f}GB | Disk %{self.disk}"
        items.append(item(info_str, lambda: None, enabled=False))
        items.append(pystray.Menu.SEPARATOR)
        
        # 2. Services
        def make_toggle(srv, is_user):
            def toggle(icon, it):
                def task():
                    if self.service_states.get(srv):
                        stop_service(srv, is_user)
                    else:
                        start_service(srv, is_user)
                    self.update_tray()
                threading.Thread(target=task, daemon=True).start()
            return toggle

        for app in self.apps:
            srv = app.get("service")
            if not srv: continue
            name = app.get("name", srv)
            is_running = self.service_states.get(srv, False)
            emoji = "🟢" if is_running else "🔴"
            is_user = app.get("is_user_service", False)
            
            items.append(item(f"{emoji} {name}", make_toggle(srv, is_user)))
            
        items.append(pystray.Menu.SEPARATOR)
        
        # 3. Start All / Stop All
        def toggle_all(start):
            def task():
                for app in self.apps:
                    srv = app.get("service")
                    if not srv: continue
                    is_user = app.get("is_user_service", False)
                    if start and not self.service_states.get(srv, False):
                        start_service(srv, is_user)
                    elif not start and self.service_states.get(srv, False):
                        stop_service(srv, is_user)
                self.update_tray()
            threading.Thread(target=task, daemon=True).start()

        items.append(item("Tümünü Başlat", lambda: toggle_all(True)))
        items.append(item("Tümünü Durdur", lambda: toggle_all(False)))
        items.append(pystray.Menu.SEPARATOR)
        
        # 4. Links
        items.append(item("🌐 Dashboard Aç", lambda: webbrowser.open("http://127.0.0.1:9010")))
        items.append(item("📋 Görev Yöneticisi", lambda: webbrowser.open("http://127.0.0.1:9010/taskmanager")))
        items.append(item("📜 Loglar", lambda: webbrowser.open("http://127.0.0.1:9010/logs")))
        items.append(pystray.Menu.SEPARATOR)
        
        # 5. Exit
        items.append(item("Çıkış", self.stop))
        
        return Menu(*items)

    def update_tray(self):
        self.update_data()
        self.icon.icon = self.create_image()
        self.icon.title = self.get_tooltip()
        self.icon.menu = self.build_menu()
        self.icon.update_menu()

    def refresh_loop(self):
        while self.running:
            for _ in range(10):
                if not self.running: return
                time.sleep(1)
            self.update_tray()

    def stop(self, icon=None, item=None):
        self.running = False
        self.icon.stop()

    def run(self):
        self.icon.run()

if __name__ == "__main__":
    if HAS_PSUTIL:
        # psutil initialize for CPU calc
        psutil.cpu_percent(interval=None)
    tray = TincHubTray()
    tray.run()
