import subprocess
import os
import json
import uuid
from registry import load_apps, save_apps

def install_app_from_store(store_app_id: str) -> dict:
    import subprocess
    import os
    import json
    from registry import load_apps, save_apps
    
    logs = []
    store_file = os.path.join(os.path.dirname(__file__), "store.json")
    try:
        with open(store_file, "r") as f:
            store_data = json.load(f)
    except Exception:
        return {"ok": False, "error": "store.json okunamadı."}
        
    app_meta = next((a for a in store_data if a["id"] == store_app_id), None)
    if not app_meta:
        return {"ok": False, "error": "Uygulama mağazada bulunamadı."}
        
    repo_url = app_meta.get("repo")
    if not repo_url:
        return {"ok": False, "error": "Uygulamanın repo adresi yok."}
        
    app_name_slug = repo_url.rstrip('/').split('/')[-1]
    target_dir = f"/home/turan/101/{app_name_slug}"
    
    if os.path.exists(target_dir):
        r = subprocess.run(["git", "-C", target_dir, "pull"], capture_output=True, text=True)
        logs.append(str(r.stdout) + "\n" + str(r.stderr))
        if r.returncode != 0:
            return {"ok": False, "error": f"Git pull hatası:\n{r.stderr}"}
    else:
        r = subprocess.run(["git", "clone", repo_url, target_dir], capture_output=True, text=True)
        logs.append(str(r.stdout) + "\n" + str(r.stderr))
        if r.returncode != 0:
            return {"ok": False, "error": f"Git clone hatası:\n{r.stderr}"}
            
    install_script = os.path.join(target_dir, "install.sh")
    if os.path.exists(install_script):
        r = subprocess.run(["sudo", "bash", install_script], capture_output=True, text=True)
        logs.append(str(r.stdout) + "\n" + str(r.stderr))
        if r.returncode != 0:
            return {"ok": False, "error": f"Kurulum hatası:\n{r.stderr}", "log": "\n".join(logs)}
            
    apps = load_apps()
    existing = next((a for a in apps if a.get("repo") == repo_url or a.get("id") == app_meta["id"]), None)
    
    if not existing:
        new_app = {
            "id": app_meta["id"],
            "name": app_meta["name"],
            "description": app_meta.get("description", ""),
            "category": app_meta.get("category", "Diğer"),
            "icon": app_meta.get("icon", "📦"),
            "repo": repo_url,
            "pinned": True
        }
        for field in ["service", "url", "internal_url", "is_user_service", "health_check"]:
            if field in app_meta:
                new_app[field] = app_meta[field]
        if "health_check" not in app_meta:
            new_app["health_check"] = "systemd" if "service" in app_meta else "none"
        apps.append(new_app)
        save_apps(apps)
        
    return {"ok": True, "message": "Başarıyla kuruldu", "log": "\n".join(logs)}

def update_app_local(app_id: str, new_repo: str = None) -> dict:
    import subprocess
    import os
    from registry import load_apps, save_apps
    
    logs = []
    apps = load_apps()
    app_data = next((a for a in apps if a.get("id") == app_id), None)
    
    if not app_data:
        return {"ok": False, "error": "Uygulama bulunamadı."}
        
    if new_repo:
        app_data["repo"] = new_repo
        save_apps(apps)
        
    repo_url = app_data.get("repo")
    if not repo_url:
        return {"ok": False, "error": "Repo adresi yok."}
        
    app_name_slug = repo_url.rstrip('/').split('/')[-1]
    target_dir = f"/home/turan/101/{app_name_slug}"
    
    if not os.path.exists(target_dir):
        r = subprocess.run(["git", "clone", repo_url, target_dir], capture_output=True, text=True)
        logs.append(str(r.stdout) + "\n" + str(r.stderr))
        if r.returncode != 0:
            return {"ok": False, "error": f"Git clone hatası:\n{r.stderr}"}
    else:
        r = subprocess.run(["git", "-C", target_dir, "pull"], capture_output=True, text=True)
        logs.append(str(r.stdout) + "\n" + str(r.stderr))
        if r.returncode != 0:
            return {"ok": False, "error": f"Git pull hatası:\n{r.stderr}"}
        
    install_script = os.path.join(target_dir, "install.sh")
    if os.path.exists(install_script):
        r = subprocess.run(["sudo", "bash", install_script], capture_output=True, text=True)
        logs.append(str(r.stdout) + "\n" + str(r.stderr))
        if r.returncode != 0:
            return {"ok": False, "error": f"Kurulum scripti hatası:\n{r.stderr}", "log": "\n".join(logs)}
            
    return {"ok": True, "message": "Başarıyla güncellendi.", "log": "\n".join(logs)}


