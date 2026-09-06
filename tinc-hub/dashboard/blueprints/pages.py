from flask import Blueprint, render_template, jsonify, request, redirect, url_for, session, Response, stream_with_context
from app import *
from blueprints.api_system import _system_summary
from blueprints.api_system import _now
from blueprints.auth import _format_uptime, _ver_to_int, MOBILE_REQUIRED_VERSION
from blueprints.auth import _enrich_apps
from blueprints.auth import _get_discovery

bp = Blueprint('pages', __name__)

@bp.route("/")
@auth_required
def index():
    # Mobil uygulama versiyon kontrolü
    app_ver = request.args.get("app_version")
    if app_ver and _ver_to_int(app_ver) < _ver_to_int(MOBILE_REQUIRED_VERSION):
        return render_template("mobile_update.html", required=MOBILE_REQUIRED_VERSION, current=app_ver)

    all_apps = load_apps()
    enriched = _enrich_apps(all_apps)
    
    cat_filter = request.args.get("cat", "")
    categories = get_categories()
    
    if cat_filter:
        display_apps = [a for a in enriched if a.get("category") == cat_filter]
        pinned = []
        unpinned = []
    else:
        display_apps = []
        pinned = [a for a in enriched if a.get("pinned")]
        unpinned = [a for a in enriched if not a.get("pinned")]
        display_apps.sort(key=lambda a: (a.get('id') != 'tinc-hub', a.get('name', '')))
        pinned.sort(key=lambda a: (a.get('id') != 'tinc-hub', a.get('name', '')))
        unpinned.sort(key=lambda a: (a.get('id') != 'tinc-hub', a.get('name', '')))
        
    disc = _get_discovery()
    docker = disc.get("docker", [])
    known_services = {a.get("service") for a in all_apps if a.get("service")}
    unknown_services = [s for s in disc.get("services", []) if s["name"] not in known_services]
    
    system = _system_summary()
    
    hub_id = os.environ.get("HUB_ID", "UNKNOWN")
    api_token = os.environ.get("API_TOKEN", "")

    try:
        from plugin_manager import plugin_manager
        if plugin_manager:
            plugin_widgets = plugin_manager.get_all_widgets()
        else:
            plugin_widgets = []
    except Exception:
        plugin_widgets = []

    return render_template("hub.html",
        apps=display_apps,
        pinned=pinned, 
        unpinned=unpinned,
        categories=categories,
        selected_cat=cat_filter,
        docker=docker,
        unknown_services=unknown_services,
        system=system, 
        plugin_widgets=plugin_widgets,
        now=_now(),
        format_uptime=_format_uptime,
        has_auth=bool(PASSWORD),
        hub_id=hub_id,
        role=session.get("role", "admin"), api_token=api_token, tg_token=os.environ.get("TELEGRAM_BOT_TOKEN", ""), tg_chat=os.environ.get("TELEGRAM_CHAT_ID", ""))



@bp.route("/app/<app_id>")
@auth_required
def app_detail(app_id):
    app_data = get_app(app_id)
    if not app_data:
        return "Uygulama bulunamadı", 404
    enriched = _enrich_apps([app_data])[0]
    # Anlık health check
    health = check_app(app_data)
    enriched["health"] = health
    return render_template("app_detail.html",
        app=enriched, now=_now(), format_uptime=_format_uptime)



@bp.route("/logs")
@auth_required
def logs_page():
    apps = load_apps()
    services = [a for a in apps if a.get("service")]
    selected = request.args.get("service", "")
    # Systemd discovery'den de servis ekle
    disc = _get_discovery()
    disc_services = [s["name"] for s in disc.get("services", [])]
    return render_template("logs.html",
        services=services, disc_services=disc_services,
        selected=selected, now=_now())



@bp.route("/settings")
@auth_required
def settings_page():
    apps = load_apps()
    categories = get_categories()
    return render_template("settings.html",
        apps=apps, categories=categories, now=_now(),
        has_auth=bool(PASSWORD))


# ── API: Uygulamalar ─────────────────────────────────────────────────────────


@bp.route("/rules")
@auth_required
def rules_page():
    return render_template("rules.html", now=_now(), has_auth=bool(PASSWORD))

@bp.route("/terminal")
@auth_required
def terminal_page():
    service = request.args.get("service", "")
    return render_template("terminal.html", now=_now(), has_auth=bool(PASSWORD), service=service)

@bp.route("/network")
@auth_required
def network_page():
    return render_template("network.html", now=_now(), has_auth=bool(PASSWORD))

@bp.route("/multi")
@auth_required
def multi_page():
    return render_template("multi_hub.html", now=_now(), has_auth=bool(PASSWORD))

