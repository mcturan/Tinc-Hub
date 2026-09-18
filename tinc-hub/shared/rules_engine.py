#!/usr/bin/env python3
"""
Tinc Hub — Tinc Autopilot Kural Motoru
======================================
IF-THIS-THEN-THAT mantığıyla çalışan sunucu otomasyon motoru.

Desteklenen Koşullar (when):
  metric_threshold : disk_percent, ram_percent, cpu_percent, wan_ping_ms
  service_down     : belirtilen systemd servisi çevrimdışı
  time_match       : belirli saat (örn. "03:00")
  time_range       : saat aralığı (örn. "02:00-04:00")

Desteklenen Eylemler (do):
  restart_service  : systemd servisini yeniden başlat
  stop_service     : servisi durdur
  start_service    : servisi başlat
  run_command      : kabuk komutu çalıştır
  telegram         : Telegram mesajı gönder
  log_event        : DB'ye olay yaz

Kural Yapısı (rules.yaml içinde):
  - id: unique-id
    name: "İnsan okunabilir isim"
    enabled: true
    cooldown: 300        # saniye, aynı kural tekrar tetiklenemez
    condition:
      type: metric_threshold
      metric: disk_percent
      operator: ">"
      value: 85
    action:
      type: restart_service
      service: nginx
    # veya birden fazla eylem:
    actions:
      - type: telegram
        message: "Disk doldu!"
      - type: run_command
        command: "journalctl --vacuum-time=3d"
"""

import os
import sys
import time
import yaml
import logging
import threading
import subprocess
from datetime import datetime

# ── Shared modüller ─────────────────────────────────────────────────────────
_SHARED = os.path.dirname(os.path.abspath(__file__))
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)

try:
    from db import log_event as _db_log_event
    _db_available = True
except ImportError:
    _db_available = False

log = logging.getLogger("tinc-autopilot")

# ── Dosya yolları ────────────────────────────────────────────────────────────
RULES_FILE = os.environ.get("TINC_HUB_RULES", "/etc/tinc-hub/rules.yaml")


# ═══════════════════════════════════════════════════════════════════════════
# YAML I/O
# ═══════════════════════════════════════════════════════════════════════════

