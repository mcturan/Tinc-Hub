import os
import io
import json
import zipfile
import subprocess
import tempfile
import base64
import re
import uuid
from datetime import datetime
from functools import wraps
from flask import Blueprint, render_template, request, jsonify, redirect, session, send_from_directory, send_file, url_for
from werkzeug.utils import secure_filename

from . import db
from .config import UPLOADS_DIR
from .scraper import extract_first_url, scrape_url_metadata
from .telegram_bot import (
    is_bot_running, start_telegram_bot, stop_telegram_bot,
    send_telegram_message, send_notification_to_all_chats
)

tnote_bp = Blueprint(
    'tnote',
    __name__,
    template_folder='templates',
    static_folder='static',
    static_url_path='/static'
)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')

@tnote_bp.route('/sw.js')
def service_worker():
    return send_file(os.path.join(STATIC_DIR, 'sw.js'), mimetype='application/javascript')

@tnote_bp.route('/manifest.json')
def manifest_json():
    return send_file(os.path.join(STATIC_DIR, 'manifest.json'), mimetype='application/json')

def auth_check(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        # SSO Token query param
        sso_token = request.args.get("sso_token")
        if sso_token:
            u = db.get_user_by_token(sso_token)
            if u:
                session["user_id"] = u["id"]
                session["user_token"] = sso_token
                session["username"] = u["username"]
                session["authenticated"] = True
            else:
                tinc_pw = os.environ.get("TINC_HUB_PASSWORD", "").strip()
                if tinc_pw and sso_token == tinc_pw:
                    session["authenticated"] = True
                    session["user_id"] = 1
                    session["username"] = "admin"

        # Tinc-Hub şifre koruması kontrolü
        tinc_pw = os.environ.get("TINC_HUB_PASSWORD", "").strip()
        if tinc_pw and not session.get("authenticated"):
            auth_header = request.headers.get("Authorization", "")
            api_key = request.headers.get("X-API-Key", "")
            if (auth_header and auth_header.replace("Bearer ", "").strip() == tinc_pw) or (api_key and api_key == tinc_pw):
                return f(*args, **kwargs)
            if request.path.startswith("/notes/api/"):
                return jsonify({"error": "Yetkisiz erişim"}), 401
            return redirect(f"/login?next={request.path}")
        return f(*args, **kwargs)
    return decorated

def get_current_user():
    """
    Mevcut kullanıcıyı belirler (Bearer token, X-Auth-Token, session, sso_token).
    """
    token = request.args.get("sso_token")
    if not token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
    if not token:
        token = request.headers.get("X-Auth-Token", "").strip()
    if not token:
        token = session.get("user_token")

    if token:
        user = db.get_user_by_token(token)
        if user:
            return user

    if session.get("user_id"):
        user = db.get_user_by_id(session.get("user_id"))
        if user:
            return user

    return None

def get_current_user_id():
    u = get_current_user()
    return u["id"] if u else None

@tnote_bp.before_request
def handle_options_preflight():
    if request.method == "OPTIONS":
        res = jsonify({"ok": True})
        res.headers["Access-Control-Allow-Origin"] = "*"
        res.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS, PATCH"
        res.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Requested-With, X-API-Key, X-Auth-Token, Origin, Accept, Range"
        return res, 200

@tnote_bp.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS, PATCH"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Requested-With, X-API-Key, X-Auth-Token, Origin, Accept, Range"
    return response

@tnote_bp.route('/api/ping', methods=['GET'])
def api_ping():
    return jsonify({
        "ok": True,
        "app": "TincNote",
        "status": "online",
        "timestamp": datetime.now().isoformat()
    })


# ─────────────────────────────────────────────────────────────────────────────
# Web Sayfaları
# ─────────────────────────────────────────────────────────────────────────────
# REST API: Kimlik Doğrulama / Kullanıcı Yönetimi (Auth)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/auth/register', methods=['POST'])
def api_register():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    display_name = data.get("display_name", "").strip()
    email = data.get("email", "").strip()
    if not username or not password:
        return jsonify({"ok": False, "error": "Kullanıcı adı ve şifre zorunludur"}), 400
    res = db.register_user(username, password, display_name=display_name, email=email)
    if not res.get("ok"):
        return jsonify(res), 400
    session["user_id"] = res["user"]["id"]
    session["user_token"] = res["token"]
    session["username"] = res["user"]["username"]
    return jsonify(res)

@tnote_bp.route('/api/auth/login', methods=['POST'])
def api_login():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    if not username or not password:
        return jsonify({"ok": False, "error": "Kullanıcı adı ve şifre zorunludur"}), 400
    res = db.login_user(username, password)
    if not res.get("ok"):
        return jsonify(res), 401
    session["user_id"] = res["user"]["id"]
    session["user_token"] = res["token"]
    session["username"] = res["user"]["username"]
    return jsonify(res)

@tnote_bp.route('/api/auth/me', methods=['GET'])
def api_me():
    user = get_current_user()
    if user:
        return jsonify({"ok": True, "authenticated": True, "user": user})
    return jsonify({"ok": True, "authenticated": False, "user": None})

@tnote_bp.route('/api/auth/logout', methods=['POST'])
def api_logout():
    session.pop("user_id", None)
    session.pop("user_token", None)
    session.pop("username", None)
    return jsonify({"ok": True})

@tnote_bp.route('/api/users', methods=['GET'])
@auth_check
def api_get_users():
    user = get_current_user()
    if user and user.get("role") != "admin":
        return jsonify({"ok": False, "error": "Yalnızca yöneticiler kullanıcıları listeleyebilir"}), 403
    return jsonify({"ok": True, "users": db.get_all_users()})

# ─────────────────────────────────────────────────────────────────────────────
# TincID — Tekil Kimlik & Ekosistem Entegrasyonu (SSO & Ecosystem)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/auth/tincid/profile', methods=['GET'])
def api_tincid_profile():
    user = get_current_user()
    if not user:
        return jsonify({"ok": False, "error": "Oturum açık değil"}), 401
    return jsonify({
        "ok": True,
        "tinc_id": user.get("tinc_id", ""),
        "user": {
            "id": user.get("id"),
            "tinc_id": user.get("tinc_id", ""),
            "username": user.get("username", ""),
            "display_name": user.get("display_name", ""),
            "email": user.get("email", ""),
            "role": user.get("role", "user")
        }
    })

@tnote_bp.route('/api/auth/tincid/verify', methods=['POST'])
def api_tincid_verify():
    data = request.get_json() or {}
    token = data.get("token") or request.headers.get("Authorization", "").replace("Bearer ", "").strip()
    if not token:
        return jsonify({"ok": False, "error": "Token sağlanmadı"}), 400
    user = db.get_user_by_token(token)
    if not user:
        return jsonify({"ok": False, "error": "Geçersiz veya süresi dolmuş token"}), 401
    return jsonify({
        "ok": True,
        "valid": True,
        "tinc_id": user.get("tinc_id", ""),
        "user": {
            "id": user.get("id"),
            "tinc_id": user.get("tinc_id", ""),
            "username": user.get("username", ""),
            "display_name": user.get("display_name", ""),
            "email": user.get("email", ""),
            "role": user.get("role", "user")
        }
    })

@tnote_bp.route('/api/auth/tincid/ecosystem', methods=['GET'])
def api_tincid_ecosystem():
    import socket
    def is_port_open(port):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.3)
        try:
            res = s.connect_ex(('127.0.0.1', port))
            s.close()
            return res == 0
        except Exception:
            return False

    sync_online = is_port_open(9015)
    dash_online = is_port_open(9010)

    return jsonify({
        "ok": True,
        "ecosystem": {
            "apps": [
                {
                    "name": "TincNote",
                    "port": 9013,
                    "status": "online",
                    "url": "http://127.0.0.1:9013",
                    "desc": "Notlar, Hızlı Görevler & Finans Merkezi"
                },
                {
                    "name": "TincSync",
                    "port": 9015,
                    "status": "online" if sync_online else "offline",
                    "url": "http://127.0.0.1:9015",
                    "desc": "P2P Bulut Senkronizasyonu & Git Depoları"
                },
                {
                    "name": "TincHub Dashboard",
                    "port": 9010,
                    "status": "online" if dash_online else "offline",
                    "url": "http://127.0.0.1:9010",
                    "desc": "Merkezi Sunucu ve Servis Yönetim Paneli"
                }
            ]
        }
    })

def _parse_jwt_claims(token: str) -> dict:
    """JWT base64url payload kısmını güvenli bir şekilde JSON sözlüğüne dönüştürür."""
    if not token or '.' not in token:
        return {}
    try:
        parts = token.split('.')
        if len(parts) >= 2:
            payload_b64 = parts[1]
            payload_b64 += '=' * (-len(payload_b64) % 4)
            data = json.loads(base64.urlsafe_b64decode(payload_b64.encode('utf-8')).decode('utf-8'))
            return data
    except Exception:
        pass
    return {}

@tnote_bp.route('/api/auth/oauth/google', methods=['POST'])
def api_oauth_google():
    data = request.get_json() or {}
    credential = data.get("credential") or data.get("id_token") or ""
    email = data.get("email") or ""
    display_name = data.get("name") or data.get("display_name") or ""
    provider_id = data.get("sub") or data.get("id") or ""
    avatar_url = data.get("picture") or data.get("avatar_url") or ""

    if credential:
        claims = _parse_jwt_claims(credential)
        if claims:
            email = claims.get("email", email)
            display_name = claims.get("name", display_name)
            provider_id = claims.get("sub", provider_id)
            avatar_url = claims.get("picture", avatar_url)

    if not provider_id and not email:
        return jsonify({"ok": False, "error": "Google kimlik bilgisi doğrulanamadı"}), 400

    res = db.authenticate_or_create_oauth_user(
        provider="google",
        provider_id=str(provider_id or email),
        email=email,
        display_name=display_name,
        avatar_url=avatar_url
    )
    if not res.get("ok"):
        return jsonify(res), 400

    session["user_id"] = res["user"]["id"]
    session["user_token"] = res["token"]
    session["username"] = res["user"]["username"]

    ua = request.headers.get("User-Agent", "Web")
    ip = request.remote_addr or "127.0.0.1"
    sess_id = db.create_user_session(res["user"]["id"], res["token"], device_info=ua[:120], ip_address=ip)
    res["session_id"] = sess_id

    return jsonify(res)

@tnote_bp.route('/api/auth/oauth/apple', methods=['POST'])
def api_oauth_apple():
    data = request.get_json() or {}
    identity_token = data.get("identityToken") or data.get("token") or ""
    provider_id = data.get("user") or data.get("sub") or ""
    email = data.get("email") or ""
    display_name = data.get("name") or ""

    if identity_token:
        claims = _parse_jwt_claims(identity_token)
        if claims:
            email = claims.get("email", email)
            provider_id = claims.get("sub", provider_id)

    if not provider_id and not email:
        return jsonify({"ok": False, "error": "Apple kimlik bilgisi doğrulanamadı"}), 400

    res = db.authenticate_or_create_oauth_user(
        provider="apple",
        provider_id=str(provider_id or email),
        email=email,
        display_name=display_name or (email.split('@')[0] if email else "Apple Kullanıcısı")
    )
    if not res.get("ok"):
        return jsonify(res), 400

    session["user_id"] = res["user"]["id"]
    session["user_token"] = res["token"]
    session["username"] = res["user"]["username"]

    ua = request.headers.get("User-Agent", "iOS/Apple")
    ip = request.remote_addr or "127.0.0.1"
    sess_id = db.create_user_session(res["user"]["id"], res["token"], device_info=ua[:120], ip_address=ip)
    res["session_id"] = sess_id

    return jsonify(res)

@tnote_bp.route('/api/auth/verify-email', methods=['POST'])
def api_verify_email():
    data = request.get_json() or {}
    code = str(data.get("code", "")).strip()
    email_or_user = data.get("email") or session.get("user_id")
    if not code or not email_or_user:
        return jsonify({"ok": False, "error": "Doğrulama kodu ve kullanıcı bilgisi zorunludur"}), 400
    res = db.verify_email_code(email_or_user, code)
    if not res.get("ok"):
        return jsonify(res), 400
    return jsonify(res)

@tnote_bp.route('/api/auth/resend-code', methods=['POST'])
def api_resend_code():
    data = request.get_json() or {}
    email_or_user = data.get("email") or session.get("user_id")
    if not email_or_user:
        return jsonify({"ok": False, "error": "E-posta adresi gereklidir"}), 400
    res = db.resend_verification_code(email_or_user)
    return jsonify(res)

