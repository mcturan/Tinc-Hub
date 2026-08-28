"""
Tinc Hub — Ortak Veritabanı Katmanı
Tüm agent'lar bu modülü kullanarak tinc-hub.db'ye yazar.
"""

import sqlite3
import os
import json
import threading
from datetime import datetime

DB_PATH = os.environ.get("TINC_HUB_DB_PATH", "/var/lib/tinc-hub/tinc-hub.db")
_lock = threading.Lock()


def get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Tüm tabloları oluştur (idempotent)."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with _lock:
        conn = get_conn()
        conn.executescript("""
            -- Agent kayıt tablosu
            CREATE TABLE IF NOT EXISTS agents (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                description TEXT,
                version     TEXT DEFAULT '1.0.0',
                enabled     INTEGER DEFAULT 1,
                installed_at TEXT DEFAULT (datetime('now')),
                last_seen   TEXT,
                status      TEXT DEFAULT 'unknown'
            );

            -- Olaylar / loglar
            CREATE TABLE IF NOT EXISTS events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id    TEXT NOT NULL,
                level       TEXT NOT NULL,  -- INFO, WARN, ERROR, CRITICAL
                category    TEXT,           -- network, disk, memory, service, security
                message     TEXT NOT NULL,
                data        TEXT,           -- JSON ek veri
                created_at  TEXT DEFAULT (datetime('now'))
            );

            -- Metrikler (zaman serisi)
            CREATE TABLE IF NOT EXISTS metrics (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id    TEXT NOT NULL,
                metric      TEXT NOT NULL,  -- disk_percent, ram_percent, wan_ip, ...
                value       REAL,
                value_str   TEXT,
                created_at  TEXT DEFAULT (datetime('now'))
            );

            -- Raporlar (periyodik özetler)
            CREATE TABLE IF NOT EXISTS reports (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id    TEXT NOT NULL,
                report_type TEXT NOT NULL,  -- hourly, daily, weekly
                title       TEXT,
                content     TEXT,           -- JSON veya HTML
                created_at  TEXT DEFAULT (datetime('now'))
            );

            -- Sistemdeki servis durumları
            CREATE TABLE IF NOT EXISTS service_states (
                service     TEXT PRIMARY KEY,
                status      TEXT,
                since       TEXT,
                restart_count INTEGER DEFAULT 0,
                last_checked TEXT
            );

            -- WAN IP geçmişi
            CREATE TABLE IF NOT EXISTS wan_history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ip          TEXT NOT NULL,
                detected_at TEXT DEFAULT (datetime('now'))
            );

            -- İndeksler
            CREATE INDEX IF NOT EXISTS idx_events_agent    ON events(agent_id);
            CREATE INDEX IF NOT EXISTS idx_events_level    ON events(level);
            CREATE INDEX IF NOT EXISTS idx_events_created  ON events(created_at);
            CREATE INDEX IF NOT EXISTS idx_metrics_agent   ON metrics(agent_id);
            CREATE INDEX IF NOT EXISTS idx_metrics_metric  ON metrics(metric);
            CREATE INDEX IF NOT EXISTS idx_metrics_created ON metrics(created_at);
        """)
        conn.commit()
        conn.close()


def register_agent(agent_id: str, name: str = "", description: str = "", version: str = "1.0.0"):
    """Agent kendini DB'ye kaydeder."""
    name = name or agent_id
    description = description or f"{agent_id} agent"
    with _lock:
        conn = get_conn()
        conn.execute("""
            INSERT INTO agents (id, name, description, version, last_seen, status)
            VALUES (?, ?, ?, ?, datetime('now'), 'running')
            ON CONFLICT(id) DO UPDATE SET
                last_seen = datetime('now'),
                status = 'running',
                version = excluded.version
        """, (agent_id, name, description, version))
        conn.commit()
        conn.close()


def heartbeat(agent_id: str, status: str = "running"):
    """Agent'ın yaşadığını bildir."""
    with _lock:
        conn = get_conn()
        conn.execute("""
            UPDATE agents SET last_seen = datetime('now'), status = ?
            WHERE id = ?
        """, (status, agent_id))
        conn.commit()
        conn.close()


