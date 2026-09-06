import os
import yaml
import subprocess
import logging
import shutil

log = logging.getLogger("tinc-hub-plugins")

class PluginManager:
    PLUGINS_DIR = os.environ.get("TINC_HUB_PLUGINS", "/opt/tinc-hub/plugins")
    
    def __init__(self):
        self.plugins = {}
        self.load_all()
    
    def load_all(self):
        os.makedirs(self.PLUGINS_DIR, exist_ok=True)
        self.plugins = {}
        for d in os.listdir(self.PLUGINS_DIR):
            manifest_path = os.path.join(self.PLUGINS_DIR, d, 'tinc-plugin.yaml')
            if os.path.exists(manifest_path):
                try:
                    with open(manifest_path) as f:
                        self.plugins[d] = yaml.safe_load(f)
                except Exception as e:
                    log.warning(f"Plugin manifest okunamadı: {d}: {e}")
    
    def install(self, repo_url):
        """Plugin'i git clone ile indir ve install hook'unu çalıştır."""
        # Repo adından plugin dizin adını çıkar
        repo_name = repo_url.rstrip('/').split('/')[-1].replace('.git', '')
        dest = os.path.join(self.PLUGINS_DIR, repo_name)
        
        if os.path.exists(dest):
            return {"ok": False, "error": f"Plugin zaten kurulu: {repo_name}"}
        
        try:
            # Git clone
            r = subprocess.run(
                ['git', 'clone', '--depth', '1', repo_url, dest],
                capture_output=True, text=True, timeout=120
            )
            if r.returncode != 0:
                return {"ok": False, "error": f"Git clone başarısız: {r.stderr}"}
            
            # Manifest kontrolü
            manifest_path = os.path.join(dest, 'tinc-plugin.yaml')
            if not os.path.exists(manifest_path):
                shutil.rmtree(dest)
                return {"ok": False, "error": "tinc-plugin.yaml bulunamadı. Bu geçerli bir Tinc Hub plugini değil."}
            
            # Manifest oku
            with open(manifest_path) as f:
                manifest = yaml.safe_load(f)
            
            # Install hook çalıştır
            install_script = manifest.get('hooks', {}).get('install')
            if install_script:
                script_path = os.path.join(dest, install_script)
                if os.path.exists(script_path):
                    subprocess.run(['bash', script_path], cwd=dest, timeout=120)
            
            # Python bağımlılıklarını kur
            requires = manifest.get('requires', {})
            python_deps = requires.get('python', [])
            if python_deps:
                subprocess.run(['pip', 'install'] + python_deps, timeout=120)
            
            # Sistem paketleri
            system_deps = requires.get('packages', [])
            if system_deps:
                subprocess.run(['sudo', 'apt', 'install', '-y'] + system_deps, timeout=120)
            
            # Yeniden yükle
            self.load_all()
            
            return {"ok": True, "plugin": repo_name, "manifest": manifest}
            
        except Exception as e:
            # Hata durumunda temizle
            if os.path.exists(dest):
                shutil.rmtree(dest, ignore_errors=True)
            return {"ok": False, "error": str(e)}
    
    def uninstall(self, plugin_id):
        """Plugin'i kaldır."""
        dest = os.path.join(self.PLUGINS_DIR, plugin_id)
        if not os.path.exists(dest):
            return {"ok": False, "error": "Plugin bulunamadı"}
        
        # Uninstall hook
        manifest = self.plugins.get(plugin_id, {})
        uninstall_script = manifest.get('hooks', {}).get('uninstall')
        if uninstall_script:
            script_path = os.path.join(dest, uninstall_script)
            if os.path.exists(script_path):
                try:
                    subprocess.run(['bash', script_path], cwd=dest, timeout=60)
                except Exception:
                    pass
        
        # Agent servisini durdur
        agent = manifest.get('components', {}).get('agent', {})
        svc = agent.get('service_name')
        if svc:
            subprocess.run(['sudo', 'systemctl', 'stop', svc], capture_output=True)
            subprocess.run(['sudo', 'systemctl', 'disable', svc], capture_output=True)
        
        # Dosyaları sil
        shutil.rmtree(dest, ignore_errors=True)
        self.load_all()
        
        return {"ok": True}
    
    def get_widget_html(self, plugin_id):
        manifest = self.plugins.get(plugin_id)
        if not manifest:
            return ""
        widget = manifest.get('components', {}).get('widget', {})
        template = widget.get('template')
        if template:
            template_path = os.path.join(self.PLUGINS_DIR, plugin_id, template)
            if os.path.exists(template_path):
                with open(template_path) as f:
                    return f.read()
        return ""
    
    def get_all_widgets(self):
        """Tüm plugin widget'larını topla."""
        widgets = []
        for pid, manifest in self.plugins.items():
            widget = manifest.get('components', {}).get('widget')
            if widget:
                html = self.get_widget_html(pid)
                if html:
                    widgets.append({
                        'id': pid,
                        'html': html,
                        'position': widget.get('position', 'sidebar')
                    })
        return widgets

plugin_manager = PluginManager()
