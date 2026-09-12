import time
import logging
import threading
import os
import sys
from datetime import datetime, timedelta

from . import db
from .telegram_bot import send_notification_to_all_chats

log = logging.getLogger("tnote-reminder")

_reminder_thread = None
_stop_event = threading.Event()
_is_running = False

def _notify_tinc_hub_event(level: str, category: str, message: str, data: dict = None):
    """Eğer Tinc-Hub shared db mevcutsa bildirim ziline olay ekler."""
    try:
        shared_dir = os.environ.get("TINC_HUB_SHARED", "/opt/tinc-hub/shared")
        if shared_dir not in sys.path:
            sys.path.insert(0, shared_dir)
        import db as tinchub_db
        tinchub_db.log_event(
            agent_id="tnote",
            level=level,
            category=category,
            message=message,
            data=data or {}
        )
    except Exception:
        pass

def _process_due_reminders():
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    due_list = db.get_due_reminders(now_str)

    for rem in due_list:
        rem_id = rem["id"]
        target_type = rem["target_type"]
        target_id = rem["target_id"]
        title = rem.get("target_title") or "İsimsiz Madde"
        page_title = rem.get("page_title") or "Liste"
        recurrence = rem.get("recurrence") or "none"
        price = rem.get("item_price") or ""
        url = rem.get("item_url") or ""

        log.info(f"Hatırlatıcı tetiklendi: {title} (ID: {rem_id})")

        # 1. Telegram Bildirimi
        text = (
            f"⏰ *Zamanı Geldi: Hatırlatma!*\n\n"
            f"📌 *{title}*\n"
            f"📂 Liste: *{page_title}*\n"
        )
        if price:
            text += f"💰 Fiyat: {price}\n"
        if url:
            text += f"🔗 [Ürün Linki]({url})\n"

        buttons = [
            [
                {"text": "✓ Tamamlandı", "callback_data": f"tn:rem_done:{target_type}:{target_id}"},
                {"text": "⏰ 1 Saat Ertele", "callback_data": f"tn:rem_snooze:{target_type}:{target_id}:60"}
            ],
            [
                {"text": "📅 Yarına Ertele", "callback_data": f"tn:rem_snooze:{target_type}:{target_id}:1440"}
            ]
        ]
        keyboard = {"inline_keyboard": buttons}
        send_notification_to_all_chats(text, reply_markup=keyboard)

        # 2. Tinc-Hub UI Bildirim Zili
        if db.get_setting("ui_notify_enabled", "1") == "1":
            _notify_tinc_hub_event(
                level="WARN",
                category="task",
                message=f"TNOTE Hatırlatma: {title} ({page_title})",
                data={"target_type": target_type, "target_id": target_id, "url": url}
            )

        # 3. Tekrarlanma veya Tamamlanma Hesaplama
        next_time = None
        now_dt = datetime.now()
        if recurrence == "daily":
            next_time = (now_dt + timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
        elif recurrence == "weekly":
            next_time = (now_dt + timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
        elif recurrence == "monthly":
            next_time = (now_dt + timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")

        db.mark_reminder_sent(rem_id, next_remind_at=next_time)

_last_bill_check_day = None
_last_price_check_time = 0

def _process_due_bills():
    global _last_bill_check_day
    today_str = datetime.now().strftime("%Y-%m-%d")
    if _last_bill_check_day == today_str:
        return
    period = datetime.now().strftime("%Y-%m")
    unpaid = db.get_due_unpaid_bills(period, days_ahead=2)
    if unpaid:
        msg = f"⚠️ *Vadesi Yaklaşan / Gelen Faturalar:* ({len(unpaid)} adet)\n\n"
        buttons = []
        for b in unpaid[:6]:
            msg += f"• *{b['title']}* — {b['amount']:,.2f} TL (Ayın {b['due_day']}. günü)\n"
            buttons.append([{"text": f"✓ {b['title']} Ödendi", "callback_data": f"tn:fin_paid:{b['id']}:{b['page_id']}"}])
        keyboard = {"inline_keyboard": buttons}
        send_notification_to_all_chats(msg, reply_markup=keyboard)
        _notify_tinc_hub_event(level="WARN", category="task", message=f"TNOTE: {len(unpaid)} adet ödenmemiş faturanın vadesi geldi/yaklaştı.")
    _last_bill_check_day = today_str

def _process_price_drop_checks():
    global _last_price_check_time
    now = time.time()
    if now - _last_price_check_time < 21600:
        return
    _last_price_check_time = now
    items = db.get_all_tracked_product_items()
    if not items:
        return
    from .scraper import scrape_url_metadata
    for item in items[:15]:
        try:
            url = item.get("url")
            old_price_str = item.get("price") or ""
            if not url or not old_price_str:
                continue
            meta = scrape_url_metadata(url)
            new_price_str = meta.get("price") or ""
            if not new_price_str:
                continue
            import re
            def parse_p(s):
                clean = re.sub(r"[^\d,\.]", "", s).replace(".", "").replace(",", ".")
                try: return float(clean)
                except: return 0.0
            old_num = parse_p(old_price_str)
            new_num = parse_p(new_price_str)
            if 0 < new_num < old_num:
                db.update_item_price(item["id"], new_price_str)
                alert_text = (
                    f"🚨 *FİYAT DÜŞÜŞÜ YAKALANDI!*\n\n"
                    f"📌 *{item['title']}*\n"
                    f"📂 Liste: *{item['page_title']}*\n"
                    f"📉 Eski: ~{old_price_str}~ ➔ Yeni: *{new_price_str}*\n"
                    f"🔗 [Ürünü Görüntüle]({url})"
                )
                send_notification_to_all_chats(alert_text)
                _notify_tinc_hub_event(level="INFO", category="task", message=f"Fiyat Düştü: {item['title']} ({old_price_str} -> {new_price_str})")
        except Exception as err:
            log.debug(f"Fiyat kontrol hatası: {err}")

def _reminder_loop():
    global _is_running
    log.info("TNOTE Hatırlatıcı Motoru başlatıldı.")
    while not _stop_event.is_set():
        try:
            _process_due_reminders()
            _process_due_bills()
            _process_price_drop_checks()
        except Exception as e:
            log.error(f"Hatırlatıcı döngü hatası: {e}")
        time.sleep(10) # 10 saniyede bir kontrol et
    _is_running = False

def start_reminder_engine():
    global _reminder_thread, _stop_event, _is_running
    if _is_running and _reminder_thread and _reminder_thread.is_alive():
        return
    _stop_event.clear()
    _is_running = True
    _reminder_thread = threading.Thread(target=_reminder_loop, daemon=True, name="tnote-reminder-engine")
    _reminder_thread.start()

def stop_reminder_engine():
    global _stop_event, _is_running
    _stop_event.set()
    _is_running = False
