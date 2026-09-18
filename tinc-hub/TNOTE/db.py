import sqlite3
import os
import json
import base64
import hashlib
import threading
from datetime import datetime
from .config import DB_PATH, DATA_DIR, SECRET_KEY

_lock = threading.Lock()
_vault_cipher = None

def _get_vault_cipher():
    global _vault_cipher
    if _vault_cipher is None:
        try:
            from cryptography.fernet import Fernet
            key_file = os.path.join(DATA_DIR, "vault.key")
            if os.path.exists(key_file):
                with open(key_file, "rb") as f:
                    key = f.read().strip()
            else:
                derived = hashlib.sha256((SECRET_KEY + "_tnote_vault_salt_2026").encode()).digest()
                key = base64.urlsafe_b64encode(derived)
                try:
                    with open(key_file, "wb") as f:
                        f.write(key)
                except Exception:
                    pass
            _vault_cipher = Fernet(key)
        except Exception:
            _vault_cipher = None
    return _vault_cipher

def encrypt_vault_secret(plain_text: str) -> str:
    if not plain_text:
        return ""
    cipher = _get_vault_cipher()
    if not cipher:
        return plain_text
    try:
        token = cipher.encrypt(plain_text.encode('utf-8'))
        return "enc::" + token.decode('utf-8')
    except Exception:
        return plain_text

def decrypt_vault_secret(cipher_text: str) -> str:
    if not cipher_text:
        return ""
    if not str(cipher_text).startswith("enc::"):
        return str(cipher_text)
    cipher = _get_vault_cipher()
    if not cipher:
        return str(cipher_text)
    try:
        raw_token = cipher_text[5:].encode('utf-8')
        return cipher.decrypt(raw_token).decode('utf-8')
    except Exception:
        return "[Şifre Çözülemedi]"

def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with _lock:
        conn = get_conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS notebooks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                icon TEXT DEFAULT '📓',
                color TEXT DEFAULT '#3b82f6',
                description TEXT DEFAULT '',
                is_default INTEGER DEFAULT 0,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                notebook_id INTEGER DEFAULT 1,
                name TEXT NOT NULL,
                icon TEXT DEFAULT '📁',
                color TEXT DEFAULT '#3b82f6',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (notebook_id) REFERENCES notebooks (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS pages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER,
                title TEXT NOT NULL,
                type TEXT DEFAULT 'checklist', -- 'checklist' or 'notes'
                icon TEXT DEFAULT '📝',
                content TEXT DEFAULT '',
                sort_order INTEGER DEFAULT 0,
                is_archived INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                page_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                url TEXT DEFAULT '',
                image_url TEXT DEFAULT '',
                price TEXT DEFAULT '',
                quantity TEXT DEFAULT '',
                is_done INTEGER DEFAULT 0,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_type TEXT NOT NULL, -- 'item' or 'page'
                target_id INTEGER NOT NULL,
                remind_at TEXT NOT NULL, -- YYYY-MM-DD HH:MM:SS
                recurrence TEXT DEFAULT 'none', -- 'none', 'daily', 'weekly', 'monthly'
                is_sent INTEGER DEFAULT 0,
                sent_at TEXT,
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS telegram_users (
                chat_id TEXT PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                is_allowed INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                last_seen TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE TABLE IF NOT EXISTS finance_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                page_id INTEGER NOT NULL,
                entry_type TEXT NOT NULL, -- 'income' (gelir) or 'expense' (gider)
                title TEXT NOT NULL,
                category TEXT DEFAULT 'Genel',
                amount REAL NOT NULL DEFAULT 0.0,
                due_day INTEGER DEFAULT 1,
                due_date TEXT,
                is_recurring INTEGER DEFAULT 1,
                end_period TEXT DEFAULT '', -- 'YYYY-MM' (ne zamana kadar?)
                reminder_days INTEGER DEFAULT 0, -- Vadeden kaç gün önce (0=aynı gün, -1=kapalı)
                reminder_time TEXT DEFAULT '09:00',
                is_reminder_sent INTEGER DEFAULT 0,
                is_paid INTEGER DEFAULT 0,
                paid_at TEXT,
                notes TEXT DEFAULT '',
                period TEXT NOT NULL, -- 'YYYY-MM'
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
            );

            -- Proje Yönetim & İnşa / Atölye Tabloları
            CREATE TABLE IF NOT EXISTS project_details (
                page_id INTEGER PRIMARY KEY,
                concept TEXT DEFAULT '',
                specs TEXT DEFAULT '',
                status TEXT DEFAULT 'planning', -- 'planning', 'in_progress', 'testing', 'completed'
                drawings TEXT DEFAULT '[]',     -- JSON array of {id, title, url, desc, created_at}
                updated_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS project_milestones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                page_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                target_date TEXT DEFAULT '',
                status TEXT DEFAULT 'pending', -- 'pending', 'in_progress', 'completed'
                description TEXT DEFAULT '',
                requirements TEXT DEFAULT '',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS project_materials (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                page_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                quantity TEXT DEFAULT '1',
                unit_price REAL DEFAULT 0.0,
                status TEXT DEFAULT 'needed', -- 'needed', 'ordered', 'available'
                url TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS project_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                page_id INTEGER NOT NULL,
                log_date TEXT DEFAULT (datetime('now', 'localtime')),
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                log_type TEXT DEFAULT 'progress', -- 'progress', 'issue', 'solution', 'milestone'
                image_url TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
            );

            -- Yazılım Projeleri Yönetimi (TincSync & AI / CLI Agent Entegrasyonlu)
            CREATE TABLE IF NOT EXISTS software_projects (
                page_id INTEGER PRIMARY KEY,
                repo_name TEXT DEFAULT '',
                repo_path TEXT DEFAULT '',
                branch TEXT DEFAULT 'main',
                tech_stack TEXT DEFAULT '',
                api_key TEXT DEFAULT '',
                system_architecture TEXT DEFAULT '',
                updated_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS software_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                page_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                category TEXT DEFAULT 'Architecture', -- 'Architecture', 'UI/UX', 'CodeStyle', 'Security', 'Database'
                severity TEXT DEFAULT 'MUST',          -- 'MUST', 'SHOULD', 'NEVER'
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS software_ideas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                page_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                category TEXT DEFAULT 'Feature',       -- 'Feature', 'Refactor', 'Performance', 'UX', 'AI'
                status TEXT DEFAULT 'draft',           -- 'draft', 'approved', 'in_progress', 'done', 'rejected'
                author TEXT DEFAULT 'User',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS software_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                page_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT DEFAULT 'todo',            -- 'todo', 'in_progress', 'review', 'done'
                priority TEXT DEFAULT 'medium',        -- 'low', 'medium', 'high', 'critical'
                assigned_agent TEXT DEFAULT '',        -- 'Human', 'Antigravity-CLI', 'Claude', etc.
                commit_hash TEXT DEFAULT '',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS software_commits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                page_id INTEGER NOT NULL,
                commit_hash TEXT NOT NULL,
                message TEXT NOT NULL,
                author TEXT DEFAULT '',
                committed_at TEXT DEFAULT '',
                branch TEXT DEFAULT 'main',
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
            );

            -- Şifre & Kimlik Kasası (Kişisel, Aile, İş)
            CREATE TABLE IF NOT EXISTS vault_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                category TEXT DEFAULT 'web', -- 'web', 'bank', 'wifi', 'device', 'server', 'email', 'other'
                scope TEXT DEFAULT 'personal', -- 'personal', 'family', 'work', 'other'
                profile_name TEXT DEFAULT '', -- 'Turan', 'Eşim', 'Çocuklar', 'Şirket', vb.
                username TEXT DEFAULT '',
                password TEXT DEFAULT '',
                url TEXT DEFAULT '',
                secondary_info TEXT DEFAULT '', -- PIN, PUK, IBAN, Port, vs.
                notes TEXT DEFAULT '',
                icon TEXT DEFAULT '🔐',
                color TEXT DEFAULT '#3b82f6',
                folder_name TEXT DEFAULT '', -- 'Ahmet', 'Turan', 'E-Ticaret Projesi', vb.
                tags TEXT DEFAULT '', -- '#proje, #api, #gmail' vb.
                is_favorite INTEGER DEFAULT 0,
                is_archived INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

            -- Kasa Klasörleri (Kişiler & Projeler İçin Gruplar)
            CREATE TABLE IF NOT EXISTS vault_folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                icon TEXT DEFAULT '📁',
                color TEXT DEFAULT '#3b82f6',
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

            -- İşlem Geçmişi & Geri Alma (Son 100 İşlem)
            CREATE TABLE IF NOT EXISTS action_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action_type TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id INTEGER,
                description TEXT NOT NULL,
                payload_before TEXT,
                payload_after TEXT,
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE INDEX IF NOT EXISTS idx_pages_cat ON pages(category_id);
            CREATE INDEX IF NOT EXISTS idx_items_page ON items(page_id);
            CREATE INDEX IF NOT EXISTS idx_items_done ON items(is_done);
            CREATE INDEX IF NOT EXISTS idx_reminders_time ON reminders(remind_at, is_sent);
            CREATE INDEX IF NOT EXISTS idx_tg_users_allowed ON telegram_users(is_allowed);
            CREATE INDEX IF NOT EXISTS idx_finance_page ON finance_entries(page_id, period);
            CREATE INDEX IF NOT EXISTS idx_finance_paid ON finance_entries(is_paid);
            CREATE INDEX IF NOT EXISTS idx_proj_mile_page ON project_milestones(page_id);
            CREATE INDEX IF NOT EXISTS idx_proj_mat_page ON project_materials(page_id);
            CREATE INDEX IF NOT EXISTS idx_proj_logs_page ON project_logs(page_id);
            CREATE INDEX IF NOT EXISTS idx_soft_rules_page ON software_rules(page_id);
            CREATE INDEX IF NOT EXISTS idx_soft_ideas_page ON software_ideas(page_id);
            CREATE INDEX IF NOT EXISTS idx_soft_tasks_page ON software_tasks(page_id);
            CREATE INDEX IF NOT EXISTS idx_soft_commits_page ON software_commits(page_id);
            CREATE INDEX IF NOT EXISTS idx_vault_scope ON vault_entries(scope);
            CREATE INDEX IF NOT EXISTS idx_vault_cat ON vault_entries(category);
            CREATE INDEX IF NOT EXISTS idx_vault_profile ON vault_entries(profile_name);
            CREATE INDEX IF NOT EXISTS idx_vault_arch ON vault_entries(is_archived);
            CREATE INDEX IF NOT EXISTS idx_vault_folders_name ON vault_folders(name);
            CREATE INDEX IF NOT EXISTS idx_action_hist_id ON action_history(id DESC);

            -- Bağımsız Hızlı Notlar Tablosu (Quick Notes Inbox)
            CREATE TABLE IF NOT EXISTS quick_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                notebook_id INTEGER DEFAULT 1,
                content TEXT NOT NULL,
                color TEXT DEFAULT '#ffffff',
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (notebook_id) REFERENCES notebooks (id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_quick_notes_nb ON quick_notes(notebook_id);

            -- Çoklu Kullanıcı ve Oturum Tablosu (Multi-User & Auth)
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                email TEXT DEFAULT '',
                role TEXT DEFAULT 'user',
                auth_token TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            );
            CREATE INDEX IF NOT EXISTS idx_users_uname ON users(username);
            CREATE INDEX IF NOT EXISTS idx_users_token ON users(auth_token);

            -- Ortak Defter Paylaşım Tablosu (Collaboration)
            CREATE TABLE IF NOT EXISTS notebook_members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                notebook_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                can_edit INTEGER DEFAULT 1,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                UNIQUE(notebook_id, user_id),
                FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        """)

        # Migration: notebooks tablosuna user_id ekle
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(notebooks)")
        nb_cols = [r[1] for r in cur.fetchall()]
        if 'user_id' not in nb_cols:
            cur.execute("ALTER TABLE notebooks ADD COLUMN user_id INTEGER DEFAULT 1")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_notebooks_user ON notebooks(user_id)")

        # Migration: Mevcut vault_entries tablosuna eksik sütunları ekle
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(vault_entries)")
        v_cols = [r[1] for r in cur.fetchall()]
        if 'folder_name' not in v_cols:
            cur.execute("ALTER TABLE vault_entries ADD COLUMN folder_name TEXT DEFAULT ''")
        if 'tags' not in v_cols:
            cur.execute("ALTER TABLE vault_entries ADD COLUMN tags TEXT DEFAULT ''")
        if 'user_id' not in v_cols:
            cur.execute("ALTER TABLE vault_entries ADD COLUMN user_id INTEGER DEFAULT 1")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_vault_user ON vault_entries(user_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_vault_folder ON vault_entries(folder_name)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_vault_tags ON vault_entries(tags)")

        cur.execute("PRAGMA table_info(vault_folders)")
        vf_cols = [r[1] for r in cur.fetchall()]
        if 'user_id' not in vf_cols:
            cur.execute("ALTER TABLE vault_folders ADD COLUMN user_id INTEGER DEFAULT 1")

        # Migration: Mevcut finance_entries tablosuna eksik sütunları ekle
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(finance_entries)")
        f_cols = [r[1] for r in cur.fetchall()]
        if 'end_period' not in f_cols:
            cur.execute("ALTER TABLE finance_entries ADD COLUMN end_period TEXT DEFAULT ''")
        if 'reminder_days' not in f_cols:
            cur.execute("ALTER TABLE finance_entries ADD COLUMN reminder_days INTEGER DEFAULT 0")
        if 'reminder_time' not in f_cols:
            cur.execute("ALTER TABLE finance_entries ADD COLUMN reminder_time TEXT DEFAULT '09:00'")
        if 'is_reminder_sent' not in f_cols:
            cur.execute("ALTER TABLE finance_entries ADD COLUMN is_reminder_sent INTEGER DEFAULT 0")

        # Migration: Notebooks ve Categories ilişkisi
        cur.execute("PRAGMA table_info(categories)")
        cat_cols = [r[1] for r in cur.fetchall()]
        if 'notebook_id' not in cat_cols:
            cur.execute("ALTER TABLE categories ADD COLUMN notebook_id INTEGER DEFAULT 1")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_cat_notebook ON categories(notebook_id)")

        cur.execute("SELECT COUNT(*) FROM notebooks")
        if cur.fetchone()[0] == 0:
            cur.execute("INSERT INTO notebooks (name, icon, color, description, is_default, sort_order) VALUES (?, ?, ?, ?, 1, 1)",
                        ("Kişisel Not Defterim", "📓", "#3b82f6", "Varsayılan kişisel not defteri"))
            default_nb_id = cur.lastrowid
            cur.execute("UPDATE categories SET notebook_id = ? WHERE notebook_id IS NULL OR notebook_id = 0", (default_nb_id,))
            cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('active_notebook_id', ?)", (str(default_nb_id),))

        # Varsayılan başlangıç verisi kontrolü
        cur = conn.cursor()
        # Varsa eski kategori isimlerini 'Hızlı Notlar ve Görevler' olarak güncelle
        cur.execute("UPDATE categories SET name = 'Hızlı Notlar ve Görevler' WHERE name IN ('Hızlı Notlar', 'Genel Notlar')")
        conn.commit()

        cur.execute("SELECT id FROM notebooks")
        for (nb_id,) in cur.fetchall():
            cur.execute("SELECT COUNT(*) FROM categories WHERE notebook_id = ?", (nb_id,))
            if cur.fetchone()[0] == 0:
                cur.execute("INSERT INTO categories (name, icon, color, notebook_id, sort_order) VALUES (?, ?, ?, ?, 1)",
                            ("Hızlı Notlar ve Görevler", "⚡", "#f59e0b", nb_id))
                conn.commit()

        cur.execute("SELECT COUNT(*) FROM categories")
        if cur.fetchone()[0] == 0:
            cur.execute("INSERT INTO categories (name, icon, color, notebook_id, sort_order) VALUES (?, ?, ?, 1, 1)",
                        ("Hızlı Notlar ve Görevler", "⚡", "#f59e0b"))
            cat_alisveris_id = cur.lastrowid

            cur.execute("INSERT INTO categories (name, icon, color, sort_order) VALUES (?, ?, ?, ?)",
                        ("Günlük & İş", "💼", "#6366f1", 2))
            cat_gunluk_id = cur.lastrowid

            cur.execute("INSERT INTO categories (name, icon, color, sort_order) VALUES (?, ?, ?, ?)",
                        ("Teknoloji & Projeler", "⚡", "#f59e0b", 3))
            cat_tekno_id = cur.lastrowid

            # Sayfalar
            cur.execute("""INSERT INTO pages (category_id, title, type, icon, sort_order)
                           VALUES (?, ?, ?, ?, ?)""",
                        (cat_alisveris_id, "Market Listesi", "checklist", "🥦", 1))
            market_page_id = cur.lastrowid

            cur.execute("""INSERT INTO pages (category_id, title, type, icon, sort_order)
                           VALUES (?, ?, ?, ?, ?)""",
                        (cat_alisveris_id, "İnternet Alışverişi", "checklist", "📦", 2))

            cur.execute("""INSERT INTO pages (category_id, title, type, icon, sort_order)
                           VALUES (?, ?, ?, ?, ?)""",
                        (cat_gunluk_id, "Yapılacaklar", "checklist", "✅", 1))

            cur.execute("""INSERT INTO pages (category_id, title, type, icon, content, sort_order)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        (cat_tekno_id, "Fikirler & Notlar", "notes", "💡", "Tinc-Hub TNOTE modülü hazırlandı!", 1))

            # Örnek maddeler
            cur.execute("""INSERT INTO items (page_id, title, quantity, sort_order)
                           VALUES (?, ?, ?, ?)""",
                        (market_page_id, "Süt", "2 kutu", 1))
            cur.execute("""INSERT INTO items (page_id, title, quantity, sort_order)
                           VALUES (?, ?, ?, ?)""",
                        (market_page_id, "Filtre Kahve", "1 paket", 2))
            cur.execute("""INSERT INTO items (page_id, title, quantity, is_done, sort_order)
                           VALUES (?, ?, ?, ?, ?)""",
                        (market_page_id, "Ekmek", "1 adet", 1, 3))

            # Varsayılan ayarlar
            default_settings = [
                ("telegram_bot_token", ""),
                ("telegram_chat_ids", ""),
                ("telegram_default_page_id", str(market_page_id)),
                ("telegram_enabled", "0"),
                ("ui_notify_enabled", "1")
            ]
            cur.executemany("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", default_settings)

        conn.commit()
        conn.close()

# ─────────────────────────────────────────────────────────────────────────────
# Settings
# ─────────────────────────────────────────────────────────────────────────────

def get_setting(key: str, default: str = "") -> str:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = cur.fetchone()
        conn.close()
        return row[0] if row and row[0] is not None else default

def get_all_settings() -> dict:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT key, value FROM settings")
        rows = cur.fetchall()
        conn.close()
        return {r["key"]: r["value"] for r in rows}

def set_setting(key: str, value: str):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
        conn.commit()
        conn.close()

def update_settings(data: dict):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        for k, v in data.items():
            cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, str(v)))
        conn.commit()
        conn.close()

