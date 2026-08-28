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
