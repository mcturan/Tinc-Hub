import os
import glob
import time
import json
import shutil
import logging
import threading
import subprocess
import configparser
import datetime
import xml.etree.ElementTree as ET
from flask import Blueprint, jsonify, request, session, send_file, Response
from app import auth_required, admin_required

log = logging.getLogger("tinc-hub-packages")

bp = Blueprint('api_packages', __name__, url_prefix='/api/packages')

_CACHE = {
    "timestamp": 0,
    "desktop": [],
    "apt": [],
    "flatpak": [],
    "snap": [],
    "counts": {"desktop": 0, "apt": 0, "flatpak": 0, "snap": 0}
}
_CACHE_LOCK = threading.Lock()
CACHE_TTL = 300  # 5 dakika

MONTHS_TR = ["", "Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"]

PROTECTED_PACKAGES = {
    "tinc-hub", "systemd", "systemd-sysv", "libc6", "bash", "coreutils",
    "sudo", "apt", "dpkg", "login", "passwd", "dbus", "gnome-shell",
    "pardus-common-desktop", "pardus-xfce-desktop", "pardus-gnome-greeter",
    "linux-image-amd64", "init"
}

def _human_size(size_bytes):
    try:
        n = float(size_bytes)
        for unit in ['B', 'KB', 'MB', 'GB']:
            if n < 1024.0:
                return f"{n:.1f} {unit}"
            n /= 1024.0
        return f"{n:.1f} TB"
    except Exception:
        return ""

def _parse_size_to_bytes(size_str):
    if not size_str:
        return 0
    s = str(size_str).replace(",", ".").strip().upper()
    try:
        parts = s.split()
        val = float(parts[0])
        unit = parts[1] if len(parts) > 1 else ""
        if "G" in unit:
            return int(val * 1024 * 1024 * 1024)
        elif "M" in unit:
            return int(val * 1024 * 1024)
        elif "K" in unit:
            return int(val * 1024)
        elif "T" in unit:
            return int(val * 1024 * 1024 * 1024 * 1024)
        return int(val)
    except Exception:
        return 0

def _format_date(ts, is_last_used=False):
    if not ts or ts <= 0:
        return "Henüz kullanılmadı" if is_last_used else "-"
    try:
        dt = datetime.datetime.fromtimestamp(ts)
        now = datetime.datetime.now()
        diff = now - dt
        hm = dt.strftime("%H:%M")
        if diff.days == 0 and dt.day == now.day:
            return "Bugün " + hm
        elif diff.days == 1 or (diff.days == 0 and dt.day == now.day - 1):
            return "Dün " + hm
        else:
            return f"{dt.day} {MONTHS_TR[dt.month]} {dt.year}"
    except Exception:
        return "-"

def _find_icon_path(icon_name):
    if not icon_name:
        return None
    if os.path.isabs(icon_name) and os.path.exists(icon_name):
        return icon_name

    exts = ["", ".png", ".svg", ".xpm"]
    search_dirs = [
        "/usr/share/icons/hicolor/48x48/apps",
        "/usr/share/icons/hicolor/scalable/apps",
        "/usr/share/icons/hicolor/64x64/apps",
        "/usr/share/icons/hicolor/128x128/apps",
        "/usr/share/icons/hicolor/32x32/apps",
        "/usr/share/pixmaps",
        "/var/lib/flatpak/exports/share/icons/hicolor/64x64/apps",
        "/var/lib/flatpak/exports/share/icons/hicolor/scalable/apps"
    ]
    for d in search_dirs:
        if not os.path.exists(d):
            continue
        for ext in exts:
            p = os.path.join(d, icon_name + ext)
            if os.path.exists(p):
                return p
    
    for d in search_dirs:
        if not os.path.exists(d):
            continue
        matches = glob.glob(f"{d}/*{icon_name}*")
        if matches:
            return matches[0]

    return None

