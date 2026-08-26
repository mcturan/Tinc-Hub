import json
import os
import hashlib

USERS_FILE = "/etc/tinc-hub/users.json"

def get_hash(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def init_users(default_password: str):
    if not os.path.exists("/etc/tinc-hub"):
        os.makedirs("/etc/tinc-hub", exist_ok=True)
        
    if not os.path.exists(USERS_FILE):
        # Default users
        pw_hash = get_hash(default_password) if default_password else ""
        default_users = {
            "admin": {"password": pw_hash, "role": "admin"},
            "misafir": {"password": get_hash("1234"), "role": "viewer"}
        }
        with open(USERS_FILE, "w") as f:
            json.dump(default_users, f, indent=4)

def load_users() -> dict:
    if os.path.exists(USERS_FILE):
        try:
            with open(USERS_FILE, "r") as f:
                return json.load(f)
        except:
            return {}
    return {}

def verify_user(username, password) -> dict:
    users = load_users()
    u = users.get(username)
    if u and u.get("password") == get_hash(password):
        return u
    return None
