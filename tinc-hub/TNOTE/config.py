import os
from pathlib import Path

# Base directory of TNOTE module
BASE_DIR = Path(__file__).resolve().parent

# Check data storage directory
DATA_DIR = os.environ.get("TNOTE_DATA_DIR")
if not DATA_DIR:
    # Check if /var/lib/tinc-hub is writable/exists
    if os.path.exists("/var/lib/tinc-hub") and os.access("/var/lib/tinc-hub", os.W_OK):
        DATA_DIR = "/var/lib/tinc-hub/tnote"
    else:
        DATA_DIR = str(BASE_DIR / "data")

os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "tnote.db")
UPLOADS_DIR = os.path.join(DATA_DIR, "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)

# Standalone App settings
CONFIG_JSON_PATH = os.path.join(DATA_DIR, "config.json")
def load_app_port():
    if os.path.exists(CONFIG_JSON_PATH):
        try:
            import json
            with open(CONFIG_JSON_PATH, "r") as f:
                cfg = json.load(f)
                if "port" in cfg:
                    return int(cfg["port"])
        except Exception:
            pass
    return int(os.environ.get("TNOTE_PORT", 9013))

DEFAULT_PORT = load_app_port()
DEFAULT_HOST = os.environ.get("TNOTE_HOST", "0.0.0.0")
SECRET_KEY = os.environ.get("TNOTE_SECRET_KEY", "tnote-secret-key-tinc-hub-2026")