def scan_system(force=False):
    global _CACHE
    with _CACHE_LOCK:
        now = time.time()
        if not force and _CACHE["timestamp"] > 0 and (now - _CACHE["timestamp"] < CACHE_TTL):
            return _CACHE

        log.info("PC üzerindeki yüklü uygulamalar taranıyor...")

        # 0. Metadata toplayıcılar (Kurulum ve Son Kullanım Tarihleri)
        dpkg_mtimes = {}
        info_dir = "/var/lib/dpkg/info"
        if os.path.exists(info_dir):
            try:
                with os.scandir(info_dir) as it:
                    for entry in it:
                        if entry.name.endswith(".list"):
                            pkg_name = entry.name[:-5].split(":")[0]
                            try:
                                dpkg_mtimes[pkg_name] = int(entry.stat().st_mtime)
                            except Exception:
                                pass
            except Exception as e:
                log.warning(f"dpkg/info okuma hatası: {e}")

        # GNOME application_state
        gnome_last_seen = {}
        for app_state_path in ["/home/turan/.local/share/gnome-shell/application_state", os.path.expanduser("~/.local/share/gnome-shell/application_state")]:
            if os.path.exists(app_state_path):
                try:
                    tree = ET.parse(app_state_path)
                    for app in tree.findall(".//application"):
                        aid = app.get("id", "")
                        ls = app.get("last-seen")
                        if aid and ls:
                            gnome_last_seen[aid] = int(ls)
                    break
                except Exception:
                    pass

        # recently-used.xbel
        recent_app_times = {}
        for recent_path in ["/home/turan/.local/share/recently-used.xbel", os.path.expanduser("~/.local/share/recently-used.xbel")]:
            if os.path.exists(recent_path):
                try:
                    tree = ET.parse(recent_path)
                    for app in tree.findall(".//{http://www.freedesktop.org/standards/desktop-bookmarks}application"):
                        name = app.get("name", "").lower()
                        mod = app.get("modified", "")
                        if name and mod:
                            try:
                                dt = datetime.datetime.fromisoformat(mod.replace("Z", "+00:00"))
                                ts = int(dt.timestamp())
                                if name not in recent_app_times or ts > recent_app_times[name]:
                                    recent_app_times[name] = ts
                            except Exception:
                                pass
                    break
                except Exception:
                    pass

        # 1. APT paketlerini oku
        apt_packages = []
        apt_map = {}
        try:
            r = subprocess.run(
                ["dpkg-query", "-W", "-f=${Package}\t${Version}\t${Installed-Size}\t${Section}\t${Status}\t${binary:Summary}\n"],
                capture_output=True, text=True, timeout=15
            )
            for line in r.stdout.strip().split("\n"):
                if not line:
                    continue
                parts = line.split("\t")
                if len(parts) >= 6:
                    pkg, ver, size_kb, section, status, summary = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]
                    if "installed" in status:
                        try:
                            size_bytes = int(size_kb) * 1024
                            size_str = _human_size(size_bytes)
                        except Exception:
                            size_bytes = 0
                            size_str = f"{size_kb} KB" if size_kb else ""

                        inst_ts = dpkg_mtimes.get(pkg, 0)
                        last_ts = recent_app_times.get(pkg.lower(), 0)

                        item = {
                            "id": f"apt:{pkg}",
                            "name": pkg,
                            "package": pkg,
                            "version": ver,
                            "size": size_str,
                            "size_bytes": size_bytes,
                            "installed_ts": inst_ts,
                            "installed_str": _format_date(inst_ts),
                            "last_used_ts": last_ts,
                            "last_used_str": _format_date(last_ts, is_last_used=True),
                            "section": section,
                            "summary": summary,
                            "type": "apt",
                            "is_protected": pkg in PROTECTED_PACKAGES
                        }
                        apt_packages.append(item)
                        apt_map[pkg] = item
        except Exception as e:
            log.error(f"APT listesi alınamadı: {e}")

        # 2. Flatpak paketleri
        flatpak_apps = []
        flatpak_map = {}
        try:
            r = subprocess.run(
                ["flatpak", "list", "--app", "--columns=application,name,version,size,description"],
                capture_output=True, text=True, timeout=10
            )
            for line in r.stdout.strip().split("\n"):
                if not line:
                    continue
                parts = line.split("\t")
                if len(parts) >= 2:
                    app_id = parts[0].strip()
                    name = parts[1].strip()
                    ver = parts[2].strip() if len(parts) > 2 else ""
                    size = parts[3].strip() if len(parts) > 3 else ""
                    desc = parts[4].strip() if len(parts) > 4 else ""
                    
                    size_bytes = _parse_size_to_bytes(size)

                    # Directory stat for install date & last used
                    inst_ts = 0
                    last_ts = 0
                    flatpak_dir = f"/var/lib/flatpak/app/{app_id}"
                    if os.path.exists(flatpak_dir):
                        try:
                            st = os.stat(flatpak_dir)
                            inst_ts = int(st.st_mtime)
                            last_ts = int(st.st_atime)
                        except Exception:
                            pass

                    # GNOME usage override if more recent
                    if f"{app_id}.desktop" in gnome_last_seen:
                        last_ts = max(last_ts, gnome_last_seen[f"{app_id}.desktop"])

                    item = {
                        "id": f"flatpak:{app_id}",
                        "name": name or app_id,
                        "package": app_id,
                        "version": ver,
                        "size": size,
                        "size_bytes": size_bytes,
                        "installed_ts": inst_ts,
                        "installed_str": _format_date(inst_ts),
                        "last_used_ts": last_ts,
                        "last_used_str": _format_date(last_ts, is_last_used=True),
                        "section": "Flatpak",
                        "summary": desc,
                        "type": "flatpak",
                        "icon": app_id,
                        "is_protected": False
                    }
                    flatpak_apps.append(item)
                    flatpak_map[app_id] = item
        except Exception as e:
            log.debug(f"Flatpak kontrolü yapılamadı: {e}")

        # 3. Snap paketleri
        snap_apps = []
        snap_map = {}
        try:
            r = subprocess.run(["snap", "list"], capture_output=True, text=True, timeout=10)
            lines = r.stdout.strip().split("\n")
            if len(lines) > 1:
                for line in lines[1:]:
                    parts = line.split()
                    if len(parts) >= 2:
                        s_name = parts[0]
                        s_ver = parts[1]
                        notes = parts[-1] if len(parts) >= 5 else ""

                        size_bytes = 0
                        inst_ts = 0
                        last_ts = 0

                        # Check snap files in /var/lib/snapd/snaps/
                        snap_files = glob.glob(f"/var/lib/snapd/snaps/{s_name}_*.snap")
                        if snap_files:
                            try:
                                latest_snap = max(snap_files, key=os.path.getmtime)
                                st = os.stat(latest_snap)
                                size_bytes = st.st_size
                                inst_ts = int(st.st_mtime)
                                last_ts = int(st.st_atime)
                            except Exception:
                                pass

                        size_str = _human_size(size_bytes) if size_bytes > 0 else ""

                        item = {
                            "id": f"snap:{s_name}",
                            "name": s_name,
                            "package": s_name,
                            "version": s_ver,
                            "size": size_str,
                            "size_bytes": size_bytes,
                            "installed_ts": inst_ts,
                            "installed_str": _format_date(inst_ts),
                            "last_used_ts": last_ts,
                            "last_used_str": _format_date(last_ts, is_last_used=True),
                            "section": "Snap",
                            "summary": f"Snap paketi ({notes})" if notes else "Snap paketi",
                            "type": "snap",
                            "icon": s_name,
                            "is_protected": s_name in ["snapd", "core20", "core22", "core24", "bare"]
                        }
                        snap_apps.append(item)
                        snap_map[s_name] = item
        except Exception as e:
            log.debug(f"Snap listesi alınamadı: {e}")

        # 4. Masaüstü (.desktop) Uygulamaları
        desktop_dirs = [
            "/usr/share/applications",
            "/var/lib/flatpak/exports/share/applications",
            "/var/lib/snapd/desktop/applications",
            os.path.expanduser("~/.local/share/applications")
        ]

        dpkg_desktop_map = {}
        try:
            r = subprocess.run("dpkg -S /usr/share/applications/*.desktop 2>/dev/null", shell=True, capture_output=True, text=True, timeout=10)
            for line in r.stdout.strip().split("\n"):
                if ": " in line:
                    p_name, f_path = line.split(": ", 1)
                    dpkg_desktop_map[f_path.strip()] = p_name.strip()
        except Exception:
            pass

        desktop_apps = []
        seen_names = set()

        for d in desktop_dirs:
            if not os.path.exists(d):
                continue
            for f in glob.glob(d + "/**/*.desktop", recursive=True):
                basename = os.path.basename(f)
                cp = configparser.ConfigParser(interpolation=None, strict=False)
                try:
                    cp.read(f, encoding="utf-8")
                    if not cp.has_section("Desktop Entry"):
                        continue
                    entry = cp["Desktop Entry"]
                    if entry.getboolean("NoDisplay", fallback=False):
                        continue
                    name = entry.get("Name", "").strip()
                    if not name or name in seen_names:
                        continue

                    comment = entry.get("Comment", "").strip() or entry.get("GenericName", "").strip()
                    icon = entry.get("Icon", "").strip()
                    exec_cmd = entry.get("Exec", "").strip()
                    categories = entry.get("Categories", "").strip()

                    pkg_type = "apt"
                    pkg_name = ""
                    version = ""
                    size = ""
                    size_bytes = 0
                    inst_ts = 0
                    last_ts = 0

                    if "flatpak" in f:
                        pkg_type = "flatpak"
                        pkg_name = basename.replace(".desktop", "")
                        if pkg_name in flatpak_map:
                            version = flatpak_map[pkg_name]["version"]
                            size = flatpak_map[pkg_name]["size"]
                            size_bytes = flatpak_map[pkg_name]["size_bytes"]
                            inst_ts = flatpak_map[pkg_name]["installed_ts"]
                            last_ts = flatpak_map[pkg_name]["last_used_ts"]
                            if not comment:
                                comment = flatpak_map[pkg_name]["summary"]
                    elif "snap" in f:
                        pkg_type = "snap"
                        pkg_name = basename.split("_")[0].replace(".desktop", "")
                        if pkg_name in snap_map:
                            version = snap_map[pkg_name]["version"]
                            size = snap_map[pkg_name]["size"]
                            size_bytes = snap_map[pkg_name]["size_bytes"]
                            inst_ts = snap_map[pkg_name]["installed_ts"]
                            last_ts = snap_map[pkg_name]["last_used_ts"]
                    else:
                        pkg_type = "apt"
                        pkg_name = dpkg_desktop_map.get(f, "")
                        if not pkg_name:
                            pkg_name = basename.replace(".desktop", "")
                        if pkg_name in apt_map:
                            version = apt_map[pkg_name]["version"]
                            size = apt_map[pkg_name]["size"]
                            size_bytes = apt_map[pkg_name]["size_bytes"]
                            inst_ts = apt_map[pkg_name]["installed_ts"]
                            last_ts = apt_map[pkg_name]["last_used_ts"]
                            if not comment:
                                comment = apt_map[pkg_name]["summary"]

                    # Last used resolution
                    if basename in gnome_last_seen:
                        last_ts = max(last_ts, gnome_last_seen[basename])
                    
                    # Try binary atime
                    if exec_cmd:
                        cmd_clean = exec_cmd.split()[0]
                        bin_path = shutil.which(cmd_clean)
                        if bin_path and os.path.exists(bin_path):
                            try:
                                bst = os.stat(bin_path)
                                last_ts = max(last_ts, int(bst.st_atime))
                            except Exception:
                                pass

                    # If inst_ts not found, fallback to desktop file mtime
                    if inst_ts <= 0:
                        try:
                            inst_ts = int(os.stat(f).st_mtime)
                        except Exception:
                            pass

                    # Category clean
                    cat_display = "Diğer"
                    cats = categories.upper()
                    if "OFFICE" in cats: cat_display = "Ofis"
                    elif "AUDIO" in cats or "VIDEO" in cats or "PLAYER" in cats: cat_display = "Medya / Ses"
                    elif "NETWORK" in cats or "WEB" in cats: cat_display = "İnternet"
                    elif "GRAPHICS" in cats: cat_display = "Grafik / Tasarım"
                    elif "DEVELOPMENT" in cats: cat_display = "Geliştirme"
                    elif "SYSTEM" in cats: cat_display = "Sistem"
                    elif "UTILITY" in cats: cat_display = "Araçlar"
                    elif "GAME" in cats: cat_display = "Oyun"

                    desktop_apps.append({
                        "id": f"{pkg_type}:{pkg_name or basename}",
                        "name": name,
                        "package": pkg_name,
                        "version": version,
                        "size": size,
                        "size_bytes": size_bytes,
                        "installed_ts": inst_ts,
                        "installed_str": _format_date(inst_ts),
                        "last_used_ts": last_ts,
                        "last_used_str": _format_date(last_ts, is_last_used=True),
                        "category": cat_display,
                        "comment": comment,
                        "icon": icon,
                        "exec": exec_cmd,
                        "type": pkg_type,
                        "is_protected": pkg_name in PROTECTED_PACKAGES
                    })
                    seen_names.add(name)
                except Exception:
                    pass

        desktop_apps.sort(key=lambda x: x["name"].lower())

        _CACHE = {
            "timestamp": now,
            "desktop": desktop_apps,
            "apt": apt_packages,
            "flatpak": flatpak_apps,
            "snap": snap_apps,
            "counts": {
                "desktop": len(desktop_apps),
                "apt": len(apt_packages),
                "flatpak": len(flatpak_apps),
                "snap": len(snap_apps)
            }
        }
        log.info(f"Tarama tamamlandı: {len(desktop_apps)} masaüstü, {len(apt_packages)} APT, {len(flatpak_apps)} Flatpak, {len(snap_apps)} Snap.")
        return _CACHE