def load_rules() -> list[dict]:
    """rules.yaml'dan kural listesini yükler."""
    if not os.path.exists(RULES_FILE):
        return []
    try:
        with open(RULES_FILE, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
            return data.get("rules", []) if data else []
    except Exception as e:
        log.warning(f"rules.yaml okunamadı: {e}")
        return []


def save_rules(rules: list[dict]):
    """Kural listesini rules.yaml'a yazar."""
    os.makedirs(os.path.dirname(RULES_FILE), exist_ok=True)
    with open(RULES_FILE, "w", encoding="utf-8") as f:
        yaml.safe_dump({"rules": rules}, f, allow_unicode=True, default_flow_style=False)


# ═══════════════════════════════════════════════════════════════════════════
# KOŞUL DEĞERLENDİRİCİ
# ═══════════════════════════════════════════════════════════════════════════

class ConditionEvaluator:
    """Kural koşulunu mevcut sistem metriklerine göre değerlendirir."""

    # Desteklenen metrik isimleri ve psutil eşleme
    METRIC_MAP = {
        "disk_percent":  lambda: __import__('psutil').disk_usage('/').percent,
        "ram_percent":   lambda: __import__('psutil').virtual_memory().percent,
        "cpu_percent":   lambda: __import__('psutil').cpu_percent(interval=0.5),
        "swap_percent":  lambda: __import__('psutil').swap_memory().percent,
    }

    def evaluate(self, condition: dict, extra: dict = None) -> bool:
        """
        Koşulu değerlendirir.
        extra: dışarıdan geçirilen ek metrikler (wan_ping_ms, servis durumu vb.)
        """
        extra = extra or {}
        ctype = condition.get("type", "")

        try:
            if ctype == "metric_threshold":
                return self._metric(condition, extra)
            elif ctype == "service_down":
                return self._service_down(condition)
            elif ctype == "service_up":
                return self._service_up(condition)
            elif ctype == "time_match":
                return self._time_match(condition)
            elif ctype == "time_range":
                return self._time_range(condition)
            elif ctype == "and":
                return all(self.evaluate(c, extra) for c in condition.get("conditions", []))
            elif ctype == "or":
                return any(self.evaluate(c, extra) for c in condition.get("conditions", []))
        except Exception as e:
            log.warning(f"Koşul değerlendirme hatası ({ctype}): {e}")
        return False

    def _metric(self, cond: dict, extra: dict) -> bool:
        metric = cond.get("metric", "")
        operator = cond.get("operator", ">")
        ref = float(cond.get("value", 0))

        # Önce extra sözlüğüne bak, sonra canlı psutil'e
        if metric in extra:
            val = float(extra[metric])
        elif metric in self.METRIC_MAP:
            val = float(self.METRIC_MAP[metric]())
        else:
            log.warning(f"Bilinmeyen metrik: {metric}")
            return False

        ops = {">": val > ref, "<": val < ref, ">=": val >= ref,
               "<=": val <= ref, "==": val == ref, "!=": val != ref}
        return ops.get(operator, False)

    def _service_down(self, cond: dict) -> bool:
        service = cond.get("service", "")
        if not service:
            return False
        r = subprocess.run(
            ["systemctl", "is-active", service],
            capture_output=True, text=True, timeout=5
        )
        return r.stdout.strip() != "active"

    def _service_up(self, cond: dict) -> bool:
        return not self._service_down(cond)

    def _time_match(self, cond: dict) -> bool:
        """Belirtilen saate eşleşip eşleşmediğini kontrol eder (HH:MM formatı)."""
        target = cond.get("time", "")
        now_str = datetime.now().strftime("%H:%M")
        return now_str == target

    def _time_range(self, cond: dict) -> bool:
        """Belirtilen saat aralığında mı? Format: '02:00-04:00'"""
        range_str = cond.get("range", "")
        try:
            start_s, end_s = range_str.split("-")
            now = datetime.now()
            start = now.replace(hour=int(start_s.split(":")[0]),
                                minute=int(start_s.split(":")[1]), second=0)
            end   = now.replace(hour=int(end_s.split(":")[0]),
                                minute=int(end_s.split(":")[1]), second=0)
            return start <= now <= end
        except Exception:
            return False


# ═══════════════════════════════════════════════════════════════════════════
# EYLEM UYGULAYICI
# ═══════════════════════════════════════════════════════════════════════════

class ActionExecutor:
    """Kural eylemleri çalıştırır."""

    def execute(self, action: dict, rule_name: str = "") -> bool:
        atype = action.get("type", "")
        try:
            if atype == "restart_service":
                return self._systemctl("restart", action.get("service", ""))
            elif atype == "stop_service":
                return self._systemctl("stop", action.get("service", ""))
            elif atype == "start_service":
                return self._systemctl("start", action.get("service", ""))
            elif atype == "run_command":
                return self._run_cmd(action.get("command", ""))
            elif atype == "telegram":
                return self._telegram(action.get("message", ""), rule_name)
            elif atype == "log_event":
                return self._log_db(action.get("message", ""),
                                    action.get("level", "INFO"), rule_name)
            else:
                log.warning(f"Bilinmeyen eylem tipi: {atype}")
                return False
        except Exception as e:
            log.error(f"Eylem yürütme hatası ({atype}): {e}")
            return False

    def _systemctl(self, cmd: str, service: str) -> bool:
        if not service:
            log.warning("systemctl eylemi: servis adı boş")
            return False
        r = subprocess.run(
            ["systemctl", cmd, service],
            capture_output=True, text=True, timeout=30
        )
        ok = r.returncode == 0
        level = "INFO" if ok else "ERROR"
        log.log(logging.INFO if ok else logging.ERROR,
                f"systemctl {cmd} {service} → {'OK' if ok else 'FAIL'}: {r.stderr.strip()}")
        self._log_db(f"Kural eylemi: systemctl {cmd} {service} → {'OK' if ok else r.stderr.strip()}",
                     level)
        return ok

    def _run_cmd(self, command: str) -> bool:
        if not command:
            return False
        log.info(f"Komut çalıştırılıyor: {command}")
        r = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=60)
        ok = r.returncode == 0
        self._log_db(f"Kural komutu: {command} → {'OK' if ok else r.stderr[:200]}")
        return ok

    def _telegram(self, message: str, rule_name: str = "") -> bool:
        """config.env'deki Telegram token ile mesaj gönderir."""
        try:
            from dotenv import dotenv_values
            cfg = dotenv_values("/etc/tinc-hub/config.env")
            token   = cfg.get("TELEGRAM_BOT_TOKEN", "")
            chat_id = cfg.get("TELEGRAM_CHAT_ID", "")
            if not token or not chat_id:
                log.warning("Telegram: token veya chat_id tanımlı değil")
                return False
            import urllib.request, json as _json
            full_msg = f"🤖 *Tinc Autopilot*\n*Kural:* {rule_name}\n{message}"
            payload = _json.dumps({
                "chat_id": chat_id,
                "text": full_msg,
                "parse_mode": "Markdown"
            }).encode()
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{token}/sendMessage",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                ok = resp.status == 200
                log.info(f"Telegram {'gönderildi' if ok else 'gönderilemedi'}")
                return ok
        except Exception as e:
            log.warning(f"Telegram hatası: {e}")
            return False

    def _log_db(self, message: str, level: str = "INFO",
                rule_name: str = "autopilot") -> bool:
        if _db_available:
            try:
                _db_log_event("autopilot", level, message,
                              source=f"rule:{rule_name}")
                return True
            except Exception:
                pass
        log.info(f"[DB-LOG] {level}: {message}")
        return False