def get_git_info() -> dict:
    """Yerel git commit sayısı ve kısa commit hash'ini döner."""
    cur_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    git_dirs = [
        cur_dir,
        "/home/turan/101",
        "/home/turan/101/tinc-hub",
        "/home/turan/tinc-hub",
        "/home/turan/101/tinc-hub/tinc-hub",
        "/home/turan/tinc-hub/tinc-hub"
    ]
    for gd in git_dirs:
        try:
            if os.path.exists(os.path.join(gd, ".git")):
                r_count = subprocess.run(["git", "-C", gd, "rev-list", "--count", "HEAD"], capture_output=True, text=True, timeout=3)
                r_hash = subprocess.run(["git", "-C", gd, "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=3)
                if r_count.returncode == 0 and r_hash.returncode == 0:
                    cnt = r_count.stdout.strip()
                    hsh = r_hash.stdout.strip()
                    return {
                        "count": int(cnt) if cnt.isdigit() else 0,
                        "hash": hsh,
                        "version": f"v1.{cnt}.{hsh}",
                        "dir": gd
                    }
        except Exception:
            pass

    # version.json kontrol et (/opt/tinc-hub/dashboard/version.json)
    vfile = os.path.join(os.path.dirname(os.path.abspath(__file__)), "version.json")
    if os.path.exists(vfile):
        try:
            with open(vfile, "r", encoding="utf-8") as f:
                vdata = json.load(f)
                return {
                    "count": vdata.get("count", 1),
                    "hash": vdata.get("hash", "release"),
                    "version": vdata.get("version", "v1.0.0"),
                    "dir": vdata.get("repo_dir")
                }
        except Exception:
            pass

    return {"count": 1, "hash": "release", "version": "v1.0.0", "dir": None}


def check_system_update() -> dict:
    """GitHub üzerinden yeni commit olup olmadığını denetler."""
    import urllib.request
    local_info = get_git_info()
    try:
        url = "https://api.github.com/repos/mcturan/tinc-hub/commits?per_page=1"
        req = urllib.request.Request(url, headers={"User-Agent": "TincHub-AutoUpdater"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data and isinstance(data, list):
                remote_sha = data[0]["sha"]
                remote_short = remote_sha[:7]
                has_update = (remote_short != local_info["hash"] and not remote_sha.startswith(local_info["hash"]))
                return {
                    "ok": True,
                    "has_update": has_update,
                    "local_version": local_info["version"],
                    "local_commit": local_info["hash"],
                    "remote_commit": remote_short,
                    "remote_version": f"v1.x.{remote_short}" if has_update else local_info["version"]
                }
    except Exception as e:
        return {
            "ok": False,
            "has_update": False,
            "error": str(e),
            "local_version": local_info["version"],
            "local_commit": local_info["hash"]
        }
    return {"ok": True, "has_update": False, "local_version": local_info["version"], "local_commit": local_info["hash"]}


def perform_self_update() -> dict:
    """Tinc Hub'ı git pull yaparak ve install.sh çalıştırarak günceller."""
    logs = []
    local_info = get_git_info()
    repo_dir = local_info.get("dir")
    
    if not repo_dir or not os.path.exists(repo_dir):
        for d in ["/home/turan/tinc-hub", "/home/turan/101", "/home/turan/101/tinc-hub"]:
            if os.path.exists(d) and os.path.exists(os.path.join(d, ".git")):
                repo_dir = d
                break
                
    if not repo_dir:
        return {"ok": False, "error": "Tinc Hub kaynak git dizini bulunamadı."}
        
    # safe.directory ayarla (root veya başka kullanıcı ile çalıştırılınca hata vermemesi için)
    subprocess.run(["git", "config", "--global", "--add", "safe.directory", repo_dir], capture_output=True)
    subprocess.run(["git", "config", "--global", "--add", "safe.directory", "*"], capture_output=True)
        
    # Git pull
    r_pull = subprocess.run(["git", "-C", repo_dir, "pull", "origin", "main"], capture_output=True, text=True)
    logs.append(r_pull.stdout + "\n" + r_pull.stderr)
    if r_pull.returncode != 0:
        return {"ok": False, "error": "Git pull başarısız oldu:\n" + r_pull.stderr, "log": "\n".join(logs)}
        
    # install.sh bul
    install_script = os.path.join(repo_dir, "install.sh")
    if not os.path.exists(install_script):
        install_script = os.path.join(repo_dir, "tinc-hub", "install.sh")
    if not os.path.exists(install_script):
        install_script = os.path.join(repo_dir, "dashboard", "install.sh")
        
    if os.path.exists(install_script):
        r_inst = subprocess.run(["bash", install_script], capture_output=True, text=True)
        logs.append(r_inst.stdout + "\n" + r_inst.stderr)
        if r_inst.returncode != 0:
            return {"ok": False, "error": "Kurulum betiği hata verdi:\n" + r_inst.stderr, "log": "\n".join(logs)}
            
    # Servisi yeniden başlatmak için arka planda tetikle
    subprocess.Popen(["systemctl", "restart", "tinc-hub"])
    
    return {"ok": True, "message": "Tinc Hub başarıyla güncellendi ve yeniden başlatılıyor.", "log": "\n".join(logs)}