def log_event(agent_id: str, level: str, message: str,
              category: str = None, data: dict = None):
    """Olay / log yaz."""
    with _lock:
        conn = get_conn()
        conn.execute("""
            INSERT INTO events (agent_id, level, category, message, data)
            VALUES (?, ?, ?, ?, ?)
        """, (agent_id, level.upper(), category, message,
               json.dumps(data) if data else None))
        conn.commit()
        conn.close()


def write_metric(agent_id: str, metric: str, value=None, value_str: str = None):
    """Sayısal veya string metrik yaz."""
    with _lock:
        conn = get_conn()
        conn.execute("""
            INSERT INTO metrics (agent_id, metric, value, value_str)
            VALUES (?, ?, ?, ?)
        """, (agent_id, metric, value, value_str))
        conn.commit()
        conn.close()


def get_latest_metric(agent_id: str, metric: str):
    """Bir agent'ın son metrik değerini oku."""
    conn = get_conn()
    row = conn.execute("""
        SELECT value, value_str, created_at FROM metrics
        WHERE agent_id = ? AND metric = ?
        ORDER BY created_at DESC LIMIT 1
    """, (agent_id, metric)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_recent_events(agent_id: str = None, level: str = None,
                      limit: int = 100, hours: int = 24):
    """Son olayları oku."""
    conn = get_conn()
    query = """
        SELECT e.*, a.name as agent_name
        FROM events e LEFT JOIN agents a ON e.agent_id = a.id
        WHERE e.created_at >= datetime('now', ? )
    """
    params = [f'-{hours} hours']
    if agent_id:
        query += " AND e.agent_id = ?"
        params.append(agent_id)
    if level:
        query += " AND e.level = ?"
        params.append(level.upper())
    query += " ORDER BY e.created_at DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_agents():
    """Tüm kayıtlı agent'ları listele."""
    conn = get_conn()
    rows = conn.execute("SELECT * FROM agents ORDER BY name").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_metrics_series(agent_id: str, metric: str, hours: int = 24, limit: int = 200):
    """Bir metriğin zaman serisi verisini oku."""
    conn = get_conn()
    rows = conn.execute("""
        SELECT value, value_str, created_at FROM metrics
        WHERE agent_id = ? AND metric = ?
          AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC LIMIT ?
    """, (agent_id, metric, f'-{hours} hours', limit)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_service_state(service: str, status: str, since: str = None,
                         increment_restart: bool = False):
    """Servis durumunu güncelle."""
    with _lock:
        conn = get_conn()
        if increment_restart:
            conn.execute("""
                INSERT INTO service_states (service, status, since, restart_count, last_checked)
                VALUES (?, ?, ?, 1, datetime('now'))
                ON CONFLICT(service) DO UPDATE SET
                    status = excluded.status,
                    since = excluded.since,
                    restart_count = service_states.restart_count + 1,
                    last_checked = datetime('now')
            """, (service, status, since))
        else:
            conn.execute("""
                INSERT INTO service_states (service, status, since, last_checked)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(service) DO UPDATE SET
                    status = excluded.status,
                    since = excluded.since,
                    last_checked = datetime('now')
            """, (service, status, since))
        conn.commit()
        conn.close()


def record_wan_ip(ip: str):
    """WAN IP değişikliğini kaydet."""
    with _lock:
        conn = get_conn()
        # Sadece değişmişse kaydet
        last = conn.execute(
            "SELECT ip FROM wan_history ORDER BY detected_at DESC LIMIT 1"
        ).fetchone()
        if not last or last["ip"] != ip:
            conn.execute(
                "INSERT INTO wan_history (ip) VALUES (?)", (ip,)
            )
            conn.commit()
            changed = True
        else:
            changed = False
        conn.close()
        return changed


def get_wan_history(limit: int = 50):
    conn = get_conn()
    rows = conn.execute(
        "SELECT ip, detected_at FROM wan_history ORDER BY detected_at DESC LIMIT ?",
        (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


if __name__ == "__main__":
    init_db()
    print(f"DB initialized: {DB_PATH}")