# ─────────────────────────────────────────────────────────────────────────────
# Notebooks (Not Defterleri - OneNote Mimarisi)
# ─────────────────────────────────────────────────────────────────────────────

def get_notebooks(user_id: int = None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        if user_id is not None:
            cur.execute("""
                SELECT n.*,
                       (SELECT COUNT(*) FROM categories c WHERE c.notebook_id = n.id) as category_count,
                       (SELECT COUNT(*) FROM pages p JOIN categories c ON p.category_id = c.id WHERE c.notebook_id = n.id AND p.is_archived = 0) as page_count
                FROM notebooks n
                WHERE n.user_id = ? OR n.user_id IS NULL OR n.id IN (SELECT notebook_id FROM notebook_members WHERE user_id = ?)
                ORDER BY n.sort_order ASC, n.id ASC
            """, (user_id, user_id))
        else:
            cur.execute("""
                SELECT n.*,
                       (SELECT COUNT(*) FROM categories c WHERE c.notebook_id = n.id) as category_count,
                       (SELECT COUNT(*) FROM pages p JOIN categories c ON p.category_id = c.id WHERE c.notebook_id = n.id AND p.is_archived = 0) as page_count
                FROM notebooks n
                ORDER BY n.sort_order ASC, n.id ASC
            """)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def get_notebook(notebook_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            SELECT n.*,
                   (SELECT COUNT(*) FROM categories c WHERE c.notebook_id = n.id) as category_count,
                   (SELECT COUNT(*) FROM pages p JOIN categories c ON p.category_id = c.id WHERE c.notebook_id = n.id AND p.is_archived = 0) as page_count
            FROM notebooks n WHERE n.id = ?
        """, (notebook_id,))
        row = cur.fetchone()
        conn.close()
        return dict(row) if row else None

def add_notebook(name: str, icon: str = '📓', color: str = '#3b82f6', description: str = '', user_id: int = None) -> int:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM notebooks")
        next_order = cur.fetchone()[0]
        cur.execute("""
            INSERT INTO notebooks (name, icon, color, description, sort_order, user_id)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (name.strip(), icon or '📓', color or '#3b82f6', description.strip(), next_order, user_id))
        nb_id = cur.lastrowid
        cur.execute("""
            INSERT INTO categories (name, icon, color, notebook_id, sort_order)
            VALUES (?, ?, ?, ?, 1)
        """, ("Hızlı Notlar ve Görevler", "⚡", "#f59e0b", nb_id))
        conn.commit()
        conn.close()
        return nb_id

def update_notebook(notebook_id: int, name: str, icon: str, color: str, description: str):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            UPDATE notebooks
            SET name = ?, icon = ?, color = ?, description = ?, updated_at = (datetime('now', 'localtime'))
            WHERE id = ?
        """, (name.strip(), icon or '📓', color or '#3b82f6', description.strip(), notebook_id))
        conn.commit()
        conn.close()

def delete_notebook(notebook_id: int) -> bool:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM notebooks")
        if cur.fetchone()[0] <= 1:
            conn.close()
            return False
        cur.execute("SELECT id FROM categories WHERE notebook_id = ?", (notebook_id,))
        cat_ids = [r[0] for r in cur.fetchall()]
        for cid in cat_ids:
            cur.execute("DELETE FROM categories WHERE id = ?", (cid,))
        cur.execute("DELETE FROM notebooks WHERE id = ?", (notebook_id,))
        cur.execute("SELECT id FROM notebooks ORDER BY id ASC LIMIT 1")
        first_nb = cur.fetchone()
        if first_nb:
            cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('active_notebook_id', ?)", (str(first_nb[0]),))
        conn.commit()
        conn.close()
        return True

def get_active_notebook_id() -> int:
    val = get_setting('active_notebook_id', '1')
    try:
        nb_id = int(val)
        nb = get_notebook(nb_id)
        if nb:
            return nb_id
    except:
        pass
    nbs = get_notebooks()
    return nbs[0]['id'] if nbs else 1

def set_active_notebook_id(notebook_id: int):
    set_setting('active_notebook_id', str(notebook_id))

def export_notebook_data(notebook_id: int) -> dict:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM notebooks WHERE id = ?", (notebook_id,))
        nb_row = cur.fetchone()
        if not nb_row:
            conn.close()
            return None
        nb_dict = dict(nb_row)

        cur.execute("SELECT * FROM categories WHERE notebook_id = ? ORDER BY sort_order ASC", (notebook_id,))
        categories_data = []
        for c in cur.fetchall():
            cd = dict(c)
            cur.execute("SELECT * FROM pages WHERE category_id = ? AND is_archived = 0 ORDER BY sort_order ASC", (c['id'],))
            pages_data = []
            for p in cur.fetchall():
                pd = dict(p)
                cur.execute("SELECT * FROM items WHERE page_id = ? ORDER BY sort_order ASC", (p['id'],))
                pd['items'] = [dict(it) for it in cur.fetchall()]
                cur.execute("SELECT * FROM finance_entries WHERE page_id = ?", (p['id'],))
                pd['finances'] = [dict(fe) for fe in cur.fetchall()]
                pages_data.append(pd)
            cd['pages'] = pages_data
            categories_data.append(cd)
        conn.close()

        return {
            "format": "tincnote_notebook",
            "version": "1.1.0",
            "exported_at": datetime.now().isoformat(),
            "notebook": nb_dict,
            "categories": categories_data
        }

def import_notebook_data(data: dict) -> int:
    nb_info = data.get("notebook", {})
    name = nb_info.get("name", "İçe Aktarılan Not Defteri")
    icon = nb_info.get("icon", "📓")
    color = nb_info.get("color", "#3b82f6")
    description = nb_info.get("description", "")

    new_nb_id = add_notebook(f"{name}", icon=icon, color=color, description=description)

    for c in data.get("categories", []):
        cat_id = add_category(c.get("name", "Kategori"), icon=c.get("icon", "📁"), color=c.get("color", "#3b82f6"), notebook_id=new_nb_id)
        for p in c.get("pages", []):
            page_id = add_page(cat_id, p.get("title", "Sayfa"), p.get("type", "notes"), p.get("icon", "📝"), p.get("content", ""))
            for it in p.get("items", []):
                add_item(page_id, it.get("title", ""), description=it.get("description", ""), is_done=it.get("is_done", 0))
            for fe in p.get("finances", []):
                add_finance_entry(page_id, fe.get("entry_type", "expense"), fe.get("title", ""), float(fe.get("amount", 0)),
                                  due_day=fe.get("due_day", 1), category=fe.get("category", "Genel"), is_paid=fe.get("is_paid", 0))
    return new_nb_id

# ─────────────────────────────────────────────────────────────────────────────
# Categories
# ─────────────────────────────────────────────────────────────────────────────

def get_categories(notebook_id: int = None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        if notebook_id is None:
            cur.execute("SELECT value FROM settings WHERE key = 'active_notebook_id'")
            r = cur.fetchone()
            notebook_id = int(r[0]) if r and r[0] else 1

        query = """
            SELECT c.*, COUNT(p.id) as page_count
            FROM categories c
            LEFT JOIN pages p ON p.category_id = c.id AND p.is_archived = 0
            WHERE c.notebook_id = ?
            GROUP BY c.id
            ORDER BY c.sort_order ASC, c.id ASC
        """
        cur.execute(query, (notebook_id,))
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def get_category(cat_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM categories WHERE id = ?", (cat_id,))
        row = cur.fetchone()
        conn.close()
        return dict(row) if row else None

def add_category(name: str, icon: str = '📁', color: str = '#3b82f6', notebook_id: int = None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        if notebook_id is None:
            cur.execute("SELECT value FROM settings WHERE key = 'active_notebook_id'")
            r = cur.fetchone()
            notebook_id = int(r[0]) if r and r[0] else 1

        cur.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE notebook_id = ?", (notebook_id,))
        next_order = cur.fetchone()[0]
        cur.execute("INSERT INTO categories (name, icon, color, notebook_id, sort_order) VALUES (?, ?, ?, ?, ?)",
                    (name.strip(), icon or '📁', color or '#3b82f6', notebook_id, next_order))
        cat_id = cur.lastrowid
        conn.commit()
        conn.close()
        return cat_id

def update_category(cat_id: int, name: str, icon: str, color: str):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE categories SET name = ?, icon = ?, color = ? WHERE id = ?",
                    (name.strip(), icon, color, cat_id))
        conn.commit()
        conn.close()

def delete_category(cat_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
        conn.commit()
        conn.close()

# ─────────────────────────────────────────────────────────────────────────────
# Pages
# ─────────────────────────────────────────────────────────────────────────────

def get_pages(category_id: int = None, notebook_id: int = None, include_archived: bool = False):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        query = """
            SELECT p.*,
                   (SELECT COUNT(*) FROM items i WHERE i.page_id = p.id) as total_items,
                   (SELECT COUNT(*) FROM items i WHERE i.page_id = p.id AND i.is_done = 1) as completed_items
            FROM pages p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE 1=1
        """
        params = []
        if category_id is not None:
            query += " AND p.category_id = ?"
            params.append(category_id)
        elif notebook_id is not None:
            query += " AND c.notebook_id = ?"
            params.append(notebook_id)

        if not include_archived:
            query += " AND p.is_archived = 0"
        query += " ORDER BY p.sort_order ASC, p.id ASC"
        cur.execute(query, params)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def get_page(page_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            SELECT p.*, c.name as category_name, c.color as category_color
            FROM pages p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id = ?
        """, (page_id,))
        row = cur.fetchone()
        conn.close()
        return dict(row) if row else None

def add_page(category_id: int, title: str, page_type: str = 'checklist', icon: str = '📝', content: str = ''):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM pages WHERE category_id = ?", (category_id,))
        next_order = cur.fetchone()[0]
        cur.execute("""
            INSERT INTO pages (category_id, title, type, icon, content, sort_order)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (category_id, title.strip(), page_type, icon or '📝', content or '', next_order))
        page_id = cur.lastrowid
        conn.commit()
        conn.close()
        return page_id

def update_page(page_id: int, title: str = None, category_id: int = None, icon: str = None, content: str = None, sort_order: int = None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        fields = []
        params = []
        if title is not None:
            fields.append("title = ?")
            params.append(title.strip())
        if category_id is not None:
            fields.append("category_id = ?")
            params.append(category_id)
        if icon is not None:
            fields.append("icon = ?")
            params.append(icon)
        if content is not None:
            fields.append("content = ?")
            params.append(content)
        if sort_order is not None:
            fields.append("sort_order = ?")
            params.append(sort_order)
        fields.append("updated_at = datetime('now', 'localtime')")
        params.append(page_id)
        cur.execute(f"UPDATE pages SET {', '.join(fields)} WHERE id = ?", params)
        conn.commit()
        conn.close()

def reorder_pages(category_id: int, page_ids: list):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        for idx, p_id in enumerate(page_ids):
            cur.execute("""
                UPDATE pages 
                SET category_id = ?, sort_order = ?, updated_at = datetime('now', 'localtime') 
                WHERE id = ?
            """, (category_id, idx + 1, p_id))
        conn.commit()
        conn.close()

def move_page_to_category(page_id: int, new_category_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM pages WHERE category_id = ?", (new_category_id,))
        next_order = cur.fetchone()[0]
        cur.execute("""
            UPDATE pages 
            SET category_id = ?, sort_order = ?, updated_at = datetime('now', 'localtime') 
            WHERE id = ?
        """, (new_category_id, next_order, page_id))
        conn.commit()
        conn.close()

def reorder_categories(category_ids: list):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        for idx, c_id in enumerate(category_ids):
            cur.execute("UPDATE categories SET sort_order = ? WHERE id = ?", (idx + 1, c_id))
        conn.commit()
        conn.close()

# ─────────────────────────────────────────────────────────────────────────────
# İşlem Geçmişi & Geri Alma (Undo History - Son 100 İşlem)
# ─────────────────────────────────────────────────────────────────────────────

def _log_action_internal(action_type: str, entity_type: str, entity_id: int, description: str, payload_before: dict = None, payload_after: dict = None):
    try:
        conn = get_conn()
        cur = conn.cursor()
        pb_str = json.dumps(payload_before, ensure_ascii=False) if payload_before else None
        pa_str = json.dumps(payload_after, ensure_ascii=False) if payload_after else None
        cur.execute("""
            INSERT INTO action_history (action_type, entity_type, entity_id, description, payload_before, payload_after)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (action_type, entity_type, entity_id, description, pb_str, pa_str))
        
        # Son 100 işlemi koru, fazlasını sil
        cur.execute("""
            DELETE FROM action_history 
            WHERE id NOT IN (
                SELECT id FROM action_history ORDER BY id DESC LIMIT 100
            )
        """)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Action log hatası: {e}")