def sort_items(items, sort_by):
    if not sort_by or sort_by == "name_asc":
        return sorted(items, key=lambda x: x.get("name", "").lower())
    elif sort_by == "name_desc":
        return sorted(items, key=lambda x: x.get("name", "").lower(), reverse=True)
    elif sort_by == "size_desc":
        return sorted(items, key=lambda x: x.get("size_bytes", 0), reverse=True)
    elif sort_by == "size_asc":
        return sorted(items, key=lambda x: (x.get("size_bytes", 0) == 0, x.get("size_bytes", 0)))
    elif sort_by == "installed_desc":
        return sorted(items, key=lambda x: x.get("installed_ts", 0), reverse=True)
    elif sort_by == "installed_asc":
        return sorted(items, key=lambda x: (x.get("installed_ts", 0) == 0, x.get("installed_ts", 0)))
    elif sort_by == "last_used":
        return sorted(items, key=lambda x: x.get("last_used_ts", 0), reverse=True)
    return items

@bp.route("/list", methods=["GET"])
@auth_required
def api_packages_list():
    pkg_type = request.args.get("type", "desktop")  # desktop, apt, flatpak, snap
    search = request.args.get("q", "").strip().lower()
    page = int(request.args.get("page", 1))
    limit = int(request.args.get("limit", 50))
    category = request.args.get("category", "")
    sort_by = request.args.get("sort", "size_desc" if pkg_type != "desktop" else "last_used")

    cache = scan_system()

    if pkg_type == "desktop":
        items = cache["desktop"]
    elif pkg_type == "flatpak":
        items = cache["flatpak"]
    elif pkg_type == "snap":
        items = cache["snap"]
    else:
        items = cache["apt"]

    if category and pkg_type == "desktop":
        items = [x for x in items if x.get("category") == category]

    if search:
        items = [
            x for x in items if (
                search in x.get("name", "").lower() or
                search in x.get("package", "").lower() or
                search in x.get("summary", "").lower() or
                search in x.get("comment", "").lower()
            )
        ]

    # Sıralama
    items = sort_items(items, sort_by)

    total = len(items)
    if limit > 0:
        start = (page - 1) * limit
        end = start + limit
        paginated = items[start:end]
    else:
        paginated = items

    return jsonify({
        "ok": True,
        "type": pkg_type,
        "sort": sort_by,
        "total": total,
        "page": page,
        "limit": limit,
        "items": paginated,
        "counts": cache["counts"]
    })