@tnote_bp.route('/api/auth/profile/deactivate', methods=['POST'])
@auth_check
def api_profile_deactivate():
    user = get_current_user()
    if not user:
        return jsonify({"ok": False, "error": "Oturum açık değil"}), 401
    res = db.deactivate_user(user["id"])
    session.clear()
    return jsonify(res)

@tnote_bp.route('/api/auth/profile/delete', methods=['POST'])
@auth_check
def api_profile_delete():
    user = get_current_user()
    if not user:
        return jsonify({"ok": False, "error": "Oturum açık değil"}), 401
    res = db.delete_user_permanently(user["id"])
    session.clear()
    return jsonify(res)

@tnote_bp.route('/api/auth/profile/export', methods=['GET'])
@auth_check
def api_profile_takeout():
    user = get_current_user()
    if not user:
        return jsonify({"ok": False, "error": "Oturum açık değil"}), 401
    try:
        data = db.get_full_export_data()
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            json_str = json.dumps({
                "tinc_id": user.get("tinc_id"),
                "username": user.get("username"),
                "display_name": user.get("display_name"),
                "email": user.get("email"),
                "export_date": datetime.now().isoformat(),
                "data": data
            }, ensure_ascii=False, indent=2)
            zf.writestr("tinc_profile_takeout.json", json_str.encode("utf-8"))

            cat_map = {c["id"]: c["name"] for c in data.get("categories", [])}
            items_by_page = {}
            for item in data.get("items", []):
                items_by_page.setdefault(item["page_id"], []).append(item)

            for page in data.get("pages", []):
                cat_name = cat_map.get(page.get("category_id"), "Genel")
                safe_cat = "".join(c for c in cat_name if c.isalnum() or c in " _-ğüşıöçĞÜŞİÖÇ").strip() or "Genel"
                safe_title = "".join(c for c in page.get("title", "Sayfa") if c.isalnum() or c in " _-ğüşıöçĞÜŞİÖÇ").strip() or f"Sayfa_{page.get('id')}"
                md_lines = [f"# {page.get('title', 'Başlıksız')}", ""]
                md_lines.append(f"> Tür: {page.get('type', 'notes')} | Oluşturulma: {page.get('created_at', '')}")
                md_lines.append("")
                if page.get("content"):
                    md_lines.append(page["content"])
                    md_lines.append("")
                for it in items_by_page.get(page["id"], []):
                    checked = "[x]" if it.get("is_checked") else "[ ]"
                    md_lines.append(f"- {checked} {it.get('title', '')}")
                    if it.get("notes"):
                        md_lines.append(f"  > {it['notes']}")
                zf.writestr(f"markdown/{safe_cat}/{safe_title}.md", "\n".join(md_lines).encode("utf-8"))

        zip_buffer.seek(0)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"tinc_takeout_{user.get('username')}_{timestamp}.zip"
        return send_file(zip_buffer, mimetype="application/zip", as_attachment=True, download_name=filename)
    except Exception as e:
        return jsonify({"ok": False, "error": f"Veri dışa aktarılamadı: {str(e)}"}), 500

@tnote_bp.route('/api/auth/sessions', methods=['GET'])
@auth_check
def api_get_sessions():
    user = get_current_user()
    if not user:
        return jsonify({"ok": False, "error": "Oturum açık değil"}), 401
    sessions = db.get_user_sessions(user["id"])
    return jsonify({"ok": True, "sessions": sessions})

@tnote_bp.route('/api/auth/sessions/revoke', methods=['POST'])
@auth_check
def api_revoke_session():
    user = get_current_user()
    if not user:
        return jsonify({"ok": False, "error": "Oturum açık değil"}), 401
    data = request.get_json() or {}
    session_id = data.get("session_id")
    revoke_all_other = data.get("all_other", False)
    current_token = session.get("user_token") or request.headers.get("Authorization", "").replace("Bearer ", "").strip()
    if revoke_all_other:
        db.revoke_all_other_sessions(user["id"], current_token)
    elif session_id:
        db.revoke_session(session_id, user["id"])
    return jsonify({"ok": True})


# ─────────────────────────────────────────────────────────────────────────────
# Akıllı Araçlar: OCR (Fotoğraftan Metin) & AI Eyleme Dönüştür (Actionize)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/tools/ocr', methods=['POST'])
def api_tools_ocr():
    img_bytes = None
    if 'image' in request.files:
        img_file = request.files['image']
        img_bytes = img_file.read()
    else:
        data = request.get_json(silent=True) or {}
        b64_str = data.get("base64_image") or data.get("image") or ""
        if b64_str:
            if "," in b64_str:
                b64_str = b64_str.split(",", 1)[1]
            try:
                img_bytes = base64.b64decode(b64_str)
            except Exception as e:
                return jsonify({"ok": False, "error": f"Base64 çözülemedi: {e}"}), 400

    if not img_bytes:
        return jsonify({"ok": False, "error": "İşlenecek görsel verisi bulunamadı"}), 400

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp.write(img_bytes)
            tmp_path = tmp.name

        cmd = ['/usr/bin/tesseract', tmp_path, 'stdout', '-l', 'tur+eng', '--oem', '1', '--psm', '3']
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
        extracted = res.stdout.strip()
        if not extracted and res.returncode != 0:
            return jsonify({"ok": False, "error": f"OCR Hatası: {res.stderr.strip()}"}), 500

        return jsonify({
            "ok": True,
            "text": extracted,
            "char_count": len(extracted)
        })
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "OCR işlemi zaman aşımına uğradı"}), 504
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass

@tnote_bp.route('/api/ai/actionize', methods=['POST'])
def api_ai_actionize():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"ok": False, "error": "Ayrıştırılacak metin boş"}), 400

    lines = [line.strip() for line in text.split("\n") if line.strip()]
    tasks = []
    
    # 1. Regex ve semantik görev ayıklama
    action_keywords = [
        "yapılacak", "lazım", "gerek", "al", "sat", "öde", "fatura", "ara", 
        "gönder", "mail", "hazırla", "kur", "incele", "düzelt", "kontrol", 
        "bitir", "yaz", "oku", "toplantı", "görüş", "teslim", "tamamla"
    ]

    for line in lines:
        # Madde işaretlerini temizle
        clean = re.sub(r'^(?:[-*•+]|\d+[.)]|\[[\sxX]?\])\s*', '', line).strip()
        if not clean or len(clean) < 3:
            continue
            
        is_action = False
        lower_line = clean.lower()

        # Orijinal satır madde imiyle veya onay kutusuyla başlıyorsa
        if re.match(r'^(?:[-*•+]|\d+[.)]|\[[\sxX]?\])', line):
            is_action = True
        else:
            # Eylem anahtar kelimelerinden biri geçiyor mu?
            for kw in action_keywords:
                if kw in lower_line:
                    is_action = True
                    break

        if is_action:
            tasks.append({
                "title": clean,
                "is_completed": False
            })

    # Eğer kural tabanlı görev bulunamadıysa her anlamlı satırı bir görev yap
    if not tasks:
        for line in lines:
            clean = re.sub(r'^(?:[-*•+]|\d+[.)]|\[[\sxX]?\])\s*', '', line).strip()
            if len(clean) >= 3:
                tasks.append({"title": clean, "is_completed": False})

    return jsonify({
        "ok": True,
        "tasks": tasks,
        "count": len(tasks)
    })

# ─────────────────────────────────────────────────────────────────────────────
# Bilgi Ağı: Çift Yönlü Bağlantılar (Backlinks `[[Sayfa Adı]]`)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/pages/<int:page_id>/backlinks', methods=['GET'])
def api_page_backlinks(page_id):
    page = db.get_page(page_id)
    if not page:
        return jsonify({"ok": False, "error": "Sayfa bulunamadı"}), 404

    page_title = page.get("title", "").strip()
    backlinks = db.get_page_backlinks(page_title, current_page_id=page_id)
    return jsonify({
        "ok": True,
        "page_id": page_id,
        "page_title": page_title,
        "backlinks": backlinks,
        "count": len(backlinks)
    })

# ─────────────────────────────────────────────────────────────────────────────
# Web Sayfaları
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/')
@auth_check
def index():
    user = get_current_user()
    user_id = user["id"] if user else None
    notebooks = db.get_notebooks(user_id=user_id)
    
    active_nb_id = request.args.get('notebook_id', type=int) or session.get('active_notebook_id') or db.get_active_notebook_id()
    if active_nb_id and any(n['id'] == active_nb_id for n in notebooks):
        session['active_notebook_id'] = active_nb_id
        db.set_active_notebook_id(active_nb_id)
    elif notebooks:
        active_nb_id = notebooks[0]['id']
        session['active_notebook_id'] = active_nb_id
        db.set_active_notebook_id(active_nb_id)
    else:
        active_nb_id = 1
        db.set_active_notebook_id(1)

    current_notebook = db.get_notebook(active_nb_id) or (notebooks[0] if notebooks else None)
    categories = db.get_categories(active_nb_id)
    pages = db.get_pages(notebook_id=active_nb_id)
    settings = db.get_all_settings()
    bot_status = is_bot_running()
    return render_template(
        'tnote/index.html',
        notebooks=notebooks,
        current_notebook=current_notebook,
        categories=categories,
        pages=pages,
        settings=settings,
        bot_status=bot_status,
        user=user,
        standalone=session.get("is_standalone", False)
    )

@tnote_bp.route('/settings')
@auth_check
def settings_page():
    user = get_current_user()
    user_id = user["id"] if user else None
    notebooks = db.get_notebooks(user_id=user_id)
    active_nb_id = request.args.get('notebook_id', type=int) or session.get('active_notebook_id') or db.get_active_notebook_id() or (notebooks[0]['id'] if notebooks else 1)
    session['active_notebook_id'] = active_nb_id
    db.set_active_notebook_id(active_nb_id)
    current_notebook = db.get_notebook(active_nb_id) or (notebooks[0] if notebooks else None)
    categories = db.get_categories(active_nb_id)
    pages = db.get_pages(notebook_id=active_nb_id)
    settings = db.get_all_settings()
    bot_status = is_bot_running()
    telegram_users = db.get_telegram_users()
    return render_template(
        'tnote/settings.html',
        notebooks=notebooks,
        current_notebook=current_notebook,
        categories=categories,
        pages=pages,
        settings=settings,
        bot_status=bot_status,
        telegram_users=telegram_users,
        user=user,
        standalone=session.get("is_standalone", False)
    )

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Not Defterleri (Notebooks)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/notebooks', methods=['GET'])
@auth_check
def api_get_notebooks():
    user_id = get_current_user_id()
    return jsonify({
        "ok": True,
        "notebooks": db.get_notebooks(user_id=user_id),
        "active_notebook_id": db.get_active_notebook_id()
    })

@tnote_bp.route('/api/notebooks', methods=['POST'])
@auth_check
def api_add_notebook():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Not defteri adı gerekli"}), 400
    icon = data.get("icon", "📓")
    color = data.get("color", "#3b82f6")
    desc = data.get("description", "")
    user_id = get_current_user_id()
    new_id = db.add_notebook(name, icon=icon, color=color, description=desc, user_id=user_id)
    session["active_notebook_id"] = new_id
    db.set_active_notebook_id(new_id)
    return jsonify({
        "ok": True,
        "id": new_id,
        "notebooks": db.get_notebooks(user_id=user_id),
        "active_notebook_id": new_id
    })