# ═══════════════════════════════════════════════════════════════════════════
# ANA MOTOR
# ═══════════════════════════════════════════════════════════════════════════

class RulesEngine:
    """
    Tinc Autopilot kural motoru.
    evaluate_all() metodu periyodik olarak çağrılır.
    """

    def __init__(self):
        self.last_triggered: dict[str, float] = {}  # rule_id → timestamp
        self.evaluator = ConditionEvaluator()
        self.executor  = ActionExecutor()

    def evaluate_all(self, extra_metrics: dict = None, services: dict = None):
        """
        Tüm etkin kuralları değerlendirip eşleşenlerin eylemlerini yürütür.
        extra_metrics: {"wan_ping_ms": 45.2, ...} gibi dışarıdan gelen metrikler
        services     : {"nginx": True, "plex": False, ...} gibi servis durumları (legacy)
        """
        rules = load_rules()
        now = time.time()
        extra = extra_metrics or {}

        for rule in rules:
            if not rule.get("enabled", True):
                continue

            rule_id = rule.get("id", rule.get("name", ""))
            cooldown = float(rule.get("cooldown", 300))   # varsayılan 5 dakika

            # Soğuma süresi dolmadıysa atla
            last = self.last_triggered.get(rule_id, 0)
            if now - last < cooldown:
                continue

            condition = rule.get("condition", {})
            if not self.evaluator.evaluate(condition, extra):
                continue

            # Koşul sağlandı → eylemleri çalıştır
            log.info(f"Kural tetiklendi: '{rule.get('name', rule_id)}'")

            # Tekil action veya çoklu actions listesi
            actions = rule.get("actions") or ([rule["action"]] if rule.get("action") else [])
            for act in actions:
                self.executor.execute(act, rule_name=rule.get("name", rule_id))

            self.last_triggered[rule_id] = now


# ── Tek örnek (singleton) ────────────────────────────────────────────────────
engine = RulesEngine()


# ═══════════════════════════════════════════════════════════════════════════
# ARKA PLAN DÖNGÜSÜ
# ═══════════════════════════════════════════════════════════════════════════

_engine_thread: threading.Thread | None = None
_engine_stop   = threading.Event()


def start_autopilot(interval: int = 60, extra_metrics_fn=None):
    """
    Tinc Autopilot'u arka planda başlatır.
    interval        : değerlendirme aralığı (saniye)
    extra_metrics_fn: çağrıldığında {"wan_ping_ms": ..., ...} dönen fonksiyon
    """
    global _engine_thread
    if _engine_thread and _engine_thread.is_alive():
        log.info("Autopilot zaten çalışıyor.")
        return

    _engine_stop.clear()

    def _loop():
        log.info(f"Tinc Autopilot başlatıldı (interval={interval}s)")
        while not _engine_stop.is_set():
            try:
                extra = extra_metrics_fn() if callable(extra_metrics_fn) else {}
                engine.evaluate_all(extra_metrics=extra)
            except Exception as e:
                log.error(f"Autopilot döngü hatası: {e}")
            _engine_stop.wait(interval)
        log.info("Tinc Autopilot durduruldu.")

    _engine_thread = threading.Thread(target=_loop, name="tinc-autopilot", daemon=True)
    _engine_thread.start()


def stop_autopilot():
    """Arka plan döngüsünü durdurur."""
    _engine_stop.set()


# ═══════════════════════════════════════════════════════════════════════════
# ÖRNEK KURALLAR (rules.yaml için referans)
# ═══════════════════════════════════════════════════════════════════════════

EXAMPLE_RULES = {
    "rules": [
        {
            "id": "disk-auto-clean",
            "name": "Disk %85'i geçince temizle",
            "enabled": True,
            "cooldown": 3600,
            "condition": {
                "type": "metric_threshold",
                "metric": "disk_percent",
                "operator": ">",
                "value": 85
            },
            "actions": [
                {"type": "run_command",
                 "command": "journalctl --vacuum-time=7d"},
                {"type": "telegram",
                 "message": "⚠️ Disk %85 doluluk — otomatik temizlik yapıldı."}
            ]
        },
        {
            "id": "nginx-watchdog",
            "name": "nginx çöktüğünde yeniden başlat",
            "enabled": True,
            "cooldown": 300,
            "condition": {
                "type": "service_down",
                "service": "nginx"
            },
            "actions": [
                {"type": "restart_service", "service": "nginx"},
                {"type": "telegram",
                 "message": "🔄 nginx çöktü, otomatik yeniden başlatıldı."}
            ]
        },
        {
            "id": "ram-warn",
            "name": "RAM %90'ı geçince uyar",
            "enabled": True,
            "cooldown": 1800,
            "condition": {
                "type": "metric_threshold",
                "metric": "ram_percent",
                "operator": ">",
                "value": 90
            },
            "action": {
                "type": "telegram",
                "message": "🔴 RAM kullanımı kritik seviyede!"
            }
        }
    ]
}
