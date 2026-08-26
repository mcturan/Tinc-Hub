import subprocess
import os
import json
import uuid
from registry import load_apps, save_apps

def install_app_from_store(store_app_id: str) -> dict:
    """Mağazadan uygulama kurar."""
    # store.json'dan bul
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
    
    # 1. Repoyu klonla veya güncelle
    if os.path.exists(target_dir):
        # Klasör varsa pull yap
        r = subprocess.run(["git", "-C", target_dir, "pull"], capture_output=True, text=True)
        if r.returncode != 0:
            return {"ok": False, "error": f"Git pull hatası: {r.stderr}"}
    else:
        # Yoksa klonla
        r = subprocess.run(["git", "clone", repo_url, target_dir], capture_output=True, text=True)
        if r.returncode != 0:
            return {"ok": False, "error": f"Git clone hatası: {r.stderr}"}
            
    # 2. install.sh çalıştır
    install_script = os.path.join(target_dir, "install.sh")
    if os.path.exists(install_script):
        # script çalıştır
        r = subprocess.run(["sudo", "bash", install_script], capture_output=True, text=True)
        if r.returncode != 0:
            return {"ok": False, "error": f"Kurulum scripti hatası: {r.stderr}"}
            
    # 3. apps.yaml'a ekle (Zaten yoksa)
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
        # Ekstra alanları da kopyala
        if "service" in app_meta:
            new_app["service"] = app_meta["service"]
        if "url" in app_meta:
            new_app["url"] = app_meta["url"]
        if "internal_url" in app_meta:
            new_app["internal_url"] = app_meta["internal_url"]
        if "is_user_service" in app_meta:
            new_app["is_user_service"] = app_meta["is_user_service"]
        if "health_check" in app_meta:
            new_app["health_check"] = app_meta["health_check"]
        else:
            new_app["health_check"] = "systemd" if "service" in app_meta else "none"
        apps.append(new_app)
        save_apps(apps)
        
    return {"ok": True, "message": "Başarıyla kuruldu ve panoya eklendi."}

def update_app_local(app_id: str) -> dict:
    """Yüklü bir uygulamayı günceller."""
    apps = load_apps()
    app_data = next((a for a in apps if a.get("id") == app_id), None)
    
    if not app_data or not app_data.get("repo"):
        return {"ok": False, "error": "Uygulama bulunamadı veya repo adresi yok."}
        
    repo_url = app_data["repo"]
    app_name_slug = repo_url.rstrip('/').split('/')[-1]
    target_dir = f"/home/turan/101/{app_name_slug}"
    
    if not os.path.exists(target_dir):
        return {"ok": False, "error": f"{target_dir} dizini bulunamadı. Lütfen mağazadan tekrar kurun."}
        
    r = subprocess.run(["git", "-C", target_dir, "pull"], capture_output=True, text=True)
    if r.returncode != 0:
        return {"ok": False, "error": f"Güncelleme (pull) hatası: {r.stderr}"}
        
    install_script = os.path.join(target_dir, "install.sh")
    if os.path.exists(install_script):
        r = subprocess.run(["sudo", "bash", install_script], capture_output=True, text=True)
        if r.returncode != 0:
            return {"ok": False, "error": f"Kurulum scripti hatası: {r.stderr}"}
            
    return {"ok": True, "message": "Başarıyla güncellendi."}