def log_action(action_type: str, entity_type: str, entity_id: int, description: str, payload_before: dict = None, payload_after: dict = None):
    with _lock:
        _log_action_internal(action_type, entity_type, entity_id, description, payload_before, payload_after)

def get_action_history(limit: int = 100):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM action_history ORDER BY id DESC LIMIT ?", (limit,))
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def undo_action(history_id: int = None) -> dict:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        if history_id:
            cur.execute("SELECT * FROM action_history WHERE id = ?", (history_id,))
        else:
            cur.execute("SELECT * FROM action_history ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        if not row:
            conn.close()
            return {"ok": False, "error": "Geri alınacak bir işlem bulunamadı."}
        
        act = dict(row)
        action_type = act["action_type"]
        desc = act["description"]
        pb = json.loads(act["payload_before"]) if act.get("payload_before") else {}
        pa = json.loads(act["payload_after"]) if act.get("payload_after") else {}
        
        undone_desc = f"'{desc}' geri alındı"
        
        try:
            if action_type in ("delete_page", "permanent_delete_page"):
                page_id = act["entity_id"]
                cur.execute("UPDATE pages SET is_archived = 0 WHERE id = ?", (page_id,))
            elif action_type == "create_page":
                page_id = act["entity_id"]
                cur.execute("UPDATE pages SET is_archived = 1 WHERE id = ?", (page_id,))
            elif action_type == "restore_page":
                page_id = act["entity_id"]
                cur.execute("UPDATE pages SET is_archived = 1 WHERE id = ?", (page_id,))
            elif action_type == "delete_item":
                if pb:
                    cur.execute("""
                        INSERT OR REPLACE INTO items (id, page_id, title, description, url, image_url, price, quantity, is_done, sort_order)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (pb.get("id"), pb.get("page_id"), pb.get("title", ""), pb.get("description", ""),
                          pb.get("url", ""), pb.get("image_url", ""), pb.get("price", ""), pb.get("quantity", ""),
                          pb.get("is_done", 0), pb.get("sort_order", 0)))
            elif action_type == "create_item":
                item_id = act["entity_id"]
                cur.execute("DELETE FROM items WHERE id = ?", (item_id,))
            elif action_type == "toggle_item":
                item_id = act["entity_id"]
                prev_done = pb.get("is_done", 0)
                cur.execute("UPDATE items SET is_done = ? WHERE id = ?", (prev_done, item_id))
            elif action_type == "update_item":
                item_id = act["entity_id"]
                if pb:
                    cur.execute("""
                        UPDATE items SET title = ?, description = ?, price = ?, quantity = ?, url = ? WHERE id = ?
                    """, (pb.get("title", ""), pb.get("description", ""), pb.get("price", ""), pb.get("quantity", ""), pb.get("url", ""), item_id))
            elif action_type == "clear_completed":
                items = pb.get("items", [])
                for it in items:
                    cur.execute("""
                        INSERT OR REPLACE INTO items (id, page_id, title, description, url, image_url, price, quantity, is_done, sort_order)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (it.get("id"), it.get("page_id"), it.get("title", ""), it.get("description", ""),
                          it.get("url", ""), it.get("image_url", ""), it.get("price", ""), it.get("quantity", ""),
                          it.get("is_done", 1), it.get("sort_order", 0)))
            elif action_type in ("delete_vault", "permanent_delete_vault"):
                if pb:
                    cur.execute("UPDATE vault_entries SET is_archived = 0 WHERE id = ?", (pb.get("id"),))
            elif action_type == "create_vault":
                vault_id = act["entity_id"]
                cur.execute("UPDATE vault_entries SET is_archived = 1 WHERE id = ?", (vault_id,))
            elif action_type == "update_vault":
                vault_id = act["entity_id"]
                if pb:
                    cur.execute("""
                        UPDATE vault_entries SET title=?, category=?, scope=?, profile_name=?, folder_name=?, tags=?, username=?, password=?, url=?, secondary_info=?, notes=?, icon=?, color=?, is_favorite=?
                        WHERE id=?
                    """, (pb.get("title"), pb.get("category"), pb.get("scope"), pb.get("profile_name"), pb.get("folder_name", ""), pb.get("tags", ""), pb.get("username"), pb.get("password"), pb.get("url"), pb.get("secondary_info"), pb.get("notes"), pb.get("icon"), pb.get("color"), pb.get("is_favorite", 0), vault_id))
            
            # Bu geri alınan işlemi tablodan temizle
            cur.execute("DELETE FROM action_history WHERE id = ?", (act["id"],))
            conn.commit()
            conn.close()
            return {"ok": True, "message": undone_desc, "action": act}
        except Exception as e:
            conn.rollback()
            conn.close()
            return {"ok": False, "error": f"Geri alma hatası: {str(e)}"}

def delete_page(page_id: int, permanent: bool = False):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT id, title, type, category_id FROM pages WHERE id = ?", (page_id,))
        page = cur.fetchone()
        if not page:
            conn.close()
            return
        p_dict = dict(page)
        if permanent:
            cur.execute("DELETE FROM pages WHERE id = ?", (page_id,))
            conn.commit()
            conn.close()
            _log_action_internal("permanent_delete_page", "page", page_id, f"'{p_dict['title']}' sayfası kalıcı olarak silindi", payload_before=p_dict)
        else:
            cur.execute("UPDATE pages SET is_archived = 1, updated_at = datetime('now', 'localtime') WHERE id = ?", (page_id,))
            conn.commit()
            conn.close()
            _log_action_internal("delete_page", "page", page_id, f"'{p_dict['title']}' sayfası çöp kutusuna taşındı", payload_before=p_dict)

def restore_page(page_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE pages SET is_archived = 0, updated_at = datetime('now', 'localtime') WHERE id = ?", (page_id,))
        cur.execute("SELECT id, title FROM pages WHERE id = ?", (page_id,))
        row = cur.fetchone()
        title = row["title"] if row else ""
        conn.commit()
        conn.close()
        _log_action_internal("restore_page", "page", page_id, f"'{title}' sayfası geri yüklendi")

def get_trash_pages():
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            SELECT p.*, c.name as category_name, c.icon as category_icon,
                   (SELECT COUNT(*) FROM items WHERE page_id = p.id) as item_count
            FROM pages p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.is_archived = 1
            ORDER BY p.updated_at DESC
        """)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def empty_trash():
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM pages WHERE is_archived = 1")
        cnt = cur.fetchone()[0]
        cur.execute("DELETE FROM pages WHERE is_archived = 1")
        conn.commit()
        conn.close()
        _log_action_internal("empty_trash", "trash", None, f"Çöp kutusu boşaltıldı ({cnt} sayfa kalıcı silindi)")
        return cnt

# ─────────────────────────────────────────────────────────────────────────────
# Items
# ─────────────────────────────────────────────────────────────────────────────

def get_items(page_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            SELECT i.*,
                   r.id as reminder_id, r.remind_at, r.recurrence, r.is_sent as reminder_sent
            FROM items i
            LEFT JOIN reminders r ON r.target_type = 'item' AND r.target_id = i.id
            WHERE i.page_id = ?
            ORDER BY i.is_done ASC, i.sort_order ASC, i.id DESC
        """, (page_id,))
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def add_item(page_id: int, title: str, description: str = '', url: str = '',
             image_url: str = '', price: str = '', quantity: str = '', is_done: int = 0) -> int:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COALESCE(MIN(sort_order), 0) - 1 FROM items WHERE page_id = ?", (page_id,))
        next_order = cur.fetchone()[0]
        cur.execute("""
            INSERT INTO items (page_id, title, description, url, image_url, price, quantity, sort_order, is_done)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (page_id, title.strip(), description, url, image_url, price, quantity, next_order, is_done))
        item_id = cur.lastrowid
        # Update page updated_at
        cur.execute("UPDATE pages SET updated_at = datetime('now', 'localtime') WHERE id = ?", (page_id,))
        conn.commit()
        conn.close()
        _log_action_internal("create_item", "item", item_id, f"'{title.strip()}' maddesi eklendi", payload_after={"id": item_id, "page_id": page_id, "title": title.strip()})
        return item_id

def update_item(item_id: int, **kwargs):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM items WHERE id = ?", (item_id,))
        old_item = cur.fetchone()
        if not old_item:
            conn.close()
            return
        old_dict = dict(old_item)
        fields = []
        params = []
        valid_keys = ['title', 'description', 'url', 'image_url', 'price', 'quantity', 'is_done', 'sort_order', 'page_id']
        for k, v in kwargs.items():
            if k in valid_keys:
                fields.append(f"{k} = ?")
                params.append(v)
        if not fields:
            conn.close()
            return
        fields.append("updated_at = datetime('now', 'localtime')")
        params.append(item_id)
        cur.execute(f"UPDATE items SET {', '.join(fields)} WHERE id = ?", params)
        conn.commit()
        conn.close()
        if "is_done" in kwargs and kwargs["is_done"] != old_dict["is_done"]:
            st = "tamamlandı" if kwargs["is_done"] == 1 else "tamamlanmadı yapıldı"
            _log_action_internal("toggle_item", "item", item_id, f"'{old_dict['title']}' {st}", payload_before={"is_done": old_dict["is_done"], "id": item_id}, payload_after={"is_done": kwargs["is_done"]})
        else:
            _log_action_internal("update_item", "item", item_id, f"'{old_dict['title']}' güncellendi", payload_before=old_dict)

def delete_item(item_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM items WHERE id = ?", (item_id,))
        item = cur.fetchone()
        if not item:
            conn.close()
            return
        item_dict = dict(item)
        cur.execute("DELETE FROM reminders WHERE target_type = 'item' AND target_id = ?", (item_id,))
        cur.execute("DELETE FROM items WHERE id = ?", (item_id,))
        conn.commit()
        conn.close()
        _log_action_internal("delete_item", "item", item_id, f"'{item_dict['title']}' maddesi silindi", payload_before=item_dict)

def clear_completed_items(page_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM items WHERE page_id = ? AND is_done = 1", (page_id,))
        items = [dict(r) for r in cur.fetchall()]
        if not items:
            conn.close()
            return
        cur.execute("""
            DELETE FROM reminders WHERE target_type = 'item' AND target_id IN (
                SELECT id FROM items WHERE page_id = ? AND is_done = 1
            )
        """, (page_id,))
        cur.execute("DELETE FROM items WHERE page_id = ? AND is_done = 1", (page_id,))
        conn.commit()
        conn.close()
        _log_action_internal("clear_completed", "item", page_id, f"{len(items)} tamamlanan madde temizlendi", payload_before={"items": items})

def reorder_items(item_ids: list):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        for idx, i_id in enumerate(item_ids):
            cur.execute("UPDATE items SET sort_order = ? WHERE id = ?", (idx + 1, i_id))
        conn.commit()
        conn.close()

# ─────────────────────────────────────────────────────────────────────────────
# Reminders
# ─────────────────────────────────────────────────────────────────────────────

def set_reminder(target_type: str, target_id: int, remind_at: str, recurrence: str = 'none'):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        # Varsa eskisini sil
        cur.execute("DELETE FROM reminders WHERE target_type = ? AND target_id = ?", (target_type, target_id))
        cur.execute("""
            INSERT INTO reminders (target_type, target_id, remind_at, recurrence, is_sent)
            VALUES (?, ?, ?, ?, 0)
        """, (target_type, target_id, remind_at, recurrence))
        rem_id = cur.lastrowid
        conn.commit()
        conn.close()
        return rem_id

def delete_reminder(target_type: str, target_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM reminders WHERE target_type = ? AND target_id = ?", (target_type, target_id))
        conn.commit()
        conn.close()

def get_due_reminders(current_time_str: str = None):
    if not current_time_str:
        current_time_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            SELECT r.*,
                   CASE WHEN r.target_type = 'item' THEN i.title ELSE p.title END as target_title,
                   CASE WHEN r.target_type = 'item' THEN i.page_id ELSE p.id END as page_id,
                   CASE WHEN r.target_type = 'item' THEN i.price ELSE '' END as item_price,
                   CASE WHEN r.target_type = 'item' THEN i.url ELSE '' END as item_url,
                   p.title as page_title
            FROM reminders r
            LEFT JOIN items i ON r.target_type = 'item' AND i.id = r.target_id
            LEFT JOIN pages p ON (r.target_type = 'page' AND p.id = r.target_id) OR (r.target_type = 'item' AND p.id = i.page_id)
            WHERE r.is_sent = 0 AND r.remind_at <= ?
        """, (current_time_str,))
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def mark_reminder_sent(reminder_id: int, next_remind_at: str = None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        if next_remind_at:
            cur.execute("UPDATE reminders SET remind_at = ?, is_sent = 0, sent_at = datetime('now', 'localtime') WHERE id = ?",
                        (next_remind_at, reminder_id))
        else:
            cur.execute("UPDATE reminders SET is_sent = 1, sent_at = datetime('now', 'localtime') WHERE id = ?",
                        (reminder_id,))
        conn.commit()
        conn.close()

# ─────────────────────────────────────────────────────────────────────────────
# Telegram Users (ID & Nickname)
# ─────────────────────────────────────────────────────────────────────────────

def upsert_telegram_user(chat_id: str, username: str = "", first_name: str = "", is_allowed: int = None):
    chat_id = str(chat_id).strip()
    if not chat_id:
        return
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT is_allowed FROM telegram_users WHERE chat_id = ?", (chat_id,))
        row = cur.fetchone()
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        clean_user = (username or '').lstrip('@').strip()
        clean_name = (first_name or '').strip()

        if row is None:
            allowed_val = is_allowed if is_allowed is not None else 0
            cur.execute("""
                INSERT INTO telegram_users (chat_id, username, first_name, is_allowed, created_at, last_seen)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (chat_id, clean_user, clean_name, allowed_val, now, now))
        else:
            fields = ["last_seen = ?"]
            params = [now]
            if clean_user:
                fields.append("username = ?")
                params.append(clean_user)
            if clean_name:
                fields.append("first_name = ?")
                params.append(clean_name)
            if is_allowed is not None:
                fields.append("is_allowed = ?")
                params.append(is_allowed)
            params.append(chat_id)
            cur.execute(f"UPDATE telegram_users SET {', '.join(fields)} WHERE chat_id = ?", params)
        conn.commit()
        conn.close()

def get_telegram_users():
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM telegram_users ORDER BY is_allowed DESC, last_seen DESC")
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def set_telegram_user_allowed(chat_id: str, is_allowed: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE telegram_users SET is_allowed = ? WHERE chat_id = ?", (is_allowed, str(chat_id).strip()))
        conn.commit()
        conn.close()

def delete_telegram_user(chat_id: str):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM telegram_users WHERE chat_id = ?", (str(chat_id).strip(),))
        conn.commit()
        conn.close()

def add_allowed_target(target: str):
    """Sayısal ID veya @kullaniciadi ekler."""
    target = target.strip()
    if not target:
        return
    clean_target = target.lstrip('@').strip()
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        if target.isdigit():
            cur.execute("SELECT chat_id FROM telegram_users WHERE chat_id = ?", (target,))
            if cur.fetchone():
                cur.execute("UPDATE telegram_users SET is_allowed = 1 WHERE chat_id = ?", (target,))
            else:
                now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                cur.execute("INSERT INTO telegram_users (chat_id, username, first_name, is_allowed, created_at, last_seen) VALUES (?, ?, ?, 1, ?, ?)",
                            (target, "", "Manuel Eklenen", now, now))
        else:
            cur.execute("SELECT chat_id FROM telegram_users WHERE LOWER(username) = ?", (clean_target.lower(),))
            row = cur.fetchone()
            if row:
                cur.execute("UPDATE telegram_users SET is_allowed = 1 WHERE chat_id = ?", (row[0],))
            else:
                # Henüz mesaj atmamış nickname; placeholder olarak ekle
                fake_chat_id = f"nick:{clean_target.lower()}"
                now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                cur.execute("INSERT OR REPLACE INTO telegram_users (chat_id, username, first_name, is_allowed, created_at, last_seen) VALUES (?, ?, ?, 1, ?, ?)",
                            (fake_chat_id, clean_target, f"@{clean_target}", now, now))

        # settings içindeki telegram_chat_ids alanını da senkronize et
        cur.execute("SELECT value FROM settings WHERE key = 'telegram_chat_ids'")
        val_row = cur.fetchone()
        existing = val_row[0] if val_row and val_row[0] else ""
        items = [x.strip() for x in existing.replace(";", ",").split(",") if x.strip()]
        if clean_target not in [x.lstrip('@').lower() for x in items] and target not in items:
            items.append(target)
            new_val = ", ".join(items)
            cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('telegram_chat_ids', ?)", (new_val,))

        conn.commit()
        conn.close()

def reset_page_items(page_id: int):
    """Tüm maddelerin is_done durumunu 0 yapar (listeyi baştan başlatır)."""
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE items SET is_done = 0, updated_at = datetime('now', 'localtime') WHERE page_id = ?", (page_id,))
        conn.commit()
        conn.close()

def update_item_price(item_id: int, new_price: str):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE items SET price = ?, updated_at = datetime('now', 'localtime') WHERE id = ?", (new_price.strip(), item_id))
        conn.commit()
        conn.close()

def get_all_tracked_product_items():
    """URL ve fiyat içeren maddeleri döndürür (fiyat takip motoru için)."""
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            SELECT i.id, i.page_id, i.title, i.url, i.price, p.title as page_title
            FROM items i
            JOIN pages p ON p.id = i.page_id
            WHERE i.url IS NOT NULL AND i.url != ''
              AND i.is_done = 0
            ORDER BY i.id DESC
        """)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

# ─────────────────────────────────────────────────────────────────────────────
# Finance Entries (Gelir / Gider & Düzenli Ödeme Takibi)
# ─────────────────────────────────────────────────────────────────────────────

def get_finance_entries(page_id: int, period: str = None):
    if not period:
        period = datetime.now().strftime("%Y-%m")
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            SELECT * FROM finance_entries
            WHERE page_id = ? AND period = ?
            ORDER BY entry_type ASC, is_paid ASC, due_day ASC, id ASC
        """, (page_id, period))
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def add_finance_entry(page_id: int, entry_type: str, title: str, amount: float,
                      category: str = 'Genel', due_day: int = 1, due_date: str = None,
                      is_recurring: int = 1, end_period: str = '', reminder_days: int = 0,
                      reminder_time: str = '09:00', period: str = None, notes: str = ''):
    if not period:
        period = datetime.now().strftime("%Y-%m")
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO finance_entries (page_id, entry_type, title, category, amount, due_day, due_date, is_recurring, end_period, reminder_days, reminder_time, period, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (page_id, entry_type, title.strip(), category.strip(), float(amount), int(due_day),
              due_date or None, int(is_recurring), (end_period or '').strip(),
              int(reminder_days), reminder_time or '09:00', period, notes.strip()))
        entry_id = cur.lastrowid
        conn.commit()
        conn.close()
        return entry_id

def update_finance_entry(entry_id: int, **kwargs):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        valid_keys = ['title', 'category', 'amount', 'due_day', 'due_date', 'is_recurring', 'end_period', 'reminder_days', 'reminder_time', 'is_paid', 'notes', 'period', 'is_reminder_sent']
        fields = []
        params = []
        for k, v in kwargs.items():
            if k in valid_keys and v is not None:
                fields.append(f"{k} = ?")
                params.append(v)
        if 'is_paid' in kwargs:
            if kwargs['is_paid']:
                fields.append("paid_at = datetime('now', 'localtime')")
            else:
                fields.append("paid_at = NULL")
        if fields:
            fields.append("updated_at = datetime('now', 'localtime')")
            params.append(entry_id)
            cur.execute(f"UPDATE finance_entries SET {', '.join(fields)} WHERE id = ?", params)
            conn.commit()
        conn.close()

def toggle_finance_paid(entry_id: int, is_paid: bool = None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        if is_paid is None:
            cur.execute("SELECT is_paid FROM finance_entries WHERE id = ?", (entry_id,))
            row = cur.fetchone()
            new_val = 0 if row and row[0] == 1 else 1
        else:
            new_val = 1 if is_paid else 0
        paid_at_val = datetime.now().strftime("%Y-%m-%d %H:%M:%S") if new_val else None
        cur.execute("""
            UPDATE finance_entries 
            SET is_paid = ?, paid_at = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
        """, (new_val, paid_at_val, entry_id))
        conn.commit()
        conn.close()
        return new_val

def delete_finance_entry(entry_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM finance_entries WHERE id = ?", (entry_id,))
        conn.commit()
        conn.close()

def copy_recurring_to_period(page_id: int, source_period: str, target_period: str):
    """Önceki aydaki düzenli ödemeleri hedef aya kopyalar (bitiş dönemi geçmişse kopyalamaz)."""
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT title FROM finance_entries WHERE page_id = ? AND period = ?", (page_id, target_period))
        existing_titles = set(r[0] for r in cur.fetchall())

        cur.execute("""
            SELECT entry_type, title, category, amount, due_day, due_date, is_recurring, end_period, reminder_days, reminder_time, notes
            FROM finance_entries
            WHERE page_id = ? AND period = ? AND is_recurring = 1
        """, (page_id, source_period))
        to_copy = cur.fetchall()

        copied_count = 0
        for r in to_copy:
            end_p = (r['end_period'] or '').strip()
            # Bitiş dönemi tanımlanmış ve hedef dönem bitiş döneminden sonraysa kopyalama!
            if end_p and target_period > end_p:
                continue
            if r['title'] not in existing_titles:
                cur.execute("""
                    INSERT INTO finance_entries (page_id, entry_type, title, category, amount, due_day, due_date, is_recurring, end_period, reminder_days, reminder_time, is_paid, period, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?)
                """, (page_id, r['entry_type'], r['title'], r['category'], r['amount'], r['due_day'], r['due_date'], end_p, r['reminder_days'], r['reminder_time'], target_period, r['notes']))
                copied_count += 1
        conn.commit()
        conn.close()
        return copied_count

def get_due_unpaid_bills(period: str = None, days_ahead: int = 3):
    """Vadesi yaklaşan veya günü gelmiş ödenmemiş faturaları getirir."""
    now = datetime.now()
    if not period:
        period = now.strftime("%Y-%m")
    current_day = now.day
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            SELECT f.*, p.title as page_title
            FROM finance_entries f
            JOIN pages p ON p.id = f.page_id
            WHERE f.period = ? AND f.entry_type = 'expense' AND f.is_paid = 0
              AND f.due_day <= ?
            ORDER BY f.due_day ASC
        """, (period, current_day + days_ahead))
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

# ─────────────────────────────────────────────────────────────────────────────
# Project Management (Bilimsel / Mühendislik / Atölye / Tamirat Projeleri)
# ─────────────────────────────────────────────────────────────────────────────

def get_project_data(page_id: int):
    """Bir projenin tüm detaylarını (fikir, şemalar, aşamalar, malzemeler, günlükler) getirir."""
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        # 1. Proje Detayları
        cur.execute("SELECT * FROM project_details WHERE page_id = ?", (page_id,))
        det = cur.fetchone()
        if not det:
            cur.execute("INSERT OR IGNORE INTO project_details (page_id) VALUES (?)", (page_id,))
            conn.commit()
            cur.execute("SELECT * FROM project_details WHERE page_id = ?", (page_id,))
            det = cur.fetchone()
        details = dict(det) if det else {}

        # 2. Aşamalar (Zaman Çizelgesi)
        cur.execute("""
            SELECT * FROM project_milestones
            WHERE page_id = ?
            ORDER BY sort_order ASC, id ASC
        """, (page_id,))
        milestones = [dict(r) for r in cur.fetchall()]

        # 3. Malzeme & İhtiyaç Listesi (BOM)
        cur.execute("""
            SELECT * FROM project_materials
            WHERE page_id = ?
            ORDER BY sort_order ASC, id ASC
        """, (page_id,))
        materials = [dict(r) for r in cur.fetchall()]

        # 4. Gelişim / Yapım Günlüğü
        cur.execute("""
            SELECT * FROM project_logs
            WHERE page_id = ?
            ORDER BY log_date DESC, id DESC
        """, (page_id,))
        logs = [dict(r) for r in cur.fetchall()]
        conn.close()

        # İstatistikler
        total_milestones = len(milestones)
        completed_milestones = sum(1 for m in milestones if m['status'] == 'completed')
        progress_pct = int((completed_milestones / total_milestones * 100)) if total_milestones > 0 else 0

        total_mat_cost = sum((m['unit_price'] or 0.0) * float(m['quantity'] if m['quantity'].replace('.', '', 1).isdigit() else 1) for m in materials)
        available_mat_cost = sum((m['unit_price'] or 0.0) * float(m['quantity'] if m['quantity'].replace('.', '', 1).isdigit() else 1) for m in materials if m['status'] == 'available')
        needed_mat_count = sum(1 for m in materials if m['status'] == 'needed')

        import json
        drawings = []
        try:
            drawings = json.loads(details.get('drawings') or '[]')
        except Exception:
            drawings = []

        return {
            "details": details,
            "drawings": drawings,
            "milestones": milestones,
            "materials": materials,
            "logs": logs,
            "stats": {
                "progress_pct": progress_pct,
                "total_milestones": total_milestones,
                "completed_milestones": completed_milestones,
                "total_materials": len(materials),
                "needed_materials": needed_mat_count,
                "total_mat_cost": total_mat_cost,
                "available_mat_cost": available_mat_cost
            }
        }

def update_project_details(page_id: int, **kwargs):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        valid_keys = ['concept', 'specs', 'status', 'drawings']
        fields = []
        params = []
        for k, v in kwargs.items():
            if k in valid_keys and v is not None:
                fields.append(f"{k} = ?")
                params.append(v if not isinstance(v, (dict, list)) else json.dumps(v))
        if fields:
            fields.append("updated_at = datetime('now', 'localtime')")
            params.append(page_id)
            cur.execute(f"UPDATE project_details SET {', '.join(fields)} WHERE page_id = ?", params)
            conn.commit()
        conn.close()

def add_project_milestone(page_id: int, title: str, target_date: str = '', status: str = 'pending',
                          description: str = '', requirements: str = ''):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_milestones WHERE page_id = ?", (page_id,))
        next_order = cur.fetchone()[0]
        cur.execute("""
            INSERT INTO project_milestones (page_id, title, target_date, status, description, requirements, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (page_id, title.strip(), target_date.strip(), status, description.strip(), requirements.strip(), next_order))
        mid = cur.lastrowid
        conn.commit()
        conn.close()
        return mid

def update_project_milestone(milestone_id: int, **kwargs):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        valid_keys = ['title', 'target_date', 'status', 'description', 'requirements', 'sort_order']
        fields = []
        params = []
        for k, v in kwargs.items():
            if k in valid_keys and v is not None:
                fields.append(f"{k} = ?")
                params.append(v)
        if fields:
            params.append(milestone_id)
            cur.execute(f"UPDATE project_milestones SET {', '.join(fields)} WHERE id = ?", params)
            conn.commit()
        conn.close()

def toggle_milestone_status(milestone_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT status FROM project_milestones WHERE id = ?", (milestone_id,))
        row = cur.fetchone()
        if not row:
            conn.close()
            return 'pending'
        cur_status = row[0]
        # Döngü: pending -> in_progress -> completed -> pending
        cycle = {'pending': 'in_progress', 'in_progress': 'completed', 'completed': 'pending'}
        new_status = cycle.get(cur_status, 'pending')
        cur.execute("UPDATE project_milestones SET status = ? WHERE id = ?", (new_status, milestone_id))
        conn.commit()
        conn.close()
        return new_status

def delete_project_milestone(milestone_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM project_milestones WHERE id = ?", (milestone_id,))
        conn.commit()
        conn.close()

def add_project_material(page_id: int, name: str, quantity: str = '1', unit_price: float = 0.0,
                         status: str = 'needed', url: str = '', notes: str = ''):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_materials WHERE page_id = ?", (page_id,))
        next_order = cur.fetchone()[0]
        cur.execute("""
            INSERT INTO project_materials (page_id, name, quantity, unit_price, status, url, notes, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (page_id, name.strip(), str(quantity).strip(), float(unit_price), status, url.strip(), notes.strip(), next_order))
        mid = cur.lastrowid
        conn.commit()
        conn.close()
        return mid

def update_project_material(material_id: int, **kwargs):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        valid_keys = ['name', 'quantity', 'unit_price', 'status', 'url', 'notes', 'sort_order']
        fields = []
        params = []
        for k, v in kwargs.items():
            if k in valid_keys and v is not None:
                fields.append(f"{k} = ?")
                params.append(v)
        if fields:
            params.append(material_id)
            cur.execute(f"UPDATE project_materials SET {', '.join(fields)} WHERE id = ?", params)
            conn.commit()
        conn.close()

def toggle_material_status(material_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT status FROM project_materials WHERE id = ?", (material_id,))
        row = cur.fetchone()
        if not row:
            conn.close()
            return 'needed'
        cur_status = row[0]
        # Döngü: needed (aranıyor) -> ordered (sipariş edildi) -> available (elde var) -> needed
        cycle = {'needed': 'ordered', 'ordered': 'available', 'available': 'needed'}
        new_status = cycle.get(cur_status, 'needed')
        cur.execute("UPDATE project_materials SET status = ? WHERE id = ?", (new_status, material_id))
        conn.commit()
        conn.close()
        return new_status

def delete_project_material(material_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM project_materials WHERE id = ?", (material_id,))
        conn.commit()
        conn.close()

def add_project_log(page_id: int, title: str, content: str, log_type: str = 'progress',
                    image_url: str = '', log_date: str = None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO project_logs (page_id, log_date, title, content, log_type, image_url)
            VALUES (?, COALESCE(?, datetime('now', 'localtime')), ?, ?, ?, ?)
        """, (page_id, log_date, title.strip(), content.strip(), log_type, image_url.strip()))
        lid = cur.lastrowid
        conn.commit()
        conn.close()
        return lid

def delete_project_log(log_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM project_logs WHERE id = ?", (log_id,))
        conn.commit()
        conn.close()

def add_project_drawing(page_id: int, title: str, url: str, desc: str = ''):
    import json, time
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT drawings FROM project_details WHERE page_id = ?", (page_id,))
        row = cur.fetchone()
        drawings = []
        if row and row[0]:
            try: drawings = json.loads(row[0])
            except Exception: drawings = []
        new_item = {
            "id": int(time.time() * 1000),
            "title": title.strip(),
            "url": url.strip(),
            "desc": desc.strip(),
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M")
        }
        drawings.append(new_item)
        cur.execute("UPDATE project_details SET drawings = ?, updated_at = datetime('now', 'localtime') WHERE page_id = ?",
                    (json.dumps(drawings), page_id))
        conn.commit()
        conn.close()
        return new_item

def delete_project_drawing(page_id: int, drawing_id: int):
    import json
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT drawings FROM project_details WHERE page_id = ?", (page_id,))
        row = cur.fetchone()
        if not row or not row[0]:
            conn.close()
            return
        try: drawings = json.loads(row[0])
        except Exception: drawings = []
        drawings = [d for d in drawings if d.get('id') != drawing_id]
        cur.execute("UPDATE project_details SET drawings = ?, updated_at = datetime('now', 'localtime') WHERE page_id = ?",
                    (json.dumps(drawings), page_id))
        conn.commit()
        conn.close()

def get_all_active_projects():
    """Tüm aktif proje sayfalarını ve temel özetlerini döner (Telegram botu için)."""
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            SELECT p.id, p.title, p.icon, c.name as category_name, pd.status as project_status,
                   (SELECT COUNT(*) FROM project_milestones pm WHERE pm.page_id = p.id) as total_milestones,
                   (SELECT COUNT(*) FROM project_milestones pm WHERE pm.page_id = p.id AND pm.status = 'completed') as completed_milestones,
                   (SELECT COUNT(*) FROM project_materials mat WHERE mat.page_id = p.id AND mat.status = 'needed') as needed_mat_count
            FROM pages p
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN project_details pd ON pd.page_id = p.id
            WHERE p.type = 'project' AND p.is_archived = 0
            ORDER BY p.sort_order ASC, p.id ASC
        """)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def get_overview_summary(notebook_id: int = None) -> dict:
    """Tüm uygulama veya belirli bir not defteri için zengin genel bakış ve özet istatistiklerini döner."""
    with _lock:
        conn = get_conn()
        cur = conn.cursor()

        if notebook_id is None:
            cur.execute("SELECT value FROM settings WHERE key = 'active_notebook_id'")
            r = cur.fetchone()
            notebook_id = int(r[0]) if r and r[0] else 1

        cur.execute("SELECT name, icon FROM notebooks WHERE id = ?", (notebook_id,))
        nb_row = cur.fetchone()
        nb_name = nb_row[0] if nb_row else "Genel"
        nb_icon = nb_row[1] if nb_row else "📓"

        # 1. Genel Sayılar
        cur.execute("SELECT COUNT(*) FROM categories WHERE notebook_id = ?", (notebook_id,))
        total_categories = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM pages p JOIN categories c ON p.category_id = c.id WHERE c.notebook_id = ? AND p.is_archived = 0", (notebook_id,))
        total_pages = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM items i JOIN pages p ON i.page_id = p.id JOIN categories c ON p.category_id = c.id WHERE c.notebook_id = ?", (notebook_id,))
        total_items = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM items i JOIN pages p ON i.page_id = p.id JOIN categories c ON p.category_id = c.id WHERE c.notebook_id = ? AND i.is_done = 1", (notebook_id,))
        completed_items = cur.fetchone()[0]
        pending_items = total_items - completed_items

        # Sayfa türlerine göre dağılım
        cur.execute("SELECT p.type, COUNT(*) FROM pages p JOIN categories c ON p.category_id = c.id WHERE c.notebook_id = ? AND p.is_archived = 0 GROUP BY p.type", (notebook_id,))
        type_counts = dict(cur.fetchall())

        # 2. Bu ayki Finans Durumu
        now = datetime.now()
        current_period = now.strftime('%Y-%m')

        cur.execute("""
            SELECT 
                COALESCE(SUM(CASE WHEN fe.entry_type = 'income' THEN fe.amount ELSE 0 END), 0) as income,
                COALESCE(SUM(CASE WHEN fe.entry_type = 'expense' THEN fe.amount ELSE 0 END), 0) as expense,
                COALESCE(SUM(CASE WHEN fe.entry_type = 'expense' AND fe.is_paid = 0 THEN fe.amount ELSE 0 END), 0) as unpaid_expense,
                COUNT(CASE WHEN fe.entry_type = 'expense' AND fe.is_paid = 0 THEN 1 END) as unpaid_count
            FROM finance_entries fe
            JOIN pages p ON fe.page_id = p.id
            JOIN categories c ON p.category_id = c.id
            WHERE c.notebook_id = ? AND fe.period = ?
        """, (notebook_id, current_period))
        f_row = cur.fetchone()
        finance_summary = {
            "period": current_period,
            "income": float(f_row["income"] or 0),
            "expense": float(f_row["expense"] or 0),
            "net": float((f_row["income"] or 0) - (f_row["expense"] or 0)),
            "unpaid_expense": float(f_row["unpaid_expense"] or 0),
            "unpaid_count": int(f_row["unpaid_count"] or 0)
        }

        # Bu ay yaklaşan / vadesi gelmiş ödemeler (en yakın 6 tanesi)
        cur.execute("""
            SELECT fe.id, fe.page_id, fe.title, fe.amount, fe.due_day, fe.due_date, fe.category, fe.is_paid, p.title as page_title
            FROM finance_entries fe
            JOIN pages p ON fe.page_id = p.id
            JOIN categories c ON p.category_id = c.id
            WHERE c.notebook_id = ? AND fe.period = ? AND fe.entry_type = 'expense' AND fe.is_paid = 0
            ORDER BY fe.due_day ASC
            LIMIT 6
        """, (notebook_id, current_period))
        upcoming_bills = [dict(r) for r in cur.fetchall()]

        # 3. Aktif Projeler
        cur.execute("""
            SELECT p.id, p.title, p.icon, p.updated_at,
                   COALESCE(pd.status, 'planning') as status,
                   (SELECT COUNT(*) FROM project_milestones pm WHERE pm.page_id = p.id) as total_milestones,
                   (SELECT COUNT(*) FROM project_milestones pm WHERE pm.page_id = p.id AND pm.status = 'completed') as completed_milestones
            FROM pages p
            JOIN categories c ON p.category_id = c.id
            LEFT JOIN project_details pd ON pd.page_id = p.id
            WHERE c.notebook_id = ? AND p.type = 'project' AND p.is_archived = 0
            ORDER BY p.updated_at DESC
            LIMIT 6
        """, (notebook_id,))
        projects = []
        for r in cur.fetchall():
            p_dict = dict(r)
            m_total = p_dict.get("total_milestones", 0)
            m_done = p_dict.get("completed_milestones", 0)
            p_dict["progress"] = int((m_done / m_total * 100)) if m_total > 0 else 0
            projects.append(p_dict)

        # 4. Son Eklenen / Bekleyen Yapılacaklar (en son 8 bekleyen madde)
        cur.execute("""
            SELECT i.id, i.title, i.quantity, i.price, i.url, i.page_id, p.title as page_title, p.icon as page_icon
            FROM items i
            JOIN pages p ON i.page_id = p.id
            JOIN categories c ON p.category_id = c.id
            WHERE c.notebook_id = ? AND i.is_done = 0
            ORDER BY i.id DESC
            LIMIT 8
        """, (notebook_id,))
        pending_tasks = [dict(r) for r in cur.fetchall()]

        # 5. Son Güncellenen Sayfalar
        cur.execute("""
            SELECT p.id, p.title, p.icon, p.type, p.updated_at, c.name as category_name,
                   (SELECT COUNT(*) FROM items it WHERE it.page_id = p.id) as item_count
            FROM pages p
            JOIN categories c ON p.category_id = c.id
            WHERE c.notebook_id = ? AND p.is_archived = 0
            ORDER BY p.updated_at DESC
            LIMIT 6
        """, (notebook_id,))
        recent_pages = [dict(r) for r in cur.fetchall()]

        # Hızlı atlama sayfaları
        first_finance_page = None
        first_project_page = None
        first_checklist_page = None

        cur.execute("""
            SELECT p.id FROM pages p
            JOIN categories c ON p.category_id = c.id
            WHERE c.notebook_id = ? AND p.type = 'finance' AND p.is_archived = 0
            ORDER BY p.id ASC LIMIT 1
        """, (notebook_id,))
        f_res = cur.fetchone()
        if f_res: first_finance_page = f_res[0]

        cur.execute("""
            SELECT p.id FROM pages p
            JOIN categories c ON p.category_id = c.id
            WHERE c.notebook_id = ? AND p.type = 'project' AND p.is_archived = 0
            ORDER BY p.id ASC LIMIT 1
        """, (notebook_id,))
        pr_res = cur.fetchone()
        if pr_res: first_project_page = pr_res[0]

        cur.execute("""
            SELECT p.id FROM pages p
            JOIN categories c ON p.category_id = c.id
            WHERE c.notebook_id = ? AND p.type = 'checklist' AND p.is_archived = 0
            ORDER BY p.id ASC LIMIT 1
        """, (notebook_id,))
        ch_res = cur.fetchone()
        if ch_res: first_checklist_page = ch_res[0]

        conn.close()

        return {
            "notebook_id": notebook_id,
            "notebook_name": nb_name,
            "notebook_icon": nb_icon,
            "total_categories": total_categories,
            "total_pages": total_pages,
            "total_items": total_items,
            "completed_items": completed_items,
            "pending_items": pending_items,
            "type_counts": type_counts,
            "finance_summary": finance_summary,
            "upcoming_bills": upcoming_bills,
            "projects": projects,
            "pending_tasks": pending_tasks,
            "recent_pages": recent_pages,
            "first_finance_page": first_finance_page,
            "first_project_page": first_project_page,
            "first_checklist_page": first_checklist_page
        }

def get_full_export_data() -> dict:
    """Tüm TincNote verilerini JSON/Yedekleme formatında döner."""
    with _lock:
        conn = get_conn()
        cur = conn.cursor()

        cur.execute("SELECT * FROM categories ORDER BY sort_order, id")
        categories = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM pages WHERE is_archived = 0 ORDER BY sort_order, id")
        pages = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM items ORDER BY page_id, sort_order, id")
        items = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM finance_entries ORDER BY period, due_day, id")
        finance_entries = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM project_details")
        project_details = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM project_milestones ORDER BY page_id, sort_order, id")
        project_milestones = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM project_materials ORDER BY page_id, id")
        project_materials = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM project_logs ORDER BY page_id, log_date DESC, id DESC")
        project_logs = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM vault_entries WHERE is_archived = 0 ORDER BY id")
        vault_entries = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM vault_folders ORDER BY name ASC")
        vault_folders = [dict(r) for r in cur.fetchall()]

        conn.close()

        return {
            "app": "TincNote",
            "version": "1.0",
            "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "categories": categories,
            "pages": pages,
            "items": items,
            "finance_entries": finance_entries,
            "project_details": project_details,
            "project_milestones": project_milestones,
            "project_materials": project_materials,
            "project_logs": project_logs,
            "vault_entries": vault_entries,
            "vault_folders": vault_folders
        }

# ─────────────────────────────────────────────────────────────────────────────
# Global Arama (Spotlight / Hızlı Bulucu)
# ─────────────────────────────────────────────────────────────────────────────

def global_search(query: str) -> dict:
    if not query or not query.strip():
        return {"query": "", "total_count": 0, "pages": [], "items": [], "finance": [], "projects": [], "vault": []}

    q = f"%{query.strip()}%"
    with _lock:
        conn = get_conn()
        cur = conn.cursor()

        # 1. Sayfalar (Notlar ve Listeler)
        cur.execute("""
            SELECT p.id, p.title, p.icon, p.type, p.content, c.name as category_name, c.icon as category_icon
            FROM pages p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.is_archived = 0 AND (p.title LIKE ? OR p.content LIKE ?)
            ORDER BY p.updated_at DESC LIMIT 20
        """, (q, q))
        pages = [dict(r) for r in cur.fetchall()]

        # 2. Maddeler / Görevler
        cur.execute("""
            SELECT i.id, i.page_id, i.title, i.description, i.price, i.is_done,
                   p.title as page_title, p.icon as page_icon, p.type as page_type
            FROM items i
            JOIN pages p ON p.id = i.page_id AND p.is_archived = 0
            WHERE i.title LIKE ? OR i.description LIKE ?
            ORDER BY i.updated_at DESC LIMIT 30
        """, (q, q))
        items = [dict(r) for r in cur.fetchall()]

        # 3. Finans Kayıtları
        cur.execute("""
            SELECT f.id, f.page_id, f.title, f.amount, f.entry_type, f.period, f.category, f.is_paid,
                   p.title as page_title, p.icon as page_icon
            FROM finance_entries f
            JOIN pages p ON p.id = f.page_id AND p.is_archived = 0
            WHERE f.title LIKE ? OR f.notes LIKE ? OR f.category LIKE ?
            ORDER BY f.period DESC, f.due_day ASC LIMIT 20
        """, (q, q, q))
        finance = [dict(r) for r in cur.fetchall()]

        # 4. Proje Kayıtları (Milestones & Materials & Logs)
        cur.execute("""
            SELECT m.id, m.page_id, m.title, m.target_date, m.status, 'milestone' as proj_type,
                   p.title as page_title, p.icon as page_icon
            FROM project_milestones m
            JOIN pages p ON p.id = m.page_id AND p.is_archived = 0
            WHERE m.title LIKE ? OR m.description LIKE ?
            LIMIT 15
        """, (q, q))
        projects = [dict(r) for r in cur.fetchall()]

        # 5. Şifre Kasası (Güvenlik için şifre alanı maskeli döner)
        cur.execute("""
            SELECT id, title, category, scope, profile_name, folder_name, tags, username, url, secondary_info, icon, color, is_favorite
            FROM vault_entries
            WHERE is_archived = 0 AND (title LIKE ? OR username LIKE ? OR profile_name LIKE ? OR folder_name LIKE ? OR tags LIKE ? OR scope LIKE ? OR notes LIKE ? OR secondary_info LIKE ?)
            ORDER BY is_favorite DESC, updated_at DESC LIMIT 20
        """, (q, q, q, q, q, q, q, q))
        vault = [dict(r) for r in cur.fetchall()]

        conn.close()

        total_count = len(pages) + len(items) + len(finance) + len(projects) + len(vault)
        return {
            "query": query,
            "total_count": total_count,
            "pages": pages,
            "items": items,
            "finance": finance,
            "projects": projects,
            "vault": vault
        }

# ─────────────────────────────────────────────────────────────────────────────
# Şifreler & Kimlik Bilgileri Kasası (Vault)
# ─────────────────────────────────────────────────────────────────────────────

def get_vault_entries(scope: str = None, category: str = None, profile_name: str = None, folder_name: str = None, tag: str = None, search: str = None, user_id: int = None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        query = "SELECT * FROM vault_entries WHERE is_archived = 0"
        params = []
        if user_id is not None:
            query += " AND (user_id = ? OR user_id IS NULL OR scope = 'shared')"
            params.append(user_id)
        if scope and scope != 'all':
            query += " AND scope = ?"
            params.append(scope)
        if category and category != 'all':
            query += " AND category = ?"
            params.append(category)
        if profile_name and profile_name != 'all':
            query += " AND profile_name = ?"
            params.append(profile_name)
        if folder_name and folder_name != 'all':
            query += " AND folder_name = ?"
            params.append(folder_name)
        if tag and tag != 'all':
            t = tag.strip().lstrip('#')
            query += " AND (tags LIKE ? OR tags LIKE ? OR tags LIKE ? OR tags = ?)"
            params.extend([f"%#{t}%", f"%,{t}%", f"%{t},%", t])
        if search:
            query += " AND (title LIKE ? OR username LIKE ? OR notes LIKE ? OR profile_name LIKE ? OR folder_name LIKE ? OR tags LIKE ? OR secondary_info LIKE ?)"
            s = f"%{search.strip()}%"
            params.extend([s, s, s, s, s, s, s])
        query += " ORDER BY is_favorite DESC, updated_at DESC, id DESC"
        cur.execute(query, params)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()

        # Güvenlik: Asla açık şifre dönme, sadece varlık bilgisi ve maskeli değer dön
        clean_rows = []
        for r in rows:
            entry = dict(r)
            raw_pwd = entry.get('password') or ""
            entry['has_password'] = bool(raw_pwd)
            entry['password'] = "••••••••" if raw_pwd else ""
            raw_sec = entry.get('secondary_info') or ""
            entry['has_secondary_info'] = bool(raw_sec)
            entry['secondary_info'] = "••••••••" if raw_sec else ""
            clean_rows.append(entry)
        return clean_rows

def get_vault_folders():
    """Tüm kasa klasörlerini ve içlerindeki aktif şifre sayılarını döner."""
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        # vault_entries içindeki tanımlı ama vault_folders'ta olmayan klasörleri senkronize et
        cur.execute("SELECT DISTINCT folder_name FROM vault_entries WHERE is_archived = 0 AND folder_name != ''")
        for r in cur.fetchall():
            cur.execute("INSERT OR IGNORE INTO vault_folders (name) VALUES (?)", (r[0],))
        conn.commit()

        cur.execute("""
            SELECT f.id, f.name, f.icon, f.color,
                   COUNT(v.id) as count
            FROM vault_folders f
            LEFT JOIN vault_entries v ON v.folder_name = f.name AND v.is_archived = 0
            GROUP BY f.id
            ORDER BY f.name COLLATE NOCASE ASC
        """)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def add_vault_folder(name: str, icon: str = "📁", color: str = "#3b82f6") -> int:
    name = name.strip()
    if not name:
        return 0
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("INSERT OR IGNORE INTO vault_folders (name, icon, color) VALUES (?, ?, ?)", (name, icon or "📁", color or "#3b82f6"))
        new_id = cur.lastrowid
        conn.commit()
        conn.close()
        return new_id

def rename_vault_folder(old_name: str, new_name: str) -> bool:
    old_name = old_name.strip()
    new_name = new_name.strip()
    if not old_name or not new_name:
        return False
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE vault_folders SET name = ? WHERE name = ?", (new_name, old_name))
        cur.execute("UPDATE vault_entries SET folder_name = ? WHERE folder_name = ?", (new_name, old_name))
        conn.commit()
        conn.close()
        return True

def delete_vault_folder(name: str) -> bool:
    name = name.strip()
    if not name:
        return False
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM vault_folders WHERE name = ?", (name,))
        cur.execute("UPDATE vault_entries SET folder_name = '' WHERE folder_name = ?", (name,))
        conn.commit()
        conn.close()
        return True

def get_vault_tags():
    """Kasadaki tüm etiketleri ve kullanım adetlerini döner."""
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT tags FROM vault_entries WHERE is_archived = 0 AND tags != ''")
        tag_counts = {}
        for row in cur.fetchall():
            raw = row[0] or ""
            parts = [p.strip() for p in raw.replace(";", ",").replace(" ", ",").split(",") if p.strip()]
            for p in parts:
                clean_t = p.lstrip("#").strip()
                if clean_t:
                    tag_counts[clean_t] = tag_counts.get(clean_t, 0) + 1
        conn.close()
        return [{"tag": k, "count": v} for k, v in sorted(tag_counts.items(), key=lambda x: (-x[1], x[0]))]

def get_vault_profiles():
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            SELECT profile_name, COUNT(id) as count
            FROM vault_entries
            WHERE is_archived = 0 AND profile_name != ''
            GROUP BY profile_name
            ORDER BY profile_name COLLATE NOCASE ASC
        """)
        profiles = [dict(r) for r in cur.fetchall()]
        conn.close()
        return profiles

def get_related_vault_entries(entry_id: int):
    """Belirli bir şifre kaydıyla ilişkili (aynı kişi, aynı klasör veya benzer web servisi) diğer kayıtları döner."""
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM vault_entries WHERE id = ?", (entry_id,))
        curr = cur.fetchone()
        if not curr:
            conn.close()
            return {"by_profile": [], "by_folder": [], "by_domain": []}
        curr = dict(curr)
        profile = curr.get("profile_name", "").strip()
        folder = curr.get("folder_name", "").strip()
        url = curr.get("url", "").strip()

        domain = ""
        if url:
            try:
                from urllib.parse import urlparse
                domain = urlparse(url if "://" in url else f"http://{url}").netloc.lower()
                if domain.startswith("www."):
                    domain = domain[4:]
            except Exception:
                domain = ""

        by_profile = []
        if profile:
            cur.execute("""
                SELECT id, title, username, category, scope, folder_name, profile_name, icon, is_favorite
                FROM vault_entries
                WHERE is_archived = 0 AND profile_name = ? AND id != ?
                ORDER BY is_favorite DESC, title ASC LIMIT 10
            """, (profile, entry_id))
            by_profile = [dict(r) for r in cur.fetchall()]

        by_folder = []
        if folder:
            cur.execute("""
                SELECT id, title, username, category, scope, folder_name, profile_name, icon, is_favorite
                FROM vault_entries
                WHERE is_archived = 0 AND folder_name = ? AND id != ?
                ORDER BY is_favorite DESC, title ASC LIMIT 10
            """, (folder, entry_id))
            by_folder = [dict(r) for r in cur.fetchall()]

        by_domain = []
        if domain and len(domain) > 3:
            cur.execute("""
                SELECT id, title, username, category, scope, folder_name, profile_name, icon, is_favorite
                FROM vault_entries
                WHERE is_archived = 0 AND url LIKE ? AND id != ?
                ORDER BY is_favorite DESC, title ASC LIMIT 10
            """, (f"%{domain}%", entry_id))
            by_domain = [dict(r) for r in cur.fetchall()]

        conn.close()
        return {
            "current_title": curr.get("title", ""),
            "profile_name": profile,
            "folder_name": folder,
            "domain": domain,
            "by_profile": by_profile,
            "by_folder": by_folder,
            "by_domain": by_domain
        }

def get_vault_entry(entry_id: int, user_id: int = None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        if user_id is not None:
            cur.execute("SELECT * FROM vault_entries WHERE id = ? AND (user_id = ? OR user_id IS NULL OR scope = 'shared')", (entry_id, user_id))
        else:
            cur.execute("SELECT * FROM vault_entries WHERE id = ?", (entry_id,))
        row = cur.fetchone()
        conn.close()
        if not row:
            return None
        d = dict(row)
        d['password'] = decrypt_vault_secret(d.get('password', ''))
        d['secondary_info'] = decrypt_vault_secret(d.get('secondary_info', ''))
        return d

def get_vault_entry_decrypted(entry_id: int, user_id: int = None):
    return get_vault_entry(entry_id, user_id=user_id)

def add_vault_entry(title: str, category: str = "web", scope: str = "personal", profile_name: str = "",
                    folder_name: str = "", tags: str = "",
                    username: str = "", password: str = "", url: str = "", secondary_info: str = "",
                    notes: str = "", icon: str = "🔐", color: str = "#3b82f6", is_favorite: int = 0, user_id: int = 1) -> int:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        folder_clean = folder_name.strip()
        if folder_clean:
            cur.execute("INSERT OR IGNORE INTO vault_folders (name, user_id) VALUES (?, ?)", (folder_clean, user_id or 1))

        enc_pwd = encrypt_vault_secret(password)
        enc_sec = encrypt_vault_secret(secondary_info)

        cur.execute("""
            INSERT INTO vault_entries (title, category, scope, profile_name, folder_name, tags, username, password, url, secondary_info, notes, icon, color, is_favorite, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (title.strip(), category, scope, profile_name.strip(), folder_clean, tags.strip(), username.strip(), enc_pwd, url.strip(), enc_sec, notes.strip(), icon or "🔐", color or "#3b82f6", is_favorite, user_id or 1))
        new_id = cur.lastrowid
        conn.commit()
        conn.close()
        _log_action_internal("create_vault", "vault", new_id, f"'{title}' şifre/hesap kaydı eklendi ({scope})", payload_after={"id": new_id, "title": title})
        return new_id

def update_vault_entry(entry_id: int, **kwargs):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM vault_entries WHERE id = ?", (entry_id,))
        old = cur.fetchone()
        if not old:
            conn.close()
            return
        old_dict = dict(old)

        if "folder_name" in kwargs and kwargs["folder_name"]:
            cur.execute("INSERT OR IGNORE INTO vault_folders (name) VALUES (?)", (kwargs["folder_name"].strip(),))

        if "password" in kwargs and kwargs["password"]:
            if not str(kwargs["password"]).startswith("enc::"):
                kwargs["password"] = encrypt_vault_secret(str(kwargs["password"]))

        if "secondary_info" in kwargs and kwargs["secondary_info"]:
            if not str(kwargs["secondary_info"]).startswith("enc::"):
                kwargs["secondary_info"] = encrypt_vault_secret(str(kwargs["secondary_info"]))

        fields = []
        params = []
        allowed = ["title", "category", "scope", "profile_name", "folder_name", "tags", "username", "password", "url", "secondary_info", "notes", "icon", "color", "is_favorite", "is_archived", "user_id"]
        for k in allowed:
            if k in kwargs:
                fields.append(f"{k} = ?")
                params.append(kwargs[k])
        if fields:
            fields.append("updated_at = datetime('now', 'localtime')")
            params.append(entry_id)
            cur.execute(f"UPDATE vault_entries SET {', '.join(fields)} WHERE id = ?", params)
            conn.commit()
        conn.close()
        _log_action_internal("update_vault", "vault", entry_id, f"'{old_dict['title']}' şifre/hesap kaydı güncellendi", payload_before=old_dict)

def delete_vault_entry(entry_id: int, permanent: bool = False):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM vault_entries WHERE id = ?", (entry_id,))
        row = cur.fetchone()
        if not row:
            conn.close()
            return
        entry_dict = dict(row)
        if permanent:
            cur.execute("DELETE FROM vault_entries WHERE id = ?", (entry_id,))
            _log_action_internal("permanent_delete_vault", "vault", entry_id, f"'{entry_dict['title']}' şifre kaydı kalıcı silindi", payload_before=entry_dict)
        else:
            cur.execute("UPDATE vault_entries SET is_archived = 1, updated_at = datetime('now', 'localtime') WHERE id = ?", (entry_id,))
            _log_action_internal("delete_vault", "vault", entry_id, f"'{entry_dict['title']}' şifre kaydı silindi", payload_before=entry_dict)
        conn.commit()
        conn.close()

def toggle_vault_favorite(entry_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE vault_entries SET is_favorite = (1 - is_favorite) WHERE id = ?", (entry_id,))
        cur.execute("SELECT is_favorite FROM vault_entries WHERE id = ?", (entry_id,))
        row = cur.fetchone()
        fav = row[0] if row else 0
        conn.commit()
        conn.close()
        return fav

def get_unified_tasks(notebook_id: int = None):
    """
    Tüm kategori ve sayfalardan bekleyen görevleri ve vadesi yaklaşan ödemeleri
    tarih sırasına göre derler.
    """
    from datetime import datetime, date, timedelta
    today = date.today()

    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        if not notebook_id:
            cur.execute("SELECT id FROM notebooks WHERE is_default = 1")
            row = cur.fetchone()
            notebook_id = row["id"] if row else 1

        # 1. Tüm sayfalardaki bekleyen checklist maddeleri
        cur.execute("""
            SELECT i.id, i.page_id, i.title, i.price, i.quantity, i.is_done,
                   r.remind_at, r.recurrence,
                   p.title as page_title, p.icon as page_icon, p.type as page_type,
                   c.name as category_name, c.icon as category_icon, c.color as category_color
            FROM items i
            JOIN pages p ON i.page_id = p.id
            JOIN categories c ON p.category_id = c.id
            LEFT JOIN reminders r ON r.target_type = 'item' AND r.target_id = i.id AND r.is_sent = 0
            WHERE c.notebook_id = ? AND i.is_done = 0 AND p.is_archived = 0
            ORDER BY i.id DESC
        """, (notebook_id,))
        items = cur.fetchall()

        # 2. Tüm sayfalardaki ödenmemiş giderler / faturalar
        cur.execute("""
            SELECT fe.id, fe.page_id, fe.title, fe.amount, fe.due_day, fe.due_date, fe.category,
                   fe.is_paid, fe.period,
                   p.title as page_title, p.icon as page_icon,
                   c.name as category_name, c.icon as category_icon, c.color as category_color
            FROM finance_entries fe
            JOIN pages p ON fe.page_id = p.id
            JOIN categories c ON p.category_id = c.id
            WHERE c.notebook_id = ? AND fe.entry_type = 'expense' AND fe.is_paid = 0 AND p.is_archived = 0
        """, (notebook_id,))
        finances = cur.fetchall()

        # 3. Hızlı notlar
        cur.execute("""
            SELECT id, notebook_id, content, color, created_at
            FROM quick_notes
            WHERE notebook_id = ?
            ORDER BY id DESC
        """, (notebook_id,))
        quick_notes = cur.fetchall()
        conn.close()

    tasks = []
    current_year = today.year
    current_month = today.month

    # Ödemeleri dönüştür
    for f in finances:
        amt_val = f["amount"]
        amt_str = f"{amt_val:,.0f} TL".replace(",", ".") if amt_val else ""
        display_title = f"{f['title']}"
        if amt_str:
            display_title += f" ({amt_str})"

        task_date = None
        if f["due_date"]:
            try:
                task_date = datetime.strptime(str(f["due_date"]).strip(), "%Y-%m-%d").date()
            except Exception:
                pass

        if not task_date and f["due_day"]:
            try:
                day_num = min(max(int(f["due_day"]), 1), 28)
                task_date = date(current_year, current_month, day_num)
            except Exception:
                pass

        due_badge = "Ödeme"
        due_urgency = 5
        sort_str = "9999-99-99"

        if task_date:
            sort_str = task_date.strftime("%Y-%m-%d")
            diff = (task_date - today).days
            if diff < 0:
                due_urgency = 1
                due_badge = f"Gecikmiş ({task_date.strftime('%d.%m')})"
            elif diff == 0:
                due_urgency = 2
                due_badge = "Bugün"
            elif diff == 1:
                due_urgency = 3
                due_badge = "Yarın"
            elif diff <= 7:
                due_urgency = 4
                due_badge = task_date.strftime("%d.%m")
            else:
                due_urgency = 5
                due_badge = task_date.strftime("%d.%m")

        tasks.append({
            "id": f"fin_{f['id']}",
            "raw_id": f["id"],
            "type": "finance",
            "title": display_title,
            "price": amt_str,
            "quantity": None,
            "page_id": f["page_id"],
            "page_title": f["page_title"] or "Finans",
            "category_name": f["category"] or "Giderler",
            "is_done": bool(f["is_paid"]),
            "due_date": sort_str if sort_str != "9999-99-99" else None,
            "remind_at": None,
            "recurrence": "none",
            "due_badge": due_badge,
            "due_urgency": due_urgency,
            "sort_key": f"{due_urgency}_{sort_str}_{f['id']}"
        })

    # Checklist maddelerini ekle
    for it in items:
        title = it["title"]
        cat_name = (it["category_name"] or "").lower()
        page_title = (it["page_title"] or "").lower()
        is_quick = ("hızlı" in cat_name or "hizli" in cat_name or "hızlı" in page_title or "hizli" in page_title)
        due_urgency = 2.5 if is_quick else 6
        due_badge = "Hızlı" if is_quick else None

        remind_at = it["remind_at"] if "remind_at" in it.keys() and it["remind_at"] else None
        recurrence = it["recurrence"] if "recurrence" in it.keys() and it["recurrence"] else "none"

        if remind_at:
            try:
                dt_obj = datetime.strptime(str(remind_at).strip()[:19], "%Y-%m-%d %H:%M:%S")
                due_badge = "⏰ " + (dt_obj.strftime("%H:%M") if dt_obj.date() == today else dt_obj.strftime("%d.%m %H:%M"))
                due_urgency = 1.5 if dt_obj.date() <= today else 2.2
            except Exception:
                due_badge = f"⏰ {remind_at[:16]}"
                due_urgency = 2.0

        tasks.append({
            "id": f"item_{it['id']}",
            "raw_id": it["id"],
            "type": "checklist",
            "title": title,
            "price": it["price"],
            "quantity": it["quantity"],
            "page_id": it["page_id"],
            "page_title": it["page_title"] or "Liste",
            "category_name": cat_name or "Genel",
            "is_done": bool(it["is_done"]),
            "due_date": None,
            "remind_at": remind_at,
            "recurrence": recurrence,
            "due_badge": due_badge,
            "due_urgency": due_urgency,
            "sort_key": f"{due_urgency}_9999-99-99_{it['id']}"
        })

    # 3. Hızlı notları ekle
    for qn in quick_notes:
        content = (qn["content"] or "").strip()
        first_line = content.split('\n')[0] if content else ""
        if first_line:
            tasks.append({
                "id": f"qn_{qn['id']}",
                "raw_id": qn["id"],
                "type": "quick_note",
                "title": first_line,
                "price": None,
                "quantity": None,
                "page_id": 0,
                "page_title": "Hızlı Not",
                "category_name": "Notlar",
                "is_done": False,
                "due_date": None,
                "due_badge": "Not",
                "due_urgency": 3.5,
                "sort_key": f"3.5_9999-99-99_{qn['id']}"
            })

    tasks.sort(key=lambda x: x["sort_key"])
    return tasks

def toggle_unified_task(task_type: str, raw_id: int):
    """
    Checklist maddesini veya finans kaydını tamamlandı olarak işaretler/tersine çevirir.
    """
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        if task_type == 'finance':
            cur.execute("UPDATE finance_entries SET is_paid = (1 - is_paid), paid_at = CURRENT_TIMESTAMP WHERE id = ?", (raw_id,))
            cur.execute("SELECT is_paid FROM finance_entries WHERE id = ?", (raw_id,))
            row = cur.fetchone()
            is_done = bool(row[0]) if row else False
        else:
            cur.execute("UPDATE items SET is_done = (1 - is_done), updated_at = CURRENT_TIMESTAMP WHERE id = ?", (raw_id,))
            cur.execute("SELECT is_done FROM items WHERE id = ?", (raw_id,))
            row = cur.fetchone()
            is_done = bool(row[0]) if row else False
        conn.commit()
        conn.close()
        return is_done

def get_quick_notes(notebook_id=None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        if notebook_id:
            cur.execute("""
                SELECT id, notebook_id, content, color, created_at, updated_at
                FROM quick_notes
                WHERE notebook_id = ?
                ORDER BY id DESC
            """, (int(notebook_id),))
        else:
            cur.execute("""
                SELECT id, notebook_id, content, color, created_at, updated_at
                FROM quick_notes
                ORDER BY id DESC
            """)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows

def add_quick_note(content: str, notebook_id: int = 1, color: str = '#ffffff'):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO quick_notes (notebook_id, content, color, created_at, updated_at)
            VALUES (?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
        """, (int(notebook_id or 1), content.strip(), color or '#ffffff'))
        note_id = cur.lastrowid
        conn.commit()
        conn.close()
        return note_id

def delete_quick_note(note_id: int):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM quick_notes WHERE id = ?", (int(note_id),))
        conn.commit()
        conn.close()
        return True

def update_quick_note(note_id: int, content: str):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            UPDATE quick_notes
            SET content = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
        """, (content.strip(), int(note_id)))
        conn.commit()
        conn.close()
        return True

def move_quick_note(note_id: int, target_page_id: int = None, target_category_id: int = None, new_page_title: str = None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM quick_notes WHERE id = ?", (int(note_id),))
        note = cur.fetchone()
        if not note:
            conn.close()
            return False, "Hızlı not bulunamadı", None

        content = note["content"]
        res_page_id = target_page_id

        if target_page_id:
            cur.execute("SELECT * FROM pages WHERE id = ?", (int(target_page_id),))
            page = cur.fetchone()
            if not page:
                conn.close()
                return False, "Hedef sayfa bulunamadı", None

            if page["type"] == 'checklist':
                cur.execute("""
                    INSERT INTO items (page_id, title, is_done, sort_order)
                    VALUES (?, ?, 0, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM items WHERE page_id = ?))
                """, (int(target_page_id), content, int(target_page_id)))
            else:
                existing = page["content"] or ""
                sep = "\n\n---\n" if existing.strip() else ""
                new_content = existing + sep + content
                cur.execute("""
                    UPDATE pages SET content = ?, updated_at = datetime('now', 'localtime') WHERE id = ?
                """, (new_content, int(target_page_id)))

        elif target_category_id and new_page_title:
            cur.execute("""
                INSERT INTO pages (category_id, title, type, icon, content)
                VALUES (?, ?, 'notes', '📝', ?)
            """, (int(target_category_id), new_page_title.strip(), content))
            res_page_id = cur.lastrowid
        else:
            conn.close()
            return False, "Hedef sayfa veya kategori seçilmedi", None

        cur.execute("DELETE FROM quick_notes WHERE id = ?", (int(note_id),))
        conn.commit()
        conn.close()
        return True, "Not başarıyla aktarıldı", res_page_id

def add_quick_task(title: str, notebook_id: int = None):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        nb_id = int(notebook_id or get_active_notebook_id() or 1)

        # 1. Kategori bul veya oluştur
        cur.execute("""
            SELECT id FROM categories
            WHERE notebook_id = ? AND (
                LOWER(name) LIKE '%hızlı%' OR LOWER(name) LIKE '%hizli%'
            )
            LIMIT 1
        """, (nb_id,))
        cat_row = cur.fetchone()
        if cat_row:
            cat_id = cat_row[0]
        else:
            cur.execute("""
                INSERT INTO categories (notebook_id, name, icon, color, sort_order)
                VALUES (?, 'Hızlı Notlar & Görevler', '⚡', '#0284c7', 0)
            """, (nb_id,))
            cat_id = cur.lastrowid

        # 2. Sayfa bul veya oluştur
        cur.execute("""
            SELECT id FROM pages
            WHERE category_id = ? AND (
                LOWER(title) LIKE '%hızlı%' OR LOWER(title) LIKE '%hizli%'
            )
            LIMIT 1
        """, (cat_id,))
        page_row = cur.fetchone()
        if page_row:
            page_id = page_row[0]
        else:
            cur.execute("""
                INSERT INTO pages (category_id, title, type, icon)
                VALUES (?, 'Hızlı Görevler', 'checklist', '⚡')
            """, (cat_id,))
            page_id = cur.lastrowid

        # 3. Madde ekle
        cur.execute("""
            INSERT INTO items (page_id, title, is_done, sort_order)
            VALUES (?, ?, 0, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM items WHERE page_id = ?))
        """, (page_id, title.strip(), page_id))
        item_id = cur.lastrowid

        conn.commit()
        conn.close()
        return {"item_id": item_id, "page_id": page_id, "category_id": cat_id}

# ─────────────────────────────────────────────────────────────────────────────
# ÇOKLU KULLANICI & KİMLİK DOĞRULAMA (MULTI-USER & AUTH)
# ─────────────────────────────────────────────────────────────────────────────
import secrets
from werkzeug.security import generate_password_hash, check_password_hash

def get_user_count():
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM users")
    count = cur.fetchone()[0]
    conn.close()
    return count

def register_user(username, password, display_name="", email="", role=None):
    username = username.strip().lower()
    if not username or not password:
        return {"ok": False, "error": "Kullanıcı adı ve şifre zorunludur"}

    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT id FROM users WHERE username = ?", (username,))
    if cur.fetchone():
        conn.close()
        return {"ok": False, "error": "Bu kullanıcı adı zaten kayıtlı"}

    cur.execute("SELECT COUNT(*) FROM users")
    is_first = (cur.fetchone()[0] == 0)
    user_role = role or ("admin" if is_first else "user")

    pwd_hash = generate_password_hash(password)
    token = secrets.token_hex(24)

    cur.execute("""
        INSERT INTO users (username, password_hash, display_name, email, role, auth_token)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (username, pwd_hash, display_name.strip() or username, email.strip(), user_role, token))
    user_id = cur.lastrowid

    cur.execute("""
        INSERT INTO notebooks (name, icon, color, description, is_default, user_id)
        VALUES (?, '📓', '#3b82f6', 'Kişisel not defteriniz', 1, ?)
    """, (f"{display_name or username} Defteri", user_id))
    nb_id = cur.lastrowid

    cur.execute("""
        INSERT INTO categories (name, icon, color, notebook_id)
        VALUES ('Hızlı Notlar ve Görevler', '⚡', '#f59e0b', ?)
    """, (nb_id,))

    conn.commit()
    conn.close()

    return {
        "ok": True,
        "user": {
            "id": user_id,
            "username": username,
            "display_name": display_name or username,
            "email": email,
            "role": user_role
        },
        "token": token
    }

def login_user(username, password):
    username = username.strip().lower()
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM users WHERE username = ?", (username,))
    row = cur.fetchone()
    if not row:
        conn.close()
        return {"ok": False, "error": "Kullanıcı adı veya şifre hatalı"}

    user = dict(row)
    if not check_password_hash(user["password_hash"], password):
        conn.close()
        return {"ok": False, "error": "Kullanıcı adı veya şifre hatalı"}

    token = secrets.token_hex(24)
    cur.execute("UPDATE users SET auth_token = ?, updated_at = datetime('now', 'localtime') WHERE id = ?", (token, user["id"]))
    conn.commit()
    conn.close()

    return {
        "ok": True,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"] or user["username"],
            "email": user["email"],
            "role": user["role"]
        },
        "token": token
    }

def get_user_by_token(token):
    if not token:
        return None
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT id, username, display_name, email, role, created_at FROM users WHERE auth_token = ?", (token,))
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None

def get_user_by_id(user_id):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT id, username, display_name, email, role, created_at FROM users WHERE id = ?", (user_id,))
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None

def get_all_users():
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT id, username, display_name, email, role, created_at FROM users ORDER BY id ASC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

# ─────────────────────────────────────────────────────────────────────────────
# DEFTER DIŞA / İÇE AKTARMA (EXPORT & BACKUP MOTORU)
# ─────────────────────────────────────────────────────────────────────────────
def export_notebook_data(notebook_id):
    """Bir not defterini tüm kategori, sayfa ve maddeleriyle JSON olarak dışa aktarır."""
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("SELECT * FROM notebooks WHERE id = ?", (notebook_id,))
    nb = cur.fetchone()
    if not nb:
        conn.close()
        return None
    nb_data = dict(nb)

    cur.execute("SELECT * FROM categories WHERE notebook_id = ?", (notebook_id,))
    categories = [dict(c) for c in cur.fetchall()]
    cat_ids = [c["id"] for c in categories]

    pages = []
    items = []
    finance = []
    milestones = []
    materials = []

    if cat_ids:
        placeholders = ','.join(['?'] * len(cat_ids))
        cur.execute(f"SELECT * FROM pages WHERE category_id IN ({placeholders})", cat_ids)
        pages = [dict(p) for p in cur.fetchall()]
        page_ids = [p["id"] for p in pages]

        if page_ids:
            p_placeholders = ','.join(['?'] * len(page_ids))
            cur.execute(f"SELECT * FROM items WHERE page_id IN ({p_placeholders})", page_ids)
            items = [dict(i) for i in cur.fetchall()]

            cur.execute(f"SELECT * FROM finance_entries WHERE page_id IN ({p_placeholders})", page_ids)
            finance = [dict(f) for f in cur.fetchall()]

            cur.execute(f"SELECT * FROM project_milestones WHERE page_id IN ({p_placeholders})", page_ids)
            milestones = [dict(m) for m in cur.fetchall()]

            cur.execute(f"SELECT * FROM project_materials WHERE page_id IN ({p_placeholders})", page_ids)
            materials = [dict(m) for m in cur.fetchall()]

    cur.execute("SELECT * FROM quick_notes WHERE notebook_id = ?", (notebook_id,))
    quick_notes = [dict(q) for q in cur.fetchall()]

    conn.close()

    return {
        "version": "1.5.3",
        "exported_at": datetime.now().isoformat(),
        "notebook": nb_data,
        "categories": categories,
        "pages": pages,
        "items": items,
        "finance": finance,
        "milestones": milestones,
        "materials": materials,
        "quick_notes": quick_notes
    }

def import_notebook_data(data, user_id=1):
    """Dışarıdan alınan yedek JSON verisini yeni bir not defteri olarak sisteme geri yükler."""
    if not isinstance(data, dict) or "notebook" not in data:
        return {"ok": False, "error": "Geçersiz yedek formatı"}

    conn = get_conn()
    cur = conn.cursor()

    orig_nb = data["notebook"]
    cur.execute("""
        INSERT INTO notebooks (name, icon, color, description, is_default, user_id)
        VALUES (?, ?, ?, ?, 0, ?)
    """, (f"{orig_nb.get('name', 'İçe Aktarılan Defter')} (Yedek)", orig_nb.get("icon", "📓"), orig_nb.get("color", "#3b82f6"), orig_nb.get("description", ""), user_id))
    new_nb_id = cur.lastrowid

    cat_map = {}
    for cat in data.get("categories", []):
        cur.execute("""
            INSERT INTO categories (notebook_id, name, icon, color, sort_order)
            VALUES (?, ?, ?, ?, ?)
        """, (new_nb_id, cat.get("name"), cat.get("icon", "📁"), cat.get("color", "#3b82f6"), cat.get("sort_order", 0)))
        cat_map[cat["id"]] = cur.lastrowid

    page_map = {}
    for page in data.get("pages", []):
        old_cat_id = page.get("category_id")
        new_cat_id = cat_map.get(old_cat_id)
        if not new_cat_id:
            continue
        cur.execute("""
            INSERT INTO pages (category_id, title, type, icon, content, sort_order, is_archived)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (new_cat_id, page.get("title"), page.get("type", "checklist"), page.get("icon", "📄"), page.get("content", ""), page.get("sort_order", 0), page.get("is_archived", 0)))
        page_map[page["id"]] = cur.lastrowid

    for item in data.get("items", []):
        new_page_id = page_map.get(item.get("page_id"))
        if new_page_id:
            cur.execute("""
                INSERT INTO items (page_id, title, quantity, price, url, is_done, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (new_page_id, item.get("title"), item.get("quantity", ""), item.get("price", ""), item.get("url", ""), item.get("is_done", 0), item.get("sort_order", 0)))

    for qn in data.get("quick_notes", []):
        cur.execute("""
            INSERT INTO quick_notes (notebook_id, content, color)
            VALUES (?, ?, ?)
        """, (new_nb_id, qn.get("content"), qn.get("color", "#ffffff")))

    conn.commit()
    conn.close()

    return {"ok": True, "notebook_id": new_nb_id}

# ─────────────────────────────────────────────────────────────────────────────
# Yazılım Projeleri Yönetimi (TincSync & AI / CLI Agent Entegrasyonlu)
# ─────────────────────────────────────────────────────────────────────────────

def get_software_project(page_id: int):
    """Belirtilen sayfa için yazılım projesi ayarlarını döner, yoksa varsayılan oluşturur."""
    import uuid
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM software_projects WHERE page_id = ?", (page_id,))
    row = cur.fetchone()
    if not row:
        api_key = f"tn_agent_{uuid.uuid4().hex[:12]}"
        cur.execute("SELECT title FROM pages WHERE id = ?", (page_id,))
        p = cur.fetchone()
        repo_name = p["title"] if p else "project"
        cur.execute("""
            INSERT INTO software_projects (page_id, repo_name, repo_path, branch, tech_stack, api_key, system_architecture)
            VALUES (?, ?, '', 'main', '', ?, '')
        """, (page_id, repo_name, api_key))
        conn.commit()
        cur.execute("SELECT * FROM software_projects WHERE page_id = ?", (page_id,))
        row = cur.fetchone()
    conn.close()
    return dict(row) if row else {}

def update_software_project(page_id: int, repo_name=None, repo_path=None, branch=None, tech_stack=None, api_key=None, system_architecture=None):
    """Yazılım projesi yapılandırmasını günceller."""
    conn = get_conn()
    cur = conn.cursor()
    updates = []
    params = []
    if repo_name is not None:
        updates.append("repo_name = ?")
        params.append(repo_name.strip())
    if repo_path is not None:
        updates.append("repo_path = ?")
        params.append(repo_path.strip())
    if branch is not None:
        updates.append("branch = ?")
        params.append(branch.strip())
    if tech_stack is not None:
        updates.append("tech_stack = ?")
        params.append(tech_stack.strip())
    if api_key is not None:
        updates.append("api_key = ?")
        params.append(api_key.strip())
    if system_architecture is not None:
        updates.append("system_architecture = ?")
        params.append(system_architecture)
    updates.append("updated_at = datetime('now', 'localtime')")
    
    if updates:
        params.append(page_id)
        cur.execute(f"UPDATE software_projects SET {', '.join(updates)} WHERE page_id = ?", params)
        conn.commit()
    conn.close()
    return get_software_project(page_id)

def get_software_rules(page_id: int, category: str = None):
    conn = get_conn()
    cur = conn.cursor()
    if category:
        cur.execute("SELECT * FROM software_rules WHERE page_id = ? AND category = ? ORDER BY sort_order ASC, id ASC", (page_id, category))
    else:
        cur.execute("SELECT * FROM software_rules WHERE page_id = ? ORDER BY sort_order ASC, id ASC", (page_id,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def add_software_rule(page_id: int, title: str, content: str, category: str = 'Architecture', severity: str = 'MUST', sort_order: int = 0):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO software_rules (page_id, title, content, category, severity, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (page_id, title.strip(), content.strip(), category.strip(), severity.strip(), sort_order))
    rule_id = cur.lastrowid
    conn.commit()
    conn.close()
    return rule_id

def delete_software_rule(rule_id: int):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM software_rules WHERE id = ?", (rule_id,))
    conn.commit()
    conn.close()
    return True

def get_software_ideas(page_id: int, status: str = None):
    conn = get_conn()
    cur = conn.cursor()
    if status:
        cur.execute("SELECT * FROM software_ideas WHERE page_id = ? AND status = ? ORDER BY sort_order ASC, id DESC", (page_id, status))
    else:
        cur.execute("SELECT * FROM software_ideas WHERE page_id = ? ORDER BY sort_order ASC, id DESC", (page_id,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def add_software_idea(page_id: int, title: str, description: str = '', category: str = 'Feature', status: str = 'draft', author: str = 'User', sort_order: int = 0):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO software_ideas (page_id, title, description, category, status, author, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (page_id, title.strip(), description.strip(), category.strip(), status.strip(), author.strip(), sort_order))
    idea_id = cur.lastrowid
    conn.commit()
    conn.close()
    return idea_id

def update_software_idea(idea_id: int, title: str = None, description: str = None, category: str = None, status: str = None, author: str = None, sort_order: int = None):
    conn = get_conn()
    cur = conn.cursor()
    updates = []
    params = []
    if title is not None:
        updates.append("title = ?")
        params.append(title.strip())
    if description is not None:
        updates.append("description = ?")
        params.append(description.strip())
    if category is not None:
        updates.append("category = ?")
        params.append(category.strip())
    if status is not None:
        updates.append("status = ?")
        params.append(status.strip())
    if author is not None:
        updates.append("author = ?")
        params.append(author.strip())
    if sort_order is not None:
        updates.append("sort_order = ?")
        params.append(sort_order)
    if updates:
        params.append(idea_id)
        cur.execute(f"UPDATE software_ideas SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
    conn.close()
    return True

def delete_software_idea(idea_id: int):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM software_ideas WHERE id = ?", (idea_id,))
    conn.commit()
    conn.close()
    return True

def get_software_tasks(page_id: int, status: str = None):
    conn = get_conn()
    cur = conn.cursor()
    if status:
        cur.execute("SELECT * FROM software_tasks WHERE page_id = ? AND status = ? ORDER BY sort_order ASC, id DESC", (page_id, status))
    else:
        cur.execute("SELECT * FROM software_tasks WHERE page_id = ? ORDER BY sort_order ASC, id DESC", (page_id,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def add_software_task(page_id: int, title: str, description: str = '', status: str = 'todo', priority: str = 'medium', assigned_agent: str = '', commit_hash: str = '', sort_order: int = 0):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO software_tasks (page_id, title, description, status, priority, assigned_agent, commit_hash, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (page_id, title.strip(), description.strip(), status.strip(), priority.strip(), assigned_agent.strip(), commit_hash.strip(), sort_order))
    task_id = cur.lastrowid
    conn.commit()
    conn.close()
    return task_id

def update_software_task(task_id: int, title: str = None, description: str = None, status: str = None, priority: str = None, assigned_agent: str = None, commit_hash: str = None, sort_order: int = None):
    conn = get_conn()
    cur = conn.cursor()
    updates = []
    params = []
    if title is not None:
        updates.append("title = ?")
        params.append(title.strip())
    if description is not None:
        updates.append("description = ?")
        params.append(description.strip())
    if status is not None:
        updates.append("status = ?")
        params.append(status.strip())
    if priority is not None:
        updates.append("priority = ?")
        params.append(priority.strip())
    if assigned_agent is not None:
        updates.append("assigned_agent = ?")
        params.append(assigned_agent.strip())
    if commit_hash is not None:
        updates.append("commit_hash = ?")
        params.append(commit_hash.strip())
    if sort_order is not None:
        updates.append("sort_order = ?")
        params.append(sort_order)
    updates.append("updated_at = datetime('now', 'localtime')")
    if updates:
        params.append(task_id)
        cur.execute(f"UPDATE software_tasks SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
    conn.close()
    return True

def delete_software_task(task_id: int):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM software_tasks WHERE id = ?", (task_id,))
    conn.commit()
    conn.close()
    return True

def get_software_commits(page_id: int, limit: int = 30):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM software_commits WHERE page_id = ? ORDER BY committed_at DESC, id DESC LIMIT ?", (page_id, limit))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def add_software_commit(page_id: int, commit_hash: str, message: str, author: str = '', committed_at: str = '', branch: str = 'main'):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO software_commits (page_id, commit_hash, message, author, committed_at, branch)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (page_id, commit_hash.strip(), message.strip(), author.strip(), committed_at.strip(), branch.strip()))
    commit_id = cur.lastrowid
    conn.commit()
    conn.close()
    return commit_id

def sync_git_commits(page_id: int, repo_path: str = None):
    """Yerel git deposundan (TincSync veya yerel repo) commit geçmişini çeker ve veritabanına işler."""
    import subprocess
    proj = get_software_project(page_id)
    target_path = repo_path or proj.get("repo_path", "").strip()
    if not target_path or not os.path.isdir(target_path):
        return {"ok": False, "error": f"Depo dizini bulunamadı: '{target_path}'"}
    
    branch = proj.get("branch", "main") or "HEAD"
    try:
        cmd = ["git", "-C", target_path, "log", "-n", "30", "--pretty=format:%H|||%an|||%ad|||%s", "--date=iso"]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        if result.returncode != 0:
            return {"ok": False, "error": result.stderr.strip() or "Git log alınamadı"}
        
        lines = [line.strip() for line in result.stdout.strip().split("\n") if line.strip()]
        synced_count = 0
        conn = get_conn()
        cur = conn.cursor()
        
        for line in lines:
            parts = line.split("|||")
            if len(parts) >= 4:
                chash, author, cdate, msg = parts[0], parts[1], parts[2], parts[3]
                cur.execute("SELECT id FROM software_commits WHERE page_id = ? AND commit_hash = ?", (page_id, chash))
                if not cur.fetchone():
                    cur.execute("""
                        INSERT INTO software_commits (page_id, commit_hash, message, author, committed_at, branch)
                        VALUES (?, ?, ?, ?, ?, ?)
                    """, (page_id, chash, msg, author, cdate, branch))
                    synced_count += 1
        conn.commit()
        conn.close()
        return {"ok": True, "synced_count": synced_count, "commits": get_software_commits(page_id, 30)}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def generate_agents_markdown(page_id: int):
    """CLI Ajanları (Antigravity CLI, Cursor, Claude vb.) için AGENTS.md formatında proje talimatı oluşturur."""
    proj = get_software_project(page_id)
    page = get_page(page_id) or {}
    rules = get_software_rules(page_id)
    ideas = get_software_ideas(page_id)
    tasks = get_software_tasks(page_id)
    commits = get_software_commits(page_id, limit=10)
    
    md = []
    title = page.get("title", proj.get("repo_name", "Software Project"))
    md.append(f"# Project Guidelines & Context: {title}")
    md.append(f"> Auto-generated from TincNote Software Project on {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
    
    md.append("## 📌 Project Overview")
    md.append(f"- **Repository:** `{proj.get('repo_name') or 'N/A'}` (Branch: `{proj.get('branch', 'main')}`)")
    md.append(f"- **Local Path:** `{proj.get('repo_path') or 'N/A'}`")
    md.append(f"- **Tech Stack:** {proj.get('tech_stack') or 'Not specified'}")
    md.append("")
    
    if proj.get("system_architecture"):
        md.append("## 🏗️ System Architecture & Invariants")
        md.append(proj.get("system_architecture"))
        md.append("")
        
    md.append("## 📜 Rules & Laws (Kanunlar)")
    if rules:
        must_rules = [r for r in rules if r.get("severity") == "MUST"]
        should_rules = [r for r in rules if r.get("severity") == "SHOULD"]
        never_rules = [r for r in rules if r.get("severity") == "NEVER"]
        other_rules = [r for r in rules if r.get("severity") not in ("MUST", "SHOULD", "NEVER")]
        
        if must_rules:
            md.append("### 🔴 MUST (Kesinlikle Uyulması Gerekenler):")
            for r in must_rules:
                md.append(f"- **[{r['category']}] {r['title']}**: {r['content']}")
            md.append("")
        if should_rules:
            md.append("### 🟡 SHOULD (Tavsiye Edilen / Önemli Standartlar):")
            for r in should_rules:
                md.append(f"- **[{r['category']}] {r['title']}**: {r['content']}")
            md.append("")
        if never_rules:
            md.append("### ⛔ NEVER (Asla Yapılmaması Gerekenler):")
            for r in never_rules:
                md.append(f"- **[{r['category']}] {r['title']}**: {r['content']}")
            md.append("")
        if other_rules:
            md.append("### ℹ️ Diğer Standartlar:")
            for r in other_rules:
                md.append(f"- **[{r['category']}] {r['title']}**: {r['content']}")
            md.append("")
    else:
        md.append("*No architectural rules defined yet.*\n")
        
    md.append("## ☑️ Tasks & Sprints (İşler)")
    if tasks:
        for t in tasks:
            status_icon = "✅" if t.get("status") == "done" else ("⏳" if t.get("status") == "in_progress" else "📋")
            agent_str = f" [@{t['assigned_agent']}]" if t.get("assigned_agent") else ""
            prio_str = f" [{t['priority'].upper()}]" if t.get("priority") else ""
            desc_str = f" - {t['description']}" if t.get("description") else ""
            commit_str = f" (commit: `{t['commit_hash'][:7]}`)" if t.get("commit_hash") else ""
            md.append(f"- {status_icon} **{t['title']}**{prio_str}{agent_str}{desc_str}{commit_str}")
        md.append("")
    else:
        md.append("*No active tasks.*\n")
        
    md.append("## 💡 Ideas & Proposals (Fikirler)")
    if ideas:
        for i in ideas:
            md.append(f"- **[{i.get('status', 'draft').upper()}] {i['title']}** ({i.get('category', 'Feature')}): {i.get('description', '')}")
        md.append("")
    else:
        md.append("*No ideas logged yet.*\n")
        
    md.append("## 🔀 Recent Commits")
    if commits:
        for c in commits:
            short_hash = c.get("commit_hash", "")[:7]
            md.append(f"- `{short_hash}` - {c.get('message', '')} ({c.get('author', '')} on {c.get('committed_at', '')})")
        md.append("")
    else:
        md.append("*No commits recorded.*\n")
        
    return "\n".join(md)

def get_software_project_full(page_id: int):
    """Bir yazılım projesinin tüm bölümlerini tek seferde döndürür."""
    return {
        "project": get_software_project(page_id),
        "rules": get_software_rules(page_id),
        "ideas": get_software_ideas(page_id),
        "tasks": get_software_tasks(page_id),
        "commits": get_software_commits(page_id, 30)
    }

# Modül yüklendiğinde tabloların varlığını otomatik güvenceye al
try:
    init_db()
except Exception:
    pass