@tnote_bp.route('/api/notebooks/<int:nb_id>', methods=['PUT'])
@auth_check
def api_update_notebook(nb_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Not defteri adı gerekli"}), 400
    icon = data.get("icon", "📓")
    color = data.get("color", "#3b82f6")
    desc = data.get("description", "")
    db.update_notebook(nb_id, name, icon, color, desc)
    return jsonify({"ok": True, "notebook": db.get_notebook(nb_id), "notebooks": db.get_notebooks(user_id=user_id)})

@tnote_bp.route('/api/notebooks/<int:nb_id>', methods=['DELETE'])
@auth_check
def api_delete_notebook(nb_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    success = db.delete_notebook(nb_id)
    if not success:
        return jsonify({"ok": False, "error": "Son kalan not defteri silinemez"}), 400
    notebooks = db.get_notebooks(user_id=user_id)
    active_id = notebooks[0]["id"] if notebooks else 1
    session["active_notebook_id"] = active_id
    db.set_active_notebook_id(active_id)
    return jsonify({
        "ok": True,
        "notebooks": notebooks,
        "active_notebook_id": active_id
    })

@tnote_bp.route('/api/notebooks/switch', methods=['POST'])
@auth_check
def api_switch_notebook():
    data = request.get_json() or {}
    nb_id = data.get("notebook_id")
    if not nb_id:
        return jsonify({"ok": False, "error": "Geçersiz not defteri ID"}), 400
    nb_id = int(nb_id)
    session["active_notebook_id"] = nb_id
    db.set_active_notebook_id(nb_id)
    return jsonify({
        "ok": True,
        "active_notebook_id": nb_id,
        "notebook": db.get_notebook(nb_id),
        "categories": db.get_categories(nb_id),
        "pages": db.get_pages(notebook_id=nb_id)
    })

@tnote_bp.route('/api/notebooks/<int:nb_id>/export', methods=['GET'])
@auth_check
def api_export_notebook(nb_id):
    data = db.export_notebook_data(nb_id)
    if not data:
        return jsonify({"ok": False, "error": "Not defteri bulunamadı"}), 404
    nb_name = data.get("notebook", {}).get("name", f"notebook_{nb_id}")
    safe_name = "".join(c for c in nb_name if c.isalnum() or c in (' ', '-', '_')).strip().replace(' ', '_')
    from flask import Response
    json_bytes = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
    return Response(
        json_bytes,
        mimetype="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}.tnote"',
            "Content-Type": "application/json; charset=utf-8"
        }
    )

@tnote_bp.route('/api/notebooks/import', methods=['POST'])
@auth_check
def api_import_notebook():
    data = None
    file = request.files.get("file")
    if file:
        try:
            content = file.read().decode('utf-8')
            data = json.loads(content)
        except Exception as e:
            return jsonify({"ok": False, "error": f"Geçersiz dosya içeriği: {str(e)}"}), 400
    elif request.is_json:
        data = request.get_json()

    if not data or not isinstance(data, dict):
        return jsonify({"ok": False, "error": "Geçerli bir .tnote JSON verisi veya dosyası yükleyin"}), 400

    user_id = get_current_user_id() or 1
    res = db.import_notebook_data(data, user_id=user_id)
    if not res.get("ok"):
        return jsonify(res), 400

    new_id = res["notebook_id"]
    session["active_notebook_id"] = new_id
    db.set_active_notebook_id(new_id)
    return jsonify({
        "ok": True,
        "id": new_id,
        "notebooks": db.get_notebooks(user_id=user_id),
        "active_notebook_id": new_id
    })

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Genel Bakış & Özet
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/overview', methods=['GET'])
@auth_check
def api_get_overview():
    nb_id = request.args.get('notebook_id', type=int)
    return jsonify({"ok": True, "overview": db.get_overview_summary(nb_id)})

@tnote_bp.route('/api/unified-tasks', methods=['GET'])
@auth_check
def api_get_unified_tasks():
    nb_id = request.args.get('notebook_id', type=int) or session.get('active_notebook_id') or db.get_active_notebook_id()
    tasks = db.get_unified_tasks(nb_id)
    quick_notes = db.get_quick_notes(nb_id)
    return jsonify({
        "ok": True,
        "tasks": tasks,
        "quick_notes": quick_notes,
        "total_count": len([t for t in tasks if not t.get("is_done")])
    })

@tnote_bp.route('/api/toggle-task', methods=['POST'])
@auth_check
def api_toggle_task():
    data = request.get_json() or {}
    task_type = data.get('type', 'checklist')
    raw_id = data.get('raw_id') or data.get('id')
    if isinstance(raw_id, str):
        if raw_id.startswith('fin_'):
            task_type = 'finance'
            raw_id = int(raw_id.replace('fin_', ''))
        elif raw_id.startswith('item_'):
            task_type = 'checklist'
            raw_id = int(raw_id.replace('item_', ''))
        else:
            raw_id = int(raw_id)
    if not raw_id:
        return jsonify({"ok": False, "error": "Geçersiz ID"}), 400
    is_done = db.toggle_unified_task(task_type, int(raw_id))
    return jsonify({"ok": True, "is_done": is_done})

@tnote_bp.route('/api/items/<int:item_id>/reminder', methods=['POST', 'DELETE'])
@auth_check
def api_item_reminder(item_id):
    if request.method == 'DELETE':
        db.delete_reminder("item", item_id)
        return jsonify({"ok": True, "deleted": True})
    data = request.get_json() or {}
    remind_at = data.get("remind_at")
    recurrence = data.get("recurrence", "none")
    if not remind_at:
        db.delete_reminder("item", item_id)
        return jsonify({"ok": True, "deleted": True})
    rem_id = db.set_reminder("item", item_id, remind_at, recurrence)
    return jsonify({"ok": True, "reminder_id": rem_id})

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Kategoriler
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/categories', methods=['GET'])
@auth_check
def api_get_categories():
    nb_id = request.args.get('notebook_id', type=int) or session.get('active_notebook_id') or db.get_active_notebook_id()
    return jsonify({"ok": True, "categories": db.get_categories(nb_id)})

@tnote_bp.route('/api/categories', methods=['POST'])
@auth_check
def api_add_category():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    is_divider = 1 if data.get("is_divider") else 0
    if not name and not is_divider:
        return jsonify({"ok": False, "error": "Kategori adı gerekli"}), 400
    if not name and is_divider:
        name = "---"
    nb_id = data.get("notebook_id") or session.get("active_notebook_id") or db.get_active_notebook_id()
    if nb_id:
        nb_id = int(nb_id)
        session["active_notebook_id"] = nb_id
        db.set_active_notebook_id(nb_id)
    default_icon = "―" if is_divider else "📁"
    default_color = "#94a3b8" if is_divider else "#3b82f6"
    cat_id = db.add_category(name, data.get("icon", default_icon), data.get("color", default_color), notebook_id=nb_id, is_divider=is_divider)
    return jsonify({"ok": True, "id": cat_id, "category_id": cat_id, "categories": db.get_categories(nb_id), "notebook_id": nb_id})

@tnote_bp.route('/api/categories/<int:cat_id>', methods=['PUT'])
@auth_check
def api_update_category(cat_id):
    data = request.get_json() or {}
    db.update_category(cat_id, data.get("name", ""), data.get("icon", "📁"), data.get("color", "#3b82f6"))
    nb_id = session.get("active_notebook_id") or db.get_active_notebook_id()
    return jsonify({"ok": True, "categories": db.get_categories(nb_id)})

@tnote_bp.route('/api/categories/<int:cat_id>', methods=['DELETE'])
@auth_check
def api_delete_category(cat_id):
    db.delete_category(cat_id)
    nb_id = session.get("active_notebook_id") or db.get_active_notebook_id()
    return jsonify({"ok": True, "categories": db.get_categories(nb_id)})

@tnote_bp.route('/api/categories/reorder', methods=['POST'])
@auth_check
def api_reorder_categories():
    data = request.get_json() or {}
    category_ids = data.get("category_ids", [])
    if category_ids:
        db.reorder_categories([int(x) for x in category_ids])
    nb_id = session.get("active_notebook_id") or db.get_active_notebook_id()
    return jsonify({"ok": True, "categories": db.get_categories(nb_id)})

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Sayfalar / Listeler
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/pages', methods=['GET'])
@auth_check
def api_get_pages():
    cat_id = request.args.get('category_id', type=int)
    nb_id = request.args.get('notebook_id', type=int) or (None if cat_id else (session.get('active_notebook_id') or db.get_active_notebook_id()))
    return jsonify({"ok": True, "pages": db.get_pages(category_id=cat_id, notebook_id=nb_id)})

@tnote_bp.route('/api/pages/<int:page_id>', methods=['GET'])
@auth_check
def api_get_page(page_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Bu sayfaya erişim yetkiniz yok"}), 403
    page = db.get_page(page_id)
    if not page:
        return jsonify({"ok": False, "error": "Sayfa bulunamadı"}), 404

    # Sayfa Kilit (PIN/Biyometrik) Güvenlik Katmanı
    if page.get("is_locked"):
        unlocked_in_session = session.get(f"unlocked_page_{page_id}")
        query_pin = request.args.get("pin") or request.headers.get("X-Page-PIN")
        if query_pin and db.verify_page_lock(page_id, query_pin):
            unlocked_in_session = True
            session[f"unlocked_page_{page_id}"] = True

        if not unlocked_in_session:
            page_copy = dict(page)
            page_copy["content"] = ""
            page_copy["is_locked_view"] = True
            page_copy["content_masked"] = True
            return jsonify({"ok": True, "page": page_copy, "items": [], "requires_unlock": True, "content_masked": True})

    items = db.get_items(page_id)
    return jsonify({"ok": True, "page": page, "items": items})

@tnote_bp.route('/api/pages', methods=['POST'])
@auth_check
def api_add_page():
    data = request.get_json() or {}
    title = data.get("title", "").strip()
    cat_id = data.get("category_id")
    if not title or not cat_id:
        return jsonify({"ok": False, "error": "Başlık ve kategori zorunludur"}), 400
    cat_id = int(cat_id)
    cat = db.get_category(cat_id)
    if cat and cat.get("notebook_id"):
        nb_id = cat["notebook_id"]
        session["active_notebook_id"] = nb_id
    else:
        nb_id = data.get("notebook_id") or session.get("active_notebook_id") or db.get_active_notebook_id()
    page_id = db.add_page(
        category_id=cat_id,
        title=title,
        page_type=data.get("type", "checklist"),
        icon=data.get("icon", "📝"),
        content=data.get("content", "")
    )
    return jsonify({"ok": True, "id": page_id, "pages": db.get_pages(notebook_id=nb_id), "notebook_id": nb_id})

@tnote_bp.route('/api/pages/<int:page_id>', methods=['PUT', 'POST'])
@auth_check
def api_update_page(page_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Bu sayfayı güncelleme yetkiniz yok"}), 403
    
    data = request.get_json(silent=True)
    if not data and request.data:
        try:
            import json
            data = json.loads(request.data.decode('utf-8'))
        except Exception:
            data = {}
    data = data or {}
    
    # Otomatik Zaman Tüneli Versiyon Snapshot'ı
    if "content" in data or "title" in data:
        curr = db.get_page(page_id)
        if curr and (curr.get("content") != data.get("content") or curr.get("title") != data.get("title")):
            if curr.get("content") or curr.get("title"):
                db.save_page_version(page_id, curr.get("title", ""), curr.get("content", ""), user_id=user_id)

    db.update_page(
        page_id=page_id,
        title=data.get("title"),
        category_id=data.get("category_id"),
        icon=data.get("icon"),
        content=data.get("content"),
        sort_order=data.get("sort_order")
    )
    return jsonify({"ok": True, "page": db.get_page(page_id)})

@tnote_bp.route('/api/pages/reorder', methods=['POST'])
@auth_check
def api_reorder_pages():
    data = request.get_json() or {}
    category_id = data.get("category_id")
    page_ids = data.get("page_ids", [])
    if category_id is not None and page_ids:
        db.reorder_pages(int(category_id), [int(x) for x in page_ids])
    return jsonify({"ok": True, "categories": db.get_categories(), "pages": db.get_pages()})

@tnote_bp.route('/api/pages/<int:page_id>/move', methods=['POST'])
@auth_check
def api_move_page(page_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Bu sayfayı taşıma yetkiniz yok"}), 403
    data = request.get_json() or {}
    category_id = data.get("category_id")
    if not category_id:
        return jsonify({"ok": False, "error": "Hedef kategori ID gereklidir"}), 400
    db.move_page_to_category(page_id, int(category_id))
    return jsonify({"ok": True, "categories": db.get_categories(), "pages": db.get_pages()})

@tnote_bp.route('/api/pages/<int:page_id>', methods=['DELETE'])
@auth_check
def api_delete_page(page_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Bu sayfayı silme yetkiniz yok"}), 403
    db.delete_page(page_id)
    return jsonify({"ok": True, "pages": db.get_pages()})

# ─────────────────────────────────────────────────────────────────────────────
# Power Packs: Sabitleme, Kilit, Hedef Sayacı, Versiyonlar, Ekler & Zihin Ağı
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/pages/<int:page_id>/pin', methods=['POST'])
@auth_check
def api_page_toggle_pin(page_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Yetkisiz işlem"}), 403
    new_status = db.toggle_page_pin(page_id)
    return jsonify({"ok": True, "is_pinned": new_status})

@tnote_bp.route('/api/pages/<int:page_id>/lock', methods=['POST'])
@auth_check
def api_page_lock(page_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Yetkisiz işlem"}), 403
    data = request.get_json() or {}
    pin = data.get("pin", "").strip()
    action = data.get("action", "lock")
    if action == "unlock":
        db.lock_page(page_id, None, lock=False)
        session.pop(f"unlocked_page_{page_id}", None)
        return jsonify({"ok": True, "is_locked": 0})
    if not pin or len(pin) < 4:
        return jsonify({"ok": False, "error": "PIN en az 4 haneli olmalıdır"}), 400
    db.lock_page(page_id, pin, lock=True)
    session.pop(f"unlocked_page_{page_id}", None)
    return jsonify({"ok": True, "is_locked": 1})

@tnote_bp.route('/api/pages/<int:page_id>/verify-lock', methods=['POST'])
@auth_check
def api_page_verify_lock(page_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Yetkisiz işlem"}), 403
    data = request.get_json() or {}
    pin = data.get("pin", "").strip()
    is_valid = db.verify_page_lock(page_id, pin)
    if not is_valid:
        return jsonify({"ok": False, "error": "Hatalı PIN kodu"}), 401
    session[f"unlocked_page_{page_id}"] = True
    page = db.get_page(page_id)
    items = db.get_items(page_id)
    return jsonify({"ok": True, "unlocked": True, "page": page, "items": items})

@tnote_bp.route('/api/pages/<int:page_id>/word-count-target', methods=['POST'])
@auth_check
def api_page_target_word_count(page_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Yetkisiz işlem"}), 403
    data = request.get_json() or {}
    target = int(data.get("target") or data.get("target_word_count") or 0)
    db.set_target_word_count(page_id, target)
    return jsonify({"ok": True, "target_word_count": target})

@tnote_bp.route('/api/pages/<int:page_id>/versions', methods=['GET'])
@auth_check
def api_page_get_versions(page_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Yetkisiz işlem"}), 403
    versions = db.get_page_versions(page_id)
    return jsonify({"ok": True, "versions": versions})

@tnote_bp.route('/api/pages/<int:page_id>/versions/<int:version_id>/restore', methods=['POST'])
@auth_check
def api_page_restore_version(page_id, version_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Yetkisiz işlem"}), 403
    success = db.restore_page_version(page_id, version_id)
    if not success:
        return jsonify({"ok": False, "error": "Versiyon geri yüklenemedi"}), 400
    return jsonify({"ok": True, "page": db.get_page(page_id)})

@tnote_bp.route('/api/pages/<int:page_id>/attachments', methods=['GET'])
@auth_check
def api_page_get_attachments(page_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Yetkisiz işlem"}), 403
    attachments = db.get_page_attachments(page_id)
    return jsonify({"ok": True, "attachments": attachments})

@tnote_bp.route('/api/pages/<int:page_id>/attachments', methods=['POST'])
@auth_check
def api_page_add_attachment(page_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Yetkisiz işlem"}), 403
    if 'file' not in request.files:
        return jsonify({"ok": False, "error": "Dosya seçilmedi"}), 400
    file = request.files['file']
    if not file or not file.filename:
        return jsonify({"ok": False, "error": "Geçersiz dosya"}), 400

    os.makedirs(UPLOADS_DIR, exist_ok=True)
    orig_name = secure_filename(file.filename) or "belge"
    ext = os.path.splitext(orig_name)[1].lower()
    stored_name = f"doc_{uuid.uuid4().hex[:12]}{ext}"
    save_path = os.path.join(UPLOADS_DIR, stored_name)
    file.save(save_path)
    file_size = os.path.getsize(save_path)
    mime_type = file.mimetype or "application/octet-stream"
    file_url = f"/notes/uploads/{stored_name}"

    att_id = db.add_page_attachment(
        page_id=page_id,
        filename=stored_name,
        original_name=orig_name,
        file_url=file_url,
        file_size=file_size,
        mime_type=mime_type
    )
    return jsonify({
        "ok": True,
        "attachment": {
            "id": att_id,
            "page_id": page_id,
            "filename": stored_name,
            "original_name": orig_name,
            "file_url": file_url,
            "file_size": file_size,
            "mime_type": mime_type
        }
    })

@tnote_bp.route('/api/pages/<int:page_id>/attachments/<int:attachment_id>', methods=['DELETE'])
@auth_check
def api_page_delete_attachment(page_id, attachment_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    if not db.can_access_page(page_id, user_id):
        return jsonify({"ok": False, "error": "Yetkisiz işlem"}), 403
    db.delete_page_attachment(attachment_id, page_id)
    return jsonify({"ok": True})

@tnote_bp.route('/api/graph', methods=['GET'])
@auth_check
def api_get_graph():
    user = get_current_user()
    user_id = user["id"] if user else None
    notebook_id = request.args.get("notebook_id", type=int)
    data = db.get_graph_data(notebook_id=notebook_id, user_id=user_id)
    return jsonify({"ok": True, "graph": data, "nodes": data.get("nodes", []), "links": data.get("edges", []), "edges": data.get("edges", [])})

@tnote_bp.route('/api/sync/tincsync/trigger', methods=['POST'])
@auth_check
def api_tincsync_trigger():
    import urllib.request
    try:
        req = urllib.request.Request("http://127.0.0.1:9015/api/sync/now", method="POST")
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return jsonify({"ok": True, "synced": True, "response": data})
    except Exception as e:
        return jsonify({"ok": True, "synced": False, "message": f"TincSync servisi hazır durumda (Port 9015): {str(e)}"})


# ─────────────────────────────────────────────────────────────────────────────
# REST API: Maddeler (Items)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/pages/<int:page_id>/items', methods=['GET'])
@auth_check
def api_get_items(page_id):
    return jsonify({"ok": True, "items": db.get_items(page_id)})

@tnote_bp.route('/api/pages/<int:page_id>/items', methods=['POST'])
@auth_check
def api_add_item(page_id):
    data = request.get_json() or {}

    # Toplu ekleme desteği (multi-line)
    bulk_text = data.get("bulk_text", "").strip()
    if bulk_text:
        lines = [line.strip() for line in bulk_text.splitlines() if line.strip()]
        added_ids = []
        for line in lines:
            # - [ ] veya - gibi işaretleri temizle
            clean_title = line.lstrip("-*•1234567890.[] ").strip()
            if clean_title:
                aid = db.add_item(page_id=page_id, title=clean_title)
                added_ids.append(aid)
        return jsonify({"ok": True, "added_count": len(added_ids), "items": db.get_items(page_id)})

    title = data.get("title", "").strip()
    url = data.get("url", "").strip()

    # Eğer başlık verilmediyse ama URL verildiyse scraper çalıştır
    image_url = data.get("image_url", "").strip()
    price = data.get("price", "").strip()
    description = data.get("description", "").strip()

    if url and not title:
        meta = scrape_url_metadata(url)
        title = meta.get("title") or url
        image_url = image_url or meta.get("image_url", "")
        price = price or meta.get("price", "")
        description = description or meta.get("description", "")

    if not title:
        return jsonify({"ok": False, "error": "Madde başlığı veya link gereklidir"}), 400

    item_id = db.add_item(
        page_id=page_id,
        title=title,
        description=description,
        url=url,
        image_url=image_url,
        price=price,
        quantity=data.get("quantity", "").strip()
    )

    # Hatırlatma varsa ayarla
    remind_at = data.get("remind_at")
    if remind_at:
        db.set_reminder("item", item_id, remind_at, data.get("recurrence", "none"))

    return jsonify({"ok": True, "item_id": item_id, "items": db.get_items(page_id)})

@tnote_bp.route('/api/items/<int:item_id>', methods=['GET'])
@auth_check
def api_get_item(item_id):
    item = db.get_item(item_id)
    if not item:
        return jsonify({"ok": False, "error": "Madde bulunamadı"}), 404
    return jsonify({"ok": True, "item": item})

@tnote_bp.route('/api/items/<int:item_id>', methods=['PUT'])
@auth_check
def api_update_item(item_id):
    data = request.get_json() or {}
    db.update_item(item_id, **data)

    if "remind_at" in data:
        rem_time = data["remind_at"]
        if rem_time:
            db.set_reminder("item", item_id, rem_time, data.get("recurrence", "none"))
        else:
            db.delete_reminder("item", item_id)

    return jsonify({"ok": True})

@tnote_bp.route('/api/items/<int:item_id>', methods=['DELETE'])
@auth_check
def api_delete_item(item_id):
    db.delete_item(item_id)
    return jsonify({"ok": True})

@tnote_bp.route('/api/pages/<int:page_id>/clear_completed', methods=['POST'])
@auth_check
def api_clear_completed(page_id):
    db.clear_completed_items(page_id)
    return jsonify({"ok": True, "items": db.get_items(page_id)})

@tnote_bp.route('/api/pages/<int:page_id>/reorder', methods=['POST'])
@auth_check
def api_reorder_items(page_id):
    data = request.get_json() or {}
    item_ids = data.get("item_ids", [])
    if item_ids:
        db.reorder_items(item_ids)
    return jsonify({"ok": True})

@tnote_bp.route('/api/pages/<int:page_id>/reset', methods=['POST'])
@auth_check
def api_reset_page_items(page_id):
    db.reset_page_items(page_id)
    return jsonify({"ok": True, "items": db.get_items(page_id)})

@tnote_bp.route('/api/pages/<int:page_id>/send_telegram', methods=['POST'])
@auth_check
def api_send_page_telegram(page_id):
    from .telegram_bot import send_page_to_telegram
    data = request.get_json() or {}
    chat_id = data.get("chat_id")
    if not chat_id:
        users = db.get_telegram_users()
        allowed = [u for u in users if u.get("is_allowed") == 1]
        if allowed:
            chat_id = allowed[0]["chat_id"]
        else:
            chat_id = db.get_setting("telegram_chat_ids", "").split(",")[0].strip()
    if not chat_id:
        return jsonify({"ok": False, "error": "Hedef Telegram kullanıcısı bulunamadı"}), 400
    ok = send_page_to_telegram(chat_id, page_id)
    return jsonify({"ok": ok})

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Finans & Düzenli Ödeme Takibi
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/pages/<int:page_id>/finance', methods=['GET'])
@auth_check
def api_get_finance_entries(page_id):
    period = request.args.get("period") or datetime.now().strftime("%Y-%m")
    entries = db.get_finance_entries(page_id, period)
    incomes = [e for e in entries if e['entry_type'] == 'income']
    expenses = [e for e in entries if e['entry_type'] == 'expense']
    tot_inc = sum(e['amount'] for e in incomes)
    tot_exp = sum(e['amount'] for e in expenses)
    unpaid_exp = sum(e['amount'] for e in expenses if not e['is_paid'])
    summary = {
        "period": period,
        "total_income": tot_inc,
        "total_expense": tot_exp,
        "net_balance": tot_inc - tot_exp,
        "unpaid_expense": unpaid_exp,
        "paid_expense": tot_exp - unpaid_exp,
        "income_count": len(incomes),
        "expense_count": len(expenses)
    }
    return jsonify({"ok": True, "entries": entries, "summary": summary})

@tnote_bp.route('/api/pages/<int:page_id>/finance', methods=['POST'])
@auth_check
def api_add_finance_entry(page_id):
    data = request.get_json() or {}
    title = data.get("title", "").strip()
    try:
        amount = float(data.get("amount", 0.0))
    except (ValueError, TypeError):
        amount = 0.0
    entry_type = data.get("entry_type", "expense")
    if not title or amount <= 0:
        return jsonify({"ok": False, "error": "Geçerli bir başlık ve tutar girin"}), 400
    entry_id = db.add_finance_entry(
        page_id=page_id,
        entry_type=entry_type,
        title=title,
        amount=amount,
        category=data.get("category", "Genel"),
        due_day=int(data.get("due_day", 1)),
        due_date=data.get("due_date"),
        is_recurring=1 if data.get("is_recurring", True) else 0,
        end_period=data.get("end_period", ""),
        reminder_days=int(data.get("reminder_days", 0)),
        reminder_time=data.get("reminder_time", "09:00"),
        period=data.get("period"),
        notes=data.get("notes", "")
    )
    return jsonify({"ok": True, "id": entry_id})

@tnote_bp.route('/api/finance/<int:entry_id>', methods=['PUT'])
@auth_check
def api_update_finance_entry(entry_id):
    data = request.get_json() or {}
    db.update_finance_entry(entry_id, **data)
    return jsonify({"ok": True})

@tnote_bp.route('/api/finance/<int:entry_id>/toggle', methods=['POST'])
@auth_check
def api_toggle_finance_paid(entry_id):
    new_val = db.toggle_finance_paid(entry_id)
    return jsonify({"ok": True, "is_paid": new_val})

@tnote_bp.route('/api/finance/<int:entry_id>', methods=['DELETE'])
@auth_check
def api_delete_finance_entry(entry_id):
    db.delete_finance_entry(entry_id)
    return jsonify({"ok": True})

@tnote_bp.route('/api/pages/<int:page_id>/finance/copy_recurring', methods=['POST'])
@auth_check
def api_copy_recurring_finance(page_id):
    data = request.get_json() or {}
    source_period = data.get("source_period")
    target_period = data.get("target_period")
    if not source_period or not target_period:
        return jsonify({"ok": False, "error": "Kaynak ve hedef dönem gereklidir"}), 400
    copied = db.copy_recurring_to_period(page_id, source_period, target_period)
    return jsonify({"ok": True, "copied_count": copied})

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Proje Yönetim & Atölye / İnşa / AR-GE
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/pages/<int:page_id>/project', methods=['GET'])
@auth_check
def api_get_project_data(page_id):
    data = db.get_project_data(page_id)
    return jsonify({"ok": True, "project": data})

@tnote_bp.route('/api/pages/<int:page_id>/project', methods=['PUT'])
@auth_check
def api_update_project(page_id):
    data = request.get_json() or {}
    db.update_project_details(page_id, **data)
    return jsonify({"ok": True})

# Proje Aşamaları (Milestones / Zaman Çizelgesi)
@tnote_bp.route('/api/pages/<int:page_id>/project/milestones', methods=['POST'])
@auth_check
def api_add_project_milestone(page_id):
    data = request.get_json() or {}
    title = data.get("title", "").strip()
    if not title:
        return jsonify({"ok": False, "error": "Aşama başlığı gereklidir"}), 400
    mid = db.add_project_milestone(
        page_id=page_id,
        title=title,
        target_date=data.get("target_date", ""),
        status=data.get("status", "pending"),
        description=data.get("description", ""),
        requirements=data.get("requirements", "")
    )
    return jsonify({"ok": True, "id": mid})

@tnote_bp.route('/api/milestones/<int:milestone_id>', methods=['PUT'])
@auth_check
def api_update_project_milestone(milestone_id):
    data = request.get_json() or {}
    db.update_project_milestone(milestone_id, **data)
    return jsonify({"ok": True})

@tnote_bp.route('/api/milestones/<int:milestone_id>/toggle', methods=['POST'])
@auth_check
def api_toggle_milestone(milestone_id):
    new_status = db.toggle_milestone_status(milestone_id)
    return jsonify({"ok": True, "status": new_status})

@tnote_bp.route('/api/milestones/<int:milestone_id>', methods=['DELETE'])
@auth_check
def api_delete_milestone(milestone_id):
    db.delete_project_milestone(milestone_id)
    return jsonify({"ok": True})

# Proje Malzemeleri (BOM)
@tnote_bp.route('/api/pages/<int:page_id>/project/materials', methods=['POST'])
@auth_check
def api_add_project_material(page_id):
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Malzeme adı gereklidir"}), 400
    mid = db.add_project_material(
        page_id=page_id,
        name=name,
        quantity=data.get("quantity", "1"),
        unit_price=float(data.get("unit_price", 0.0) or 0.0),
        status=data.get("status", "needed"),
        url=data.get("url", ""),
        notes=data.get("notes", "")
    )
    return jsonify({"ok": True, "id": mid})

@tnote_bp.route('/api/materials/<int:material_id>', methods=['PUT'])
@auth_check
def api_update_project_material(material_id):
    data = request.get_json() or {}
    db.update_project_material(material_id, **data)
    return jsonify({"ok": True})

@tnote_bp.route('/api/materials/<int:material_id>/toggle', methods=['POST'])
@auth_check
def api_toggle_material(material_id):
    new_status = db.toggle_material_status(material_id)
    return jsonify({"ok": True, "status": new_status})

@tnote_bp.route('/api/materials/<int:material_id>', methods=['DELETE'])
@auth_check
def api_delete_material(material_id):
    db.delete_project_material(material_id)
    return jsonify({"ok": True})

# Proje Gelişim Günlüğü (Logs)
@tnote_bp.route('/api/pages/<int:page_id>/project/logs', methods=['POST'])
@auth_check
def api_add_project_log(page_id):
    data = request.get_json() or {}
    title = data.get("title", "").strip()
    content = data.get("content", "").strip()
    if not title or not content:
        return jsonify({"ok": False, "error": "Başlık ve içerik gereklidir"}), 400
    lid = db.add_project_log(
        page_id=page_id,
        title=title,
        content=content,
        log_type=data.get("log_type", "progress"),
        image_url=data.get("image_url", ""),
        log_date=data.get("log_date")
    )
    return jsonify({"ok": True, "id": lid})

@tnote_bp.route('/api/logs/<int:log_id>', methods=['DELETE'])
@auth_check
def api_delete_log(log_id):
    db.delete_project_log(log_id)
    return jsonify({"ok": True})

# Çizimler / Şemalar
@tnote_bp.route('/api/pages/<int:page_id>/project/drawings', methods=['POST'])
@auth_check
def api_add_project_drawing(page_id):
    data = request.get_json() or {}
    title = data.get("title", "").strip()
    url = data.get("url", "").strip()
    if not title or not url:
        return jsonify({"ok": False, "error": "Başlık ve görsel bağlantısı gereklidir"}), 400
    item = db.add_project_drawing(page_id, title, url, desc=data.get("desc", ""))
    return jsonify({"ok": True, "drawing": item})

@tnote_bp.route('/api/pages/<int:page_id>/project/drawings/<int:drawing_id>', methods=['DELETE'])
@auth_check
def api_delete_project_drawing(page_id, drawing_id):
    db.delete_project_drawing(page_id, drawing_id)
    return jsonify({"ok": True})

# Dosya Yükleme (Görsel, Şema, Kroki)
@tnote_bp.route('/api/pages/<int:page_id>/project/upload', methods=['POST'])
@auth_check
def api_upload_project_file(page_id):
    if 'file' not in request.files:
        return jsonify({"ok": False, "error": "Dosya seçilmedi"}), 400
    file = request.files['file']
    if not file or file.filename == '':
        return jsonify({"ok": False, "error": "Geçersiz dosya"}), 400
    
    import time
    ext = os.path.splitext(file.filename)[1].lower()
    allowed_exts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']
    if ext not in allowed_exts:
        return jsonify({"ok": False, "error": "Desteklenmeyen dosya türü (PNG, JPG, WEBP, GIF, PDF)"}), 400

    filename = f"p{page_id}_{int(time.time())}_{secure_filename(file.filename)}"
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    save_path = os.path.join(UPLOADS_DIR, filename)
    file.save(save_path)
    file_url = f"/notes/uploads/{filename}"

    # Çizimler listesine de ekle
    title = request.form.get("title") or file.filename
    desc = request.form.get("desc") or ""
    item = db.add_project_drawing(page_id, title, file_url, desc=desc)

    return jsonify({"ok": True, "url": file_url, "drawing": item})

@tnote_bp.route('/uploads/<path:filename>')
@auth_check
def serve_uploaded_file(filename):
    resp = send_from_directory(UPLOADS_DIR, filename)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Content-Security-Policy"] = "default-src 'self'"
    return resp

@tnote_bp.route('/api/upload_image', methods=['POST'])
@auth_check
def api_upload_image():
    if 'image' not in request.files and 'file' not in request.files:
        return jsonify({"ok": False, "error": "Görsel dosyası bulunamadı"}), 400
    file = request.files.get('image') or request.files.get('file')
    if not file or not file.filename:
        return jsonify({"ok": False, "error": "Geçersiz dosya"}), 400
    
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']:
        return jsonify({"ok": False, "error": "Yalnızca görsel dosyaları (.png, .jpg, .webp, vb.) yüklenebilir"}), 400
    
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    filename = f"img_{uuid.uuid4().hex[:12]}{ext}"
    save_path = os.path.join(UPLOADS_DIR, filename)
    file.save(save_path)
    file_url = f"/notes/uploads/{filename}"
    return jsonify({"ok": True, "url": file_url, "filename": filename})

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Veri İçe Aktarma (Google Keep, Evernote, Microsoft To-Do)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/import', methods=['POST'])
@auth_check
def api_import_data():
    if 'file' not in request.files:
        return jsonify({"ok": False, "error": "Lütfen içe aktarılacak bir dosya seçin (.zip, .enex, .json, .csv, .md)"}), 400
    file = request.files['file']
    if not file or file.filename == '':
        return jsonify({"ok": False, "error": "Geçersiz dosya"}), 400
    source_type = request.form.get("source_type", "auto")
    target_category_id = request.form.get("target_category_id")
    if target_category_id:
        try:
            target_category_id = int(target_category_id)
        except Exception:
            target_category_id = None
    from .importer import process_uploaded_import_file
    result = process_uploaded_import_file(file, source_type=source_type, target_category_id=target_category_id)
    return jsonify(result)

@tnote_bp.route('/api/export/backup', methods=['GET'])
@auth_check
def api_export_backup():
    try:
        data = db.get_full_export_data()

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            # 1. Tam JSON veritabanı dökümü
            json_str = json.dumps(data, ensure_ascii=False, indent=2)
            zf.writestr("tincnote_backup.json", json_str.encode("utf-8"))

            # 2. Markdown dosyaları (Kategori klasörlerine göre organize)
            cat_map = {c["id"]: c["name"] for c in data.get("categories", [])}
            items_by_page = {}
            for item in data.get("items", []):
                items_by_page.setdefault(item["page_id"], []).append(item)

            for page in data.get("pages", []):
                cat_name = cat_map.get(page.get("category_id"), "Genel")
                safe_cat = "".join(c for c in cat_name if c.isalnum() or c in " _-ğüşıöçĞÜŞİÖÇ").strip() or "Genel"
                safe_title = "".join(c for c in page.get("title", "Sayfa") if c.isalnum() or c in " _-ğüşıöçĞÜŞİÖÇ").strip() or f"Sayfa_{page.get('id')}"

                md_lines = [f"# {page.get('title', 'Başlıksız')}", ""]
                ptype = page.get("type", "notes")
                md_lines.append(f"> Tür: {ptype} | Oluşturulma: {page.get('created_at', '')}")
                md_lines.append("")

                if page.get("content"):
                    md_lines.append(page["content"])
                    md_lines.append("")

                p_items = items_by_page.get(page["id"], [])
                if p_items:
                    for it in p_items:
                        checked = "[x]" if it.get("is_checked") else "[ ]"
                        title = it.get("title") or ""
                        md_lines.append(f"- {checked} {title}")
                        if it.get("notes"):
                            md_lines.append(f"  > {it['notes']}")
                    md_lines.append("")

                md_content = "\n".join(md_lines)
                zf.writestr(f"markdown/{safe_cat}/{safe_title}.md", md_content.encode("utf-8"))

        zip_buffer.seek(0)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"tincnote_backup_{timestamp}.zip"
        return send_file(
            zip_buffer,
            mimetype="application/zip",
            as_attachment=True,
            download_name=filename
        )
    except Exception as e:
        return jsonify({"ok": False, "error": f"Yedekleme oluşturulamadı: {str(e)}"}), 500

@tnote_bp.route('/api/scrape', methods=['POST'])
@tnote_bp.route('/api/tools/clip_url', methods=['POST'])
@auth_check
def api_scrape_url():
    data = request.get_json() or {}
    text = data.get("url", "").strip()
    url = extract_first_url(text) or text
    if not url:
        return jsonify({"ok": False, "error": "Geçerli bir URL bulunamadı"}), 400
    meta = scrape_url_metadata(url)
    return jsonify({"ok": True, "metadata": meta, "card": meta})

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Çöp Kutusu (Trash & Restore)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/trash', methods=['GET'])
@auth_check
def api_get_trash():
    trash = db.get_trash_pages()
    return jsonify({"ok": True, "trash": trash, "count": len(trash)})

@tnote_bp.route('/api/trash/<int:page_id>/restore', methods=['POST'])
@auth_check
def api_restore_trash(page_id):
    db.restore_page(page_id)
    return jsonify({
        "ok": True,
        "categories": db.get_categories(),
        "pages": db.get_pages(),
        "trash": db.get_trash_pages()
    })

@tnote_bp.route('/api/trash/<int:page_id>', methods=['DELETE'])
@auth_check
def api_delete_trash_permanent(page_id):
    db.delete_page(page_id, permanent=True)
    return jsonify({"ok": True, "trash": db.get_trash_pages()})

@tnote_bp.route('/api/trash/empty', methods=['POST'])
@auth_check
def api_empty_trash():
    cnt = db.empty_trash()
    return jsonify({"ok": True, "deleted_count": cnt, "trash": []})

@tnote_bp.route('/api/trash/purge', methods=['POST'])
@auth_check
def api_purge_trash():
    days = request.args.get("days", 30, type=int)
    cnt = db.purge_expired_trash(days=days)
    return jsonify({"ok": True, "purged_count": cnt, "trash": db.get_trash_pages()})

# ─────────────────────────────────────────────────────────────────────────────
# REST API: İşlem Geçmişi & Geri Alma (Undo History - Son 100 İşlem)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/history', methods=['GET'])
@auth_check
def api_get_history():
    history = db.get_action_history(100)
    return jsonify({"ok": True, "history": history, "count": len(history)})

@tnote_bp.route('/api/undo', methods=['POST'])
@auth_check
def api_undo_latest():
    res = db.undo_action()
    res["categories"] = db.get_categories()
    res["pages"] = db.get_pages()
    return jsonify(res)

@tnote_bp.route('/api/history/<int:history_id>/undo', methods=['POST'])
@auth_check
def api_undo_specific(history_id):
    res = db.undo_action(history_id)
    res["categories"] = db.get_categories()
    res["pages"] = db.get_pages()
    return jsonify(res)

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Global Arama (Spotlight Search - Ctrl+K)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/search', methods=['GET'])
@auth_check
def api_global_search():
    q = request.args.get("q", "").strip()
    user = get_current_user()
    user_id = user["id"] if user else None
    results = db.global_search(q, user_id=user_id)
    return jsonify({"ok": True, "results": results})

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Şifreler & Kimlik Bilgileri Kasası (Vault)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/vault', methods=['GET'])
@auth_check
def api_get_vault():
    user = get_current_user()
    user_id = user["id"] if user else None
    scope = request.args.get("scope")
    category = request.args.get("category")
    profile = request.args.get("profile")
    folder = request.args.get("folder")
    tag = request.args.get("tag")
    search = request.args.get("q")
    entries = db.get_vault_entries(scope=scope, category=category, profile_name=profile, folder_name=folder, tag=tag, search=search, user_id=user_id)
    profiles = db.get_vault_profiles()
    folders = db.get_vault_folders()
    tags = db.get_vault_tags()
    return jsonify({
        "ok": True,
        "entries": entries,
        "profiles": profiles,
        "folders": folders,
        "tags": tags,
        "count": len(entries)
    })

@tnote_bp.route('/api/vault/folders', methods=['GET', 'POST'])
@auth_check
def api_vault_folders():
    if request.method == 'POST':
        data = request.get_json() or {}
        name = data.get("name", "").strip()
        icon = data.get("icon", "📁")
        color = data.get("color", "#3b82f6")
        if not name:
            return jsonify({"ok": False, "error": "Klasör adı zorunludur"}), 400
        fid = db.add_vault_folder(name, icon, color)
        return jsonify({"ok": True, "id": fid, "folders": db.get_vault_folders()})
    return jsonify({"ok": True, "folders": db.get_vault_folders()})

@tnote_bp.route('/api/vault/folders/rename', methods=['POST'])
@auth_check
def api_rename_vault_folder():
    data = request.get_json() or {}
    old_name = data.get("old_name", "").strip()
    new_name = data.get("new_name", "").strip()
    if not old_name or not new_name:
        return jsonify({"ok": False, "error": "Geçerli isimler giriniz"}), 400
    ok = db.rename_vault_folder(old_name, new_name)
    return jsonify({"ok": ok, "folders": db.get_vault_folders()})

@tnote_bp.route('/api/vault/folders/delete', methods=['POST'])
@auth_check
def api_delete_vault_folder():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Klasör adı zorunludur"}), 400
    ok = db.delete_vault_folder(name)
    return jsonify({"ok": ok, "folders": db.get_vault_folders()})

@tnote_bp.route('/api/vault/<int:entry_id>/related', methods=['GET'])
@auth_check
def api_get_vault_related(entry_id):
    data = db.get_related_vault_entries(entry_id)
    return jsonify({"ok": True, **data})

@tnote_bp.route('/api/vault/<int:entry_id>', methods=['GET'])
@auth_check
def api_get_vault_entry(entry_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    entry = db.get_vault_entry(entry_id, user_id=user_id)
    if not entry:
        return jsonify({"ok": False, "error": "Kayıt bulunamadı"}), 404
    return jsonify({"ok": True, "entry": entry})

@tnote_bp.route('/api/vault/<int:entry_id>/reveal', methods=['POST'])
@auth_check
def api_reveal_vault_entry(entry_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    entry = db.get_vault_entry_decrypted(entry_id, user_id=user_id)
    if not entry:
        return jsonify({"ok": False, "error": "Kayıt bulunamadı veya yetkisiz erişim"}), 404
    return jsonify({
        "ok": True,
        "password": entry.get("password", ""),
        "secondary_info": entry.get("secondary_info", "")
    })

@tnote_bp.route('/api/vault', methods=['POST'])
@auth_check
def api_create_vault_entry():
    user = get_current_user()
    user_id = user["id"] if user else 1
    data = request.get_json() or {}
    title = data.get("title", "").strip()
    if not title:
        return jsonify({"ok": False, "error": "Başlık alanı zorunludur"}), 400

    new_id = db.add_vault_entry(
        title=title,
        category=data.get("category", "web"),
        scope=data.get("scope", "personal"),
        profile_name=data.get("profile_name", ""),
        folder_name=data.get("folder_name", ""),
        tags=data.get("tags", ""),
        username=data.get("username", ""),
        password=data.get("password", ""),
        url=data.get("url", ""),
        secondary_info=data.get("secondary_info", ""),
        notes=data.get("notes", ""),
        icon=data.get("icon", "🔐"),
        color=data.get("color", "#3b82f6"),
        is_favorite=int(data.get("is_favorite", 0)),
        user_id=user_id
    )
    return jsonify({"ok": True, "id": new_id, "entry": db.get_vault_entry(new_id, user_id=user_id)})

@tnote_bp.route('/api/vault/<int:entry_id>', methods=['PUT'])
@auth_check
def api_update_vault_entry(entry_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    entry = db.get_vault_entry(entry_id, user_id=user_id)
    if not entry:
        return jsonify({"ok": False, "error": "Kayıt bulunamadı veya düzenleme yetkiniz yok"}), 403
    data = request.get_json() or {}
    db.update_vault_entry(entry_id, **data)
    return jsonify({"ok": True, "entry": db.get_vault_entry(entry_id, user_id=user_id)})

@tnote_bp.route('/api/vault/<int:entry_id>', methods=['DELETE'])
@auth_check
def api_delete_vault_entry(entry_id):
    user = get_current_user()
    user_id = user["id"] if user else None
    entry = db.get_vault_entry(entry_id, user_id=user_id)
    if not entry:
        return jsonify({"ok": False, "error": "Kayıt bulunamadı veya silme yetkiniz yok"}), 403
    permanent = request.args.get("permanent", "0") == "1"
    db.delete_vault_entry(entry_id, permanent=permanent)
    return jsonify({"ok": True})

@tnote_bp.route('/api/vault/<int:entry_id>/favorite', methods=['POST'])
@auth_check
def api_toggle_vault_favorite(entry_id):
    fav = db.toggle_vault_favorite(entry_id)
    return jsonify({"ok": True, "is_favorite": fav})

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Hatırlatıcılar & Ayarlar
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/settings', methods=['GET'])
@auth_check
def api_get_settings():
    settings = db.get_all_settings()
    settings["bot_running"] = is_bot_running()
    return jsonify({"ok": True, "settings": settings})

@tnote_bp.route('/api/settings', methods=['POST'])
@auth_check
def api_save_settings():
    data = request.get_json() or {}
    db.update_settings(data)

    # Bot durumu güncelle
    if data.get("telegram_enabled") == "1":
        start_telegram_bot()
    else:
        stop_telegram_bot()

    return jsonify({"ok": True, "settings": db.get_all_settings(), "bot_running": is_bot_running()})

@tnote_bp.route('/api/telegram/test', methods=['POST'])
@auth_check
def api_test_telegram():
    token = db.get_setting("telegram_bot_token", "").strip()
    if not token:
        return jsonify({"ok": False, "error": "Telegram Bot Token tanımlanmamış"}), 400

    chat_ids_str = db.get_setting("telegram_chat_ids", "").strip()
    if not chat_ids_str:
        return jsonify({"ok": False, "error": "Hiçbir Telegram Chat ID tanımlanmamış"}), 400

    test_msg = (
        "🚀 *Tinc-Hub TincNote Bağlantı Testi*\n\n"
        "Tebrikler! Telegram botu TincNote modülüne başarıyla bağlandı.\n"
        "Artık buraya ürün linkleri ve notlar gönderebilirsiniz."
    )
    sent_count = send_notification_to_all_chats(test_msg)
    if sent_count > 0:
        return jsonify({"ok": True, "sent_count": sent_count, "message": f"{sent_count} sohbete test mesajı iletildi."})
    else:
        return jsonify({"ok": False, "error": "Mesaj iletilemedi. Token ve Chat ID'leri kontrol edin."}), 400

@tnote_bp.route('/api/telegram/toggle', methods=['POST'])
@auth_check
def api_toggle_telegram():
    current = is_bot_running()
    if current:
        stop_telegram_bot()
        db.set_setting("telegram_enabled", "0")
    else:
        db.set_setting("telegram_enabled", "1")
        start_telegram_bot()
    return jsonify({"ok": True, "bot_running": is_bot_running()})

@tnote_bp.route('/api/telegram/users', methods=['GET'])
@auth_check
def api_get_telegram_users():
    return jsonify({"ok": True, "users": db.get_telegram_users()})

@tnote_bp.route('/api/telegram/users', methods=['POST'])
@auth_check
def api_add_telegram_user():
    data = request.get_json() or {}
    target = data.get("target", "").strip()
    if not target:
        return jsonify({"ok": False, "error": "ID veya kullanıcı adı giriniz"}), 400
    db.add_allowed_target(target)
    return jsonify({"ok": True, "users": db.get_telegram_users()})

@tnote_bp.route('/api/telegram/users/<chat_id>/toggle', methods=['POST'])
@auth_check
def api_toggle_telegram_user(chat_id):
    users = db.get_telegram_users()
    cur_user = next((u for u in users if str(u["chat_id"]) == str(chat_id)), None)
    if cur_user:
        new_val = 0 if cur_user["is_allowed"] == 1 else 1
        db.set_telegram_user_allowed(chat_id, new_val)
    return jsonify({"ok": True, "users": db.get_telegram_users()})

@tnote_bp.route('/api/telegram/users/<chat_id>', methods=['DELETE'])
@auth_check
def api_delete_telegram_user(chat_id):
    db.delete_telegram_user(chat_id)
    return jsonify({"ok": True, "users": db.get_telegram_users()})

# ─────────────────────────────────────────────────────────────────────────────
# HIZLI NOTLAR & HIZLI GÖREVLER API (Quick Notes & Tasks Hub)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/quick-notes', methods=['GET'])
@auth_check
def api_get_quick_notes():
    nb_id = request.args.get('notebook_id') or db.get_active_notebook_id()
    notes = db.get_quick_notes(notebook_id=nb_id)
    return jsonify({"ok": True, "notes": notes})

@tnote_bp.route('/api/quick-notes', methods=['POST'])
@auth_check
def api_add_quick_note():
    data = request.get_json() or {}
    content = data.get('content', '').strip()
    if not content:
        return jsonify({"ok": False, "error": "Not içeriği boş olamaz"}), 400
    nb_id = data.get('notebook_id') or db.get_active_notebook_id()
    color = data.get('color', '#ffffff')
    note_id = db.add_quick_note(content=content, notebook_id=nb_id, color=color)
    notes = db.get_quick_notes(notebook_id=nb_id)
    return jsonify({"ok": True, "id": note_id, "notes": notes})

@tnote_bp.route('/api/quick-notes/<int:note_id>', methods=['PUT'])
@auth_check
def api_update_quick_note(note_id):
    data = request.get_json() or {}
    content = data.get('content', '').strip()
    if not content:
        return jsonify({"ok": False, "error": "Not içeriği boş olamaz"}), 400
    db.update_quick_note(note_id, content)
    nb_id = db.get_active_notebook_id()
    return jsonify({"ok": True, "notes": db.get_quick_notes(notebook_id=nb_id)})

@tnote_bp.route('/api/quick-notes/<int:note_id>', methods=['DELETE'])
@auth_check
def api_delete_quick_note(note_id):
    db.delete_quick_note(note_id)
    nb_id = db.get_active_notebook_id()
    return jsonify({"ok": True, "notes": db.get_quick_notes(notebook_id=nb_id)})

@tnote_bp.route('/api/quick-notes/<int:note_id>/move', methods=['POST'])
@auth_check
def api_move_quick_note(note_id):
    data = request.get_json() or {}
    target_page_id = data.get('target_page_id')
    target_category_id = data.get('target_category_id')
    new_page_title = data.get('new_page_title')

    ok, msg, res_page_id = db.move_quick_note(
        note_id=note_id,
        target_page_id=target_page_id,
        target_category_id=target_category_id,
        new_page_title=new_page_title
    )
    if not ok:
        return jsonify({"ok": False, "error": msg}), 400

    nb_id = db.get_active_notebook_id()
    return jsonify({
        "ok": True,
        "message": msg,
        "target_page_id": res_page_id,
        "notes": db.get_quick_notes(notebook_id=nb_id)
    })

@tnote_bp.route('/api/quick-tasks', methods=['POST'])
@auth_check
def api_add_quick_task():
    data = request.get_json() or {}
    title = data.get('title', '').strip()
    if not title:
        return jsonify({"ok": False, "error": "Görev başlığı boş olamaz"}), 400
    nb_id = data.get('notebook_id') or db.get_active_notebook_id()
    res = db.add_quick_task(title=title, notebook_id=nb_id)
    tasks = db.get_unified_tasks(notebook_id=nb_id)
    return jsonify({
        "ok": True,
        "item_id": res["item_id"],
        "page_id": res["page_id"],
        "category_id": res["category_id"],
        "tasks": tasks
    })

@tnote_bp.route('/api/app-version')
def api_app_version():
    return jsonify({
        "version": "1.8.2",
        "versionCode": 182,
        "download_url": url_for('tnote.download_apk'),
        "notes": "v1.8.2:\n- TincID Merkezi Ekosistem Kimliği ve Google / Apple ile Giriş (SSO)\n- Notları En Üste Sabitleme (📌) ve Akordiyon / Katlanabilir Başlıklar (▶)\n- Biyometrik / PIN Sayfa Kilidi (🔒) ve Güvenli Maskeleme\n- PDF ve Belge Ekleri Tepsisi (📎)\n- Hedef Kelime Sayacı ve Canlı İlerleme Çubuğu (🎯)\n- Obsidian Tarzı İnteraktif Zihin Haritası (Graph View 🕸️)\n- Sürüm Geçmişi ve Geri Yükleme Zaman Makinesi (⏳)\n- Akıllı Web & X/Twitter Tweet Kart Kırpıcı (🔗)\n- E-posta Kod Doğrulama, Hesap Dondurma ve Kalıcı Silme (GDPR Takeout ZIP)"
    })

@tnote_bp.route('/download/apk')
def download_apk():
    apk_paths = [
        "/home/turan/Masaüstü/TincNote-v1.8.2.apk",
        "/opt/tinc-hub/TNOTE/static/download/TincNote-v1.8.2.apk",
        "/opt/tinc-hub/TNOTE/static/download/TincNote-latest.apk",
        "/home/turan/101/tinc-hub/TNOTE/static/download/TincNote-latest.apk",
        "/home/turan/101/tinc-hub-mobile/android/app/build/outputs/apk/release/app-release.apk",
        "/home/turan/Masaüstü/TincNote-v1.8.0.apk",
    ]
    for p in apk_paths:
        if os.path.exists(p):
            return send_file(p, as_attachment=True, download_name="TincNote-v1.8.2.apk")
    return "APK dosyası bulunamadı", 404

# ─────────────────────────────────────────────────────────────────────────────
# DIŞA AKTARMA (PAGE EXPORT: MARKDOWN, TXT, JSON)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/pages/<int:page_id>/export', methods=['GET'])
@auth_check
def api_export_page(page_id):
    fmt = request.args.get('format', 'md').lower()
    page = db.get_page(page_id)
    if not page:
        return jsonify({"ok": False, "error": "Sayfa bulunamadı"}), 404

    title = page.get('title', 'Not')
    page_type = page.get('type', 'checklist')
    safe_title = "".join(c for c in title if c.isalnum() or c in (' ', '-', '_')).strip().replace(' ', '_')
    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    filename = f"{safe_title}_{timestamp}.{fmt}"

    if fmt == 'json':
        export_data = {
            "title": title,
            "type": page_type,
            "icon": page.get('icon'),
            "category": page.get('category_name'),
            "exported_at": datetime.now().isoformat()
        }
        if page_type == 'checklist':
            export_data["items"] = db.get_items(page_id)
        elif page_type == 'finance':
            export_data["entries"] = db.get_finance_entries(page_id)
        elif page_type == 'project':
            export_data["project"] = db.get_project_data(page_id)
            export_data["items"] = db.get_items(page_id)
        else:
            export_data["content"] = page.get('content', '')

        bio = io.BytesIO(json.dumps(export_data, ensure_ascii=False, indent=2).encode('utf-8'))
        return send_file(bio, as_attachment=True, download_name=filename, mimetype='application/json')

    elif fmt in ('md', 'txt'):
        lines = []
        if fmt == 'md':
            lines.append(f"# {page.get('icon', '')} {title}\n")
            lines.append(f"> Kategori: **{page.get('category_name', 'Genel')}** | Tür: *{page_type}* | Dışa Aktarım: {datetime.now().strftime('%d.%m.%Y %H:%M')}\n\n---\n")
        else:
            lines.append(f"{title}")
            lines.append(f"Kategori: {page.get('category_name', 'Genel')} | Tür: {page_type} | Tarih: {datetime.now().strftime('%d.%m.%Y %H:%M')}")
            lines.append("=" * 40 + "\n")

        if page_type == 'checklist':
            items = db.get_items(page_id)
            for it in items:
                status = "[x]" if it["is_done"] else "[ ]"
                meta_parts = []
                if it.get("quantity"): meta_parts.append(it["quantity"])
                if it.get("price"): meta_parts.append(it["price"])
                meta_str = f" ({', '.join(meta_parts)})" if meta_parts else ""
                lines.append(f"- {status} {it['title']}{meta_str}")

        elif page_type == 'finance':
            entries = db.get_finance_entries(page_id)
            if fmt == 'md':
                lines.append("| Tür | Vade | Başlık / Açıklama | Kategori | Tutar | Durum |")
                lines.append("|:---|:---|:---|:---|---:|:---:|")
                for e in entries:
                    e_type = "Gelir" if e["entry_type"] == 'income' else "Gider"
                    due = e.get("due_date") or f"Gün {e.get('due_day', '-')}"
                    paid = "Ödendi" if e.get("is_paid") else "Bekliyor"
                    lines.append(f"| {e_type} | {due} | {e['title']} | {e.get('category', '')} | {e.get('amount', 0):,.2f} TL | {paid} |")
            else:
                for e in entries:
                    e_type = "Gelir" if e["entry_type"] == 'income' else "Gider"
                    paid = "Ödendi" if e.get("is_paid") else "Bekliyor"
                    lines.append(f"[{e_type}] {e['title']}: {e.get('amount', 0):,.2f} TL ({paid})")

        elif page_type == 'project':
            proj = db.get_project_data(page_id)
            det = proj.get("details") or {}
            if fmt == 'md':
                lines.append(f"### Durum: `{det.get('status', 'planning')}`\n")
                lines.append(f"## 💡 Amaç & Kapsam\n{det.get('concept', 'Not yok.')}\n")
                lines.append(f"## 📐 Teknik Detaylar & Şartname\n{det.get('specs', 'Not yok.')}\n")
                
                lines.append("## ⏳ Aşamalar (Milestones)")
                for m in proj.get("milestones", []):
                    m_status = "✅" if m["status"] == 'completed' else ("⚙️" if m["status"] == 'in_progress' else "⏳")
                    lines.append(f"- {m_status} **{m['title']}** ({m.get('target_date', '')}): {m.get('description', '')}")
                lines.append("")

                lines.append("## 🧰 Malzemeler (BOM)")
                lines.append("| Durum | Malzeme | Miktar | Birim Fiyat | Notlar |")
                lines.append("|:---|:---|---:|---:|:---|")
                for mat in proj.get("materials", []):
                    lines.append(f"| {mat['status']} | {mat['name']} | {mat['quantity']} | {mat['unit_price']} TL | {mat.get('notes', '')} |")
                lines.append("")

                lines.append("## 📋 Proje Notları & Maddeleri")
                items = db.get_items(page_id)
                for it in items:
                    status = "[x]" if it["is_done"] else "[ ]"
                    lines.append(f"- {status} {it['title']}")
                lines.append("")

                lines.append("## 🛠️ Günlük (Logs)")
                for l in proj.get("logs", []):
                    lines.append(f"### {l.get('log_date', '')} — {l['title']}\n{l['content']}\n")
            else:
                lines.append(f"DURUM: {det.get('status', 'planning')}\n")
                lines.append(f"KONSEPT:\n{det.get('concept', '')}\n")
                lines.append(f"ŞARTNAME:\n{det.get('specs', '')}\n")
        else:
            lines.append(page.get('content', ''))

        mimetype = 'text/markdown; charset=utf-8' if fmt == 'md' else 'text/plain; charset=utf-8'
        bio = io.BytesIO("\n".join(lines).encode('utf-8'))
        return send_file(bio, as_attachment=True, download_name=filename, mimetype=mimetype)

# ─────────────────────────────────────────────────────────────────────────────
# YAPAY ZEKA ASİSTANI (TINCAI ASSISTANT)
# ─────────────────────────────────────────────────────────────────────────────

@tnote_bp.route('/api/ai/settings', methods=['GET', 'POST'])
@auth_check
def api_ai_settings():
    if request.method == 'POST':
        data = request.get_json() or {}
        if 'ai_api_key' in data:
            db.set_setting('ai_api_key', data['ai_api_key'].strip())
        if 'ai_provider' in data:
            db.set_setting('ai_provider', data['ai_provider'].strip())
        if 'ai_model' in data:
            db.set_setting('ai_model', data['ai_model'].strip())
        return jsonify({"ok": True, "message": "AI ayarları kaydedildi."})
    else:
        api_key = db.get_setting('ai_api_key', '')
        masked_key = (api_key[:4] + '...' + api_key[-4:]) if len(api_key) > 8 else ('' if not api_key else '****')
        return jsonify({
            "ok": True,
            "has_key": bool(api_key),
            "masked_key": masked_key,
            "ai_provider": db.get_setting('ai_provider', 'gemini'),
            "ai_model": db.get_setting('ai_model', 'gemini-2.0-flash')
        })

@tnote_bp.route('/api/ai/assist', methods=['POST'])
@auth_check
def api_ai_assist():
    data = request.get_json() or {}
    page_id = data.get('page_id')
    action = data.get('action', 'summarize')
    custom_prompt = data.get('prompt', '').strip()

    # Sayfa ve bağlam verisini topla
    context_text = ""
    page_title = "Not"
    if page_id:
        page = db.get_page(page_id)
        if page:
            page_title = page.get('title', 'Not')
            p_type = page.get('type')
            if p_type == 'project':
                proj = db.get_project_data(page_id)
                det = proj.get('details') or {}
                m_list = [f"- {m['title']} ({m['status']}): {m.get('description', '')}" for m in proj.get('milestones', [])]
                bom_list = [f"- {b['name']} ({b['quantity']}x, {b['unit_price']} TL, {b['status']})" for b in proj.get('materials', [])]
                log_list = [f"[{l.get('log_date')} {l['title']}]: {l['content']}" for l in proj.get('logs', [])]
                item_list = [f"- {'[X]' if i['is_done'] else '[ ]'} {i['title']}" for i in db.get_items(page_id)]
                
                context_text = f"""PROJE ADI: {page_title}
DURUM: {det.get('status')}
KONSEPT & AMAÇ:
{det.get('concept', '')}

TEKNİK ŞARTNAME & ÖZELLİKLER:
{det.get('specs', '')}

AŞAMALAR (YOL HARİTASI):
{chr(10).join(m_list)}

MALZEME & BİLEŞENLER (BOM):
{chr(10).join(bom_list)}

GÖREVLER & MADDELER:
{chr(10).join(item_list)}

GÜNLÜK GİRİŞLERİ:
{chr(10).join(log_list)}"""
            elif p_type == 'checklist':
                items = db.get_items(page_id)
                item_str = "\n".join([f"- {'[Tamam]' if it['is_done'] else '[Bekliyor]'} {it['title']} ({it.get('quantity','')}, {it.get('price','')})" for it in items])
                context_text = f"LİSTE ADI: {page_title}\nMADDELER:\n{item_str}"
            elif p_type == 'finance':
                entries = db.get_finance_entries(page_id)
                f_str = "\n".join([f"- {e['entry_type'].upper()}: {e['title']} {e.get('amount')} TL (Ödendi: {e.get('is_paid')})" for e in entries])
                context_text = f"FİNANS TABLOSU: {page_title}\nKALEMLER:\n{f_str}"
            else:
                context_text = f"NOT BAŞLIĞI: {page_title}\nİÇERİK:\n{page.get('content', '')}"

    system_instruction = "Sen TincNote kurumsal ekosisteminde çalışan kıdemli bir Mühendislik ve Verimlilik Asistanısın (TincAI). Yanıtlarını temiz, profesyonel, maddeler halinde ve Türkçe Markdown formatında sun."

    if action == 'summarize':
        prompt = f"Aşağıdaki proje/not içeriğini yönetici özeti şeklinde analiz et. Temel hedefi, ulaşılan aşamayı ve kritik kazanımları 3-4 vurucu maddede özetle:\n\n{context_text}"
    elif action == 'evaluate':
        prompt = f"Aşağıdaki projeyi/notu mühendislik, maliyet, zamanlama ve uygulanabilirlik açısından acımasızca ve objektif olarak değerlendir. Olası darboğazları (riskleri) ve güçlü yönleri sırala:\n\n{context_text}"
    elif action == 'missing_audit':
        prompt = f"Aşağıdaki projeyi/notu derinlemesine incele. Gözden kaçmış olabilecek eksik malzemeleri, yapılmamış güvenlik/test adımlarını ve unutulmuş maddeleri tespit et ve öner:\n\n{context_text}"
    elif action == 'suggest_next':
        prompt = f"Aşağıdaki projenin/notun mevcut durumuna göre derhal atılması gereken en öncelikli 3 sonraki adımı belirle ve eylem planı çıkar:\n\n{context_text}"
    else:
        prompt = f"{custom_prompt}\n\nİlgili İçerik Bağlamı:\n{context_text}"

    # API Anahtarını al (Settings veya ortam değişkeni)
    api_key = db.get_setting('ai_api_key') or os.environ.get('GEMINI_API_KEY') or os.environ.get('OPENAI_API_KEY')
    provider = db.get_setting('ai_provider', 'gemini')
    model = db.get_setting('ai_model', 'gemini-2.0-flash')

    if not api_key:
        fallback_reply = f"""### 💡 TincAI Analizi (Yerel Önizleme)
*Henüz bir AI API Anahtarı tanımlanmadı. Ayarlar sayfasından Gemini veya OpenAI API anahtarınızı kaydederek tam canlı zekayı aktifleştirebilirsiniz.*

**İçerik:** {page_title}
**Ön Değerlendirme:**
- Sistem bağlamı başarıyla okundu ({len(context_text)} karakter).
- İşlem: `{action}` talebi alındı.
- API anahtarınızı `Ayarlar > Yapay Zeka (AI)` sekmesinden tanımladığınızda, doğrudan Google Gemini veya OpenAI modeli üzerinden anlık analizler çalışacaktır.
"""
        return jsonify({"ok": True, "reply": fallback_reply, "live": False})

    # Gemini REST API Çağrısı
    try:
        import urllib.request
        import urllib.error

        if provider == 'gemini' or 'gemini' in model.lower():
            api_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
            payload = {
                "contents": [{"parts": [{"text": f"{system_instruction}\n\n{prompt}"}]}],
                "generationConfig": {"temperature": 0.4, "maxOutputTokens": 1500}
            }
            req = urllib.request.Request(
                api_url,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json'}
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                res_json = json.loads(resp.read().decode('utf-8'))
                reply = res_json['candidates'][0]['content']['parts'][0]['text']
                return jsonify({"ok": True, "reply": reply, "live": True})
        else:
            api_url = "https://api.openai.com/v1/chat/completions"
            payload = {
                "model": model or "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.4
            }
            req = urllib.request.Request(
                api_url,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {api_key}'}
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                res_json = json.loads(resp.read().decode('utf-8'))
                reply = res_json['choices'][0]['message']['content']
                return jsonify({"ok": True, "reply": reply, "live": True})
    except Exception as e:
        return jsonify({
            "ok": True,
            "reply": f"⚠️ **AI İletişim Hatası:** `{str(e)}`\n\nLütfen API anahtarınızın geçerliliğini ve internet bağlantısını kontrol edin.",
            "live": False
        })

# ─────────────────────────────────────────────────────────────────────────────
# REST API: Yazılım Projeleri (TincSync & AI / CLI Agent Entegrasyonlu)
# ─────────────────────────────────────────────────────────────────────────────

def _check_software_access(page_id: int):
    """Kullanıcı oturumu veya proje API anahtarı (X-Agent-Key veya Bearer token) ile erişim doğrular."""
    proj = db.get_software_project(page_id)
    if not proj:
        return False, None
    
    agent_key = request.headers.get("X-Agent-Key")
    if not agent_key:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            agent_key = auth_header.replace("Bearer ", "").strip()
            
    if agent_key and proj.get("api_key") and agent_key == proj.get("api_key"):
        return True, proj
        
    if session.get("authenticated") or get_current_user():
        return True, proj
        
    tinc_pw = os.environ.get("TINC_HUB_PASSWORD", "").strip()
    if tinc_pw and agent_key == tinc_pw:
        return True, proj
        
    return False, None

@tnote_bp.route('/api/software/<int:page_id>', methods=['GET'])
def api_get_software_project(page_id):
    allowed, proj = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    return jsonify({"ok": True, "data": db.get_software_project_full(page_id)})

@tnote_bp.route('/api/software/<int:page_id>', methods=['PUT'])
def api_update_software_project(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    data = request.get_json(silent=True) or {}
    updated = db.update_software_project(
        page_id=page_id,
        repo_name=data.get("repo_name"),
        repo_path=data.get("repo_path"),
        branch=data.get("branch"),
        tech_stack=data.get("tech_stack"),
        api_key=data.get("api_key"),
        system_architecture=data.get("system_architecture")
    )
    return jsonify({"ok": True, "project": updated})

@tnote_bp.route('/api/software/<int:page_id>/agents.md', methods=['GET'])
def api_get_software_agents_md(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return "Unauthorized / Yetkisiz erişim", 401
    md_content = db.generate_agents_markdown(page_id)
    from flask import Response
    return Response(md_content, mimetype='text/markdown; charset=utf-8', headers={
        'Content-Disposition': 'inline; filename=AGENTS.md'
    })

@tnote_bp.route('/api/software/<int:page_id>/context', methods=['GET'])
def api_get_software_context(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    return jsonify({"ok": True, "context": db.get_software_project_full(page_id)})

@tnote_bp.route('/api/software/<int:page_id>/rules', methods=['GET'])
def api_get_software_rules(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    cat = request.args.get("category")
    return jsonify({"ok": True, "rules": db.get_software_rules(page_id, cat)})

@tnote_bp.route('/api/software/<int:page_id>/rules', methods=['POST'])
def api_add_software_rule(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    data = request.get_json(silent=True) or {}
    title = data.get("title", "").strip()
    content = data.get("content", "").strip()
    if not title:
        return jsonify({"ok": False, "error": "Kural başlığı gerekli"}), 400
    rule_id = db.add_software_rule(
        page_id=page_id,
        title=title,
        content=content,
        category=data.get("category", "Architecture"),
        severity=data.get("severity", "MUST"),
        sort_order=data.get("sort_order", 0)
    )
    return jsonify({"ok": True, "id": rule_id, "rules": db.get_software_rules(page_id)})

@tnote_bp.route('/api/software/<int:page_id>/rules/<int:rule_id>', methods=['DELETE'])
def api_delete_software_rule(page_id, rule_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    db.delete_software_rule(rule_id)
    return jsonify({"ok": True, "rules": db.get_software_rules(page_id)})

@tnote_bp.route('/api/software/<int:page_id>/ideas', methods=['GET'])
def api_get_software_ideas(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    status = request.args.get("status")
    return jsonify({"ok": True, "ideas": db.get_software_ideas(page_id, status)})

@tnote_bp.route('/api/software/<int:page_id>/ideas', methods=['POST'])
def api_add_software_idea(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    data = request.get_json(silent=True) or {}
    title = data.get("title", "").strip()
    if not title:
        return jsonify({"ok": False, "error": "Fikir başlığı gerekli"}), 400
    idea_id = db.add_software_idea(
        page_id=page_id,
        title=title,
        description=data.get("description", ""),
        category=data.get("category", "Feature"),
        status=data.get("status", "draft"),
        author=data.get("author", "User")
    )
    return jsonify({"ok": True, "id": idea_id, "ideas": db.get_software_ideas(page_id)})

@tnote_bp.route('/api/software/<int:page_id>/ideas/<int:idea_id>', methods=['PUT'])
def api_update_software_idea(page_id, idea_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    data = request.get_json(silent=True) or {}
    db.update_software_idea(
        idea_id=idea_id,
        title=data.get("title"),
        description=data.get("description"),
        category=data.get("category"),
        status=data.get("status"),
        author=data.get("author"),
        sort_order=data.get("sort_order")
    )
    return jsonify({"ok": True, "ideas": db.get_software_ideas(page_id)})

@tnote_bp.route('/api/software/<int:page_id>/ideas/<int:idea_id>', methods=['DELETE'])
def api_delete_software_idea(page_id, idea_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    db.delete_software_idea(idea_id)
    return jsonify({"ok": True, "ideas": db.get_software_ideas(page_id)})

@tnote_bp.route('/api/software/<int:page_id>/tasks', methods=['GET'])
def api_get_software_tasks(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    status = request.args.get("status")
    return jsonify({"ok": True, "tasks": db.get_software_tasks(page_id, status)})

@tnote_bp.route('/api/software/<int:page_id>/tasks', methods=['POST'])
def api_add_software_task(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    data = request.get_json(silent=True) or {}
    title = data.get("title", "").strip()
    if not title:
        return jsonify({"ok": False, "error": "Görev başlığı gerekli"}), 400
    task_id = db.add_software_task(
        page_id=page_id,
        title=title,
        description=data.get("description", ""),
        status=data.get("status", "todo"),
        priority=data.get("priority", "medium"),
        assigned_agent=data.get("assigned_agent", ""),
        commit_hash=data.get("commit_hash", "")
    )
    return jsonify({"ok": True, "id": task_id, "tasks": db.get_software_tasks(page_id)})

@tnote_bp.route('/api/software/<int:page_id>/tasks/<int:task_id>', methods=['PUT'])
def api_update_software_task(page_id, task_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    data = request.get_json(silent=True) or {}
    db.update_software_task(
        task_id=task_id,
        title=data.get("title"),
        description=data.get("description"),
        status=data.get("status"),
        priority=data.get("priority"),
        assigned_agent=data.get("assigned_agent"),
        commit_hash=data.get("commit_hash"),
        sort_order=data.get("sort_order")
    )
    return jsonify({"ok": True, "tasks": db.get_software_tasks(page_id)})

@tnote_bp.route('/api/software/<int:page_id>/tasks/<int:task_id>', methods=['DELETE'])
def api_delete_software_task(page_id, task_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    db.delete_software_task(task_id)
    return jsonify({"ok": True, "tasks": db.get_software_tasks(page_id)})

@tnote_bp.route('/api/software/<int:page_id>/commits', methods=['GET'])
def api_get_software_commits(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    limit = request.args.get("limit", 30, type=int)
    return jsonify({"ok": True, "commits": db.get_software_commits(page_id, limit)})

@tnote_bp.route('/api/software/<int:page_id>/commits', methods=['POST'])
def api_add_software_commit(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    data = request.get_json(silent=True) or {}
    commit_hash = data.get("commit_hash", "").strip()
    message = data.get("message", "").strip()
    if not commit_hash or not message:
        return jsonify({"ok": False, "error": "Commit hash ve mesajı gereklidir"}), 400
    cid = db.add_software_commit(
        page_id=page_id,
        commit_hash=commit_hash,
        message=message,
        author=data.get("author", ""),
        committed_at=data.get("committed_at", datetime.now().strftime('%Y-%m-%d %H:%M:%S')),
        branch=data.get("branch", "main")
    )
    return jsonify({"ok": True, "id": cid, "commits": db.get_software_commits(page_id)})

@tnote_bp.route('/api/software/<int:page_id>/sync-git', methods=['POST'])
def api_sync_software_git(page_id):
    allowed, _ = _check_software_access(page_id)
    if not allowed:
        return jsonify({"ok": False, "error": "Yetkisiz erişim"}), 401
    data = request.get_json(silent=True) or {}
    repo_path = data.get("repo_path")
    res = db.sync_git_commits(page_id, repo_path)
    return jsonify(res)



