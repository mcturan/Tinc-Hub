#!/usr/bin/env python3
"""
TNOTE — Standalone Application Runner
Bu dosya Tinc-Hub olmadan bağımsız bir mikroservis / web uygulaması olarak çalıştırmak içindir.
Kullanım: python app.py
"""

import os
import sys
import logging

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(BASE_DIR)
for p in [BASE_DIR, PARENT_DIR]:
    if p not in sys.path:
        sys.path.insert(0, p)

from flask import Flask, redirect, session

try:
    from TNOTE.config import DEFAULT_PORT, DEFAULT_HOST, SECRET_KEY
    from TNOTE import db
    from TNOTE.blueprint import tnote_bp
    from TNOTE.telegram_bot import start_telegram_bot
    from TNOTE.reminder_engine import start_reminder_engine
except ImportError:
    from config import DEFAULT_PORT, DEFAULT_HOST, SECRET_KEY
    import db
    from blueprint import tnote_bp
    from telegram_bot import start_telegram_bot
    from reminder_engine import start_reminder_engine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [TNOTE] %(levelname)s %(message)s"
)
log = logging.getLogger("tnote-standalone")

def create_app():
    app = Flask(__name__)
    app.secret_key = SECRET_KEY

    # Veritabanını hazırla
    db.init_db()

    # Blueprint'i /notes dizinine bağla
    app.register_blueprint(tnote_bp, url_prefix="/notes")

    @app.before_request
    def set_standalone():
        session["is_standalone"] = True

    @app.route("/")
    def root_redirect():
        return redirect("/notes")

    return app

if __name__ == "__main__":
    log.info("TNOTE Bağımsız Modda Başlatılıyor...")
    db.init_db()

    # Telegram bot ve Hatırlatıcı motorunu başlat
    if db.get_setting("telegram_enabled", "0") == "1":
        start_telegram_bot()
    start_reminder_engine()

    app = create_app()
    log.info(f"TNOTE Çalışıyor: http://{DEFAULT_HOST}:{DEFAULT_PORT}/notes")
    app.run(host=DEFAULT_HOST, port=DEFAULT_PORT, debug=False)