@bp.route("/refresh", methods=["POST", "GET"])
@auth_required
def api_packages_refresh():
    cache = scan_system(force=True)
    return jsonify({
        "ok": True,
        "message": "Sistem başarıyla tarandı.",
        "counts": cache["counts"]
    })

@bp.route("/icon/<path:icon_name>", methods=["GET"])
def api_packages_icon(icon_name):
    icon_clean = os.path.basename(icon_name)
    icon_path = _find_icon_path(icon_clean)
    if icon_path and os.path.exists(icon_path):
        mimetype = "image/png"
        if icon_path.endswith(".svg"):
            mimetype = "image/svg+xml"
        elif icon_path.endswith(".xpm"):
            mimetype = "image/x-xpixmap"
        return send_file(icon_path, mimetype=mimetype)
    
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
      <rect width="48" height="48" rx="10" fill="#3b82f6" />
      <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-size="20" font-family="sans-serif" font-weight="bold">
        {icon_clean[:1].upper() if icon_clean else '📦'}
      </text>
    </svg>"""
    return Response(svg, mimetype="image/svg+xml")

@bp.route("/action", methods=["POST"])
@admin_required
def api_packages_action():
    data = request.get_json() or {}
    pkg = data.get("package", "").strip()
    pkg_type = data.get("type", "apt").strip()
    action = data.get("action", "").strip()

    if not pkg:
        return jsonify({"ok": False, "error": "Paket adı belirtilmedi."}), 400

    if action not in ["upgrade", "reinstall", "uninstall"]:
        return jsonify({"ok": False, "error": f"Geçersiz eylem: {action}"}), 400

    if action == "uninstall" and pkg in PROTECTED_PACKAGES:
        return jsonify({
            "ok": False,
            "error": f"Güvenlik Koruması: '{pkg}' kritik bir sistem bileşenidir ve kaldırılamaz!"
        }), 403

    log.info(f"Paket İşlemi: {action.upper()} -> {pkg} ({pkg_type})")

    cmd = []
    if pkg_type == "apt":
        if action == "upgrade":
            cmd = ["apt-get", "install", "--only-upgrade", "-y", pkg]
        elif action == "reinstall":
            cmd = ["apt-get", "install", "--reinstall", "-y", pkg]
        elif action == "uninstall":
            cmd = ["apt-get", "remove", "-y", pkg]
    elif pkg_type == "flatpak":
        if action == "upgrade":
            cmd = ["flatpak", "update", "-y", pkg]
        elif action == "reinstall":
            cmd = ["flatpak", "install", "--reinstall", "-y", pkg]
        elif action == "uninstall":
            cmd = ["flatpak", "uninstall", "-y", pkg]
    elif pkg_type == "snap":
        if action == "upgrade" or action == "reinstall":
            cmd = ["snap", "refresh", pkg]
        elif action == "uninstall":
            cmd = ["snap", "remove", pkg]

    if not cmd:
        return jsonify({"ok": False, "error": f"Desteklenmeyen paket tipi: {pkg_type}"}), 400

    try:
        env = os.environ.copy()
        env["DEBIAN_FRONTEND"] = "noninteractive"
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            env=env
        )
        ok = (r.returncode == 0)
        output = (r.stdout + "\n" + r.stderr).strip()

        scan_system(force=True)

        return jsonify({
            "ok": ok,
            "returncode": r.returncode,
            "output": output,
            "message": f"'{pkg}' işlemi {'başarıyla tamamlandı' if ok else 'hata ile sonuçlandı'}."
        })
    except subprocess.TimeoutExpired:
        return jsonify({
            "ok": False,
            "error": "İşlem zaman aşımına uğradı (120 saniye). Arka planda devam ediyor olabilir."
        }), 408
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
