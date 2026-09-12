import time
import json
import logging
import threading
import os
import tempfile
import subprocess
from datetime import datetime, timedelta
import requests

from . import db
from .scraper import extract_first_url, scrape_url_metadata

log = logging.getLogger("tnote-telegram")

_bot_thread = None
_stop_event = threading.Event()
_is_running = False

# Geçici ürün önbelleği: callback_key -> product_data
_pending_products = {}

def transcribe_voice_message(token: str, file_id: str) -> str:
    """Telegram ses mesajını (.oga) indirip ffmpeg ve Google STT ile Türkçe metne çevirir."""
    try:
        res = requests.get(f"https://api.telegram.org/bot{token}/getFile?file_id={file_id}", timeout=10)
        if not res.ok:
            return ""
        file_path = res.json().get("result", {}).get("file_path")
        if not file_path:
            return ""
        file_url = f"https://api.telegram.org/file/bot{token}/{file_path}"
        with tempfile.NamedTemporaryFile(suffix=".oga", delete=False) as tf_oga:
            oga_path = tf_oga.name
            r = requests.get(file_url, stream=True, timeout=15)
            for chunk in r.iter_content(chunk_size=8192):
                tf_oga.write(chunk)

        wav_path = oga_path.replace(".oga", ".wav")
        try:
            subprocess.run(["ffmpeg", "-y", "-i", oga_path, "-ar", "16000", "-ac", "1", wav_path],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            import speech_recognition as sr
            recognizer = sr.Recognizer()
            with sr.AudioFile(wav_path) as source:
                audio_data = recognizer.record(source)
            text = recognizer.recognize_google(audio_data, language="tr-TR")
            return text
        except Exception as e:
            log.error(f"Ses tanıma / ffmpeg hatası: {e}")
            return ""
        finally:
            if os.path.exists(oga_path):
                try: os.remove(oga_path)
                except Exception: pass
            if os.path.exists(wav_path):
                try: os.remove(wav_path)
                except Exception: pass
    except Exception as e:
        log.error(f"Telegram ses dosyası indirme hatası: {e}")
        return ""

def is_bot_running() -> bool:
    global _is_running, _bot_thread
    return _is_running and _bot_thread is not None and _bot_thread.is_alive()

def is_chat_allowed(chat_id: str, username: str = "") -> bool:
    """Chat ID veya Nickname'in izinli olup olmadığını kontrol eder."""
    chat_id = str(chat_id).strip()
    clean_username = (username or "").strip().lstrip("@").lower()

    # 1. telegram_users tablosunu kontrol et
    try:
        users = db.get_telegram_users()
        for u in users:
            if u.get("is_allowed") == 1:
                if str(u.get("chat_id")) == chat_id:
                    return True
                u_nick = (u.get("username") or "").strip().lstrip("@").lower()
                if clean_username and u_nick == clean_username:
                    db.upsert_telegram_user(chat_id, username=clean_username, is_allowed=1)
                    return True
    except Exception:
        pass

    # 2. telegram_chat_ids ayarını kontrol et (hem sayısal ID hem @nickname)
    allowed_str = db.get_setting("telegram_chat_ids", "").strip()
    if allowed_str:
        entries = [c.strip().lstrip("@").lower() for c in allowed_str.replace(";", ",").split(",") if c.strip()]
        if chat_id in entries:
            db.upsert_telegram_user(chat_id, username=clean_username, is_allowed=1)
            return True
        if clean_username and clean_username in entries:
            db.upsert_telegram_user(chat_id, username=clean_username, is_allowed=1)
            return True

    return False

def send_telegram_message(token: str, chat_id: str, text: str, reply_markup: dict = None) -> dict:
    """Telegram API üzerinden mesaj gönderir."""
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown"
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        resp = requests.post(url, json=payload, timeout=10)
        return resp.json() if resp.ok else {}
    except Exception as e:
        log.error(f"Telegram mesaj gönderme hatası: {e}")
        return {}

def edit_telegram_message(token: str, chat_id: str, message_id: int, text: str, reply_markup: dict = None) -> bool:
    """Telegram API üzerinden gönderilmiş mesajı günceller."""
    try:
        url = f"https://api.telegram.org/bot{token}/editMessageText"
        payload = {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "parse_mode": "Markdown"
        }
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        resp = requests.post(url, json=payload, timeout=10)
        return resp.ok
    except Exception as e:
        log.error(f"Telegram mesaj düzenleme hatası: {e}")
        return False

def answer_callback_query(token: str, callback_query_id: str, text: str = ""):
    try:
        url = f"https://api.telegram.org/bot{token}/answerCallbackQuery"
        requests.post(url, json={"callback_query_id": callback_query_id, "text": text}, timeout=5)
    except Exception:
        pass

def handle_incoming_message(token: str, msg: dict):
    chat = msg.get("chat", {})
    chat_id = str(chat.get("id"))
    from_user = msg.get("from", {})
    username = from_user.get("username", "")
    first_name = from_user.get("first_name", "Kullanıcı")
    text = msg.get("text", "").strip()

    if not chat_id:
        return

    # Kullanıcıyı veri tabanına kaydet / son görülmesini güncelle
    db.upsert_telegram_user(chat_id, username=username, first_name=first_name)

    # İzin kontrolü (Chat ID veya Nickname)
    if not is_chat_allowed(chat_id, username):
        user_mention = f"@{username}" if username else "tanımlanmamış"
        warn_msg = (
            f"👋 Merhaba {first_name}!\n\n"
            f"🔒 *Yetki Bekleniyor.*\n"
            f"• **Chat ID:** `{chat_id}`\n"
            f"• **Kullanıcı Adı:** `{user_mention}`\n\n"
            f"Tinc-Hub panelinizde **Telegram & Ayarlar** sayfasına bu isteğiniz eklendi. Panelden tek tıkla `[İzin Ver]` butonuna basabilirsiniz."
        )
        send_telegram_message(token, chat_id, warn_msg)
        return

    # Sesli Mesaj Kontrolü (Voice / Audio Note)
    voice_obj = msg.get("voice") or msg.get("audio")
    if voice_obj:
        file_id = voice_obj.get("file_id")
        send_telegram_message(token, chat_id, "🎙️ *Ses kaydı dinleniyor ve metne çevriliyor...*")
        transcribed = transcribe_voice_message(token, file_id)
        if transcribed:
            text = transcribed.strip()
            send_telegram_message(token, chat_id, f"🗣️ *Algılanan:* \"{text}\"")
        else:
            send_telegram_message(token, chat_id, "⚠️ Ses kaydı anlaşılamadı veya metne dönüştürülemedi.")
            return

    # Komutlar
    if text.startswith("/start") or text.startswith("/help") or text.startswith("/yardim"):
        welcome = (
            "📝 *Tinc-Hub TNOTE Botuna Hoş Geldiniz!*\n\n"
            "Bu bot ile notlarınızı, alışveriş listelerinizi ve düzenli ödemelerinizi yönetebilirsiniz.\n\n"
            "• **Ürün Linki Gönderin:** Otomatik başlık, resim ve fiyatı çekip listeye ekler.\n"
            "• **Sesli Mesaj Gönderin:** 🎙️ Ses kaydınız otomatik çözülüp listeye yazılır.\n"
            "• **Düz Metin Gönderin:** Doğrudan varsayılan listenize eklenir.\n"
            "• `/liste` : Mevcut listelerinizi butonlu olarak açar.\n"
            "• `/fatura` : Aylık düzenli ödemelerinizi ve faturalarınızı gösterir, tek tıkla ödersiniz.\n"
            "• `/ekle [madde]` : Hızlıca varsayılan listeye ekleyin.\n"
            "• `/durum` : Sistem durumunu kontrol edin."
        )
        send_telegram_message(token, chat_id, welcome)
        return

    if text.startswith("/fatura") or text.startswith("/butce") or text.startswith("/odeme"):
        period = datetime.now().strftime("%Y-%m")
        due_bills = db.get_due_unpaid_bills(period, days_ahead=31)
        if not due_bills:
            send_telegram_message(token, chat_id, f"🎉 *{period} Dönemi İçin Bekleyen Fatura veya Düzenli Ödeme Bulunmuyor!*")
            return

        total_due = sum(b.get("amount", 0.0) for b in due_bills)
        msg_text = f"💳 *{period} Bekleyen Faturalar & Düzenli Ödemeler*\n💰 *Toplam:* {total_due:,.2f} TL\n\n"
        buttons = []
        for b in due_bills[:10]:
            msg_text += f"• *{b['title']}* — {b['amount']:,.2f} TL (Ayın {b['due_day']}. günü)\n"
            buttons.append([{"text": f"✓ {b['title']} ({b['amount']} TL) Ödendi", "callback_data": f"tn:fin_paid:{b['id']}:{b['page_id']}"}])

        keyboard = {"inline_keyboard": buttons}
        send_telegram_message(token, chat_id, msg_text, reply_markup=keyboard)
        return

    if text.startswith("/durum"):
        cats = db.get_categories()
        pages = db.get_pages()
        status_msg = (
            "🟢 *TNOTE Sistemi Aktif*\n\n"
            f"📁 Toplam Kategori: {len(cats)}\n"
            f"📄 Toplam Liste/Sayfa: {len(pages)}\n"
            f"⏰ Sunucu Saati: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        )
        send_telegram_message(token, chat_id, status_msg)
        return

    if text.startswith("/proje") or text.startswith("/projeler"):
        projects = db.get_all_active_projects()
        if not projects:
            send_telegram_message(token, chat_id, "🔬 *Henüz kayıtlı bir proje bulunmuyor.* Web arayüzünden yeni bir 'Proje & İnşa' sayfası oluşturabilirsiniz.")
            return

        msg_text = "🔬 *Aktif Projeler & Atölye:*\n\n"
        buttons = []
        for p in projects[:6]:
            tot_m = p.get('total_milestones', 0)
            cmp_m = p.get('completed_milestones', 0)
            pct = int((cmp_m / tot_m * 100)) if tot_m > 0 else 0
            needed = p.get('needed_mat_count', 0)
            status_tr = {
                'planning': '💡 Planlama',
                'in_progress': '🛠️ Yapım Aşamasında',
                'testing': '🧪 Test & Kalibrasyon',
                'completed': '✅ Tamamlandı'
            }.get(p.get('project_status'), '💡 Planlama')

            msg_text += f"• *{p.get('icon', '🔬')} {p['title']}* ({status_tr})\n"
            msg_text += f"  ↳ İlerleme: *%{pct}* ({cmp_m}/{tot_m} Aşama) | Eksik Malzeme: *{needed} adet*\n\n"
            buttons.append([{"text": f"📋 {p['title']} Eksik Malzemeler", "callback_data": f"tn:proj_mat:{p['id']}"}])

        keyboard = {"inline_keyboard": buttons}
        send_telegram_message(token, chat_id, msg_text, reply_markup=keyboard)
        return

    if text.startswith("/liste"):
        pages = db.get_pages()
        if not pages:
            send_telegram_message(token, chat_id, "Henüz oluşturulmuş bir liste yok.")
            return

        buttons = []
        for p in pages[:8]:
            btn_text = f"{p.get('icon', '📝')} {p['title']} ({p.get('total_items', 0) - p.get('completed_items', 0)})"
            buttons.append([{"text": btn_text, "callback_data": f"tn:show:{p['id']}"}])

        keyboard = {"inline_keyboard": buttons}
        send_telegram_message(token, chat_id, "📋 *Görüntülemek istediğiniz listeyi seçin:*", reply_markup=keyboard)
        return

    if text.startswith("/ekle "):
        item_text = text[6:].strip()
        if not item_text:
            send_telegram_message(token, chat_id, "Lütfen eklenecek maddeyi yazın. Örnek: `/ekle Ekmek`")
            return
        default_page_id = db.get_setting("telegram_default_page_id")
        page = db.get_page(int(default_page_id)) if default_page_id and default_page_id.isdigit() else None
        if not page:
            pages = db.get_pages()
            page = pages[0] if pages else None

        if not page:
            send_telegram_message(token, chat_id, "⚠️ Hiç liste bulunamadı.")
            return

        db.add_item(page['id'], item_text)
        send_telegram_message(token, chat_id, f"✅ *{item_text}*, *{page['title']}* listesine eklendi!")
        return

    # Link Kontrolü (Ürün veya Web Sayfası)
    url = extract_first_url(text)
    if url:
        info_msg = send_telegram_message(token, chat_id, "🔍 *Link inceleniyor, ürün bilgileri çekiliyor...*")
        meta = scrape_url_metadata(url)

        pending_key = f"{chat_id}_{int(time.time()*1000)}"
        _pending_products[pending_key] = {
            "title": meta["title"] or url,
            "description": meta["description"],
            "url": meta["url"],
            "image_url": meta["image_url"],
            "price": meta["price"],
            "created_at": time.time()
        }

        # Sayfaları buton olarak listele
        pages = db.get_pages()
        buttons = []
        row = []
        for idx, p in enumerate(pages[:6]):
            btn = {"text": f"{p.get('icon', '📝')} {p['title']}", "callback_data": f"tn:add:{p['id']}:{pending_key}"}
            row.append(btn)
            if len(row) == 2:
                buttons.append(row)
                row = []
        if row:
            buttons.append(row)

        keyboard = {"inline_keyboard": buttons}

        summary = (
            f"🛒 *Ürün Algılandı:*\n"
            f"📌 *{meta['title']}*\n"
        )
        if meta["price"]:
            summary += f"💰 *Fiyat:* {meta['price']}\n"
        if meta["site_name"]:
            summary += f"🌐 *Kaynak:* {meta['site_name']}\n"
        summary += "\n*Hangi listeye eklensin?*"

        # Eski mesajı güncelle
        if info_msg.get("result", {}).get("message_id"):
            edit_telegram_message(token, chat_id, info_msg["result"]["message_id"], summary, reply_markup=keyboard)
        else:
            send_telegram_message(token, chat_id, summary, reply_markup=keyboard)
        return

    # Düz Metin (Madde veya Not)
    # Varsayılan listeye ekleme ve alternatif sayfa seçimi sunma
    default_page_id = db.get_setting("telegram_default_page_id")
    page = db.get_page(int(default_page_id)) if default_page_id and default_page_id.isdigit() else None
    if not page:
        pages = db.get_pages()
        page = pages[0] if pages else None

    if page:
        item_id = db.add_item(page['id'], text)
        msg_text = f"✅ *\"{text}\"*\n*{page.get('icon', '📝')} {page['title']}* listesine eklendi."

        # Başka listeye taşıma butonları
        pages = [p for p in db.get_pages() if p['id'] != page['id']]
        buttons = []
        row = []
        for p in pages[:4]:
            row.append({"text": f"➡️ {p.get('icon','')} {p['title']}", "callback_data": f"tn:move:{item_id}:{p['id']}"})
            if len(row) == 2:
                buttons.append(row)
                row = []
        if row:
            buttons.append(row)

        keyboard = {"inline_keyboard": buttons} if buttons else None
        send_telegram_message(token, chat_id, msg_text, reply_markup=keyboard)
    else:
        send_telegram_message(token, chat_id, f"⚠️ Eklenecek liste bulunamadı. Lütfen web panelinden bir liste açın.")

def handle_incoming_callback(token: str, callback: dict):
    callback_id = callback.get("id")
    data = callback.get("data", "")
    from_user = callback.get("from", {})
    chat_id = str(from_user.get("id"))
    msg = callback.get("message", {})
    message_id = msg.get("message_id")

    if not is_chat_allowed(chat_id):
        answer_callback_query(token, callback_id, "Yetkisiz işlem!")
        return

    parts = data.split(":")
    prefix = parts[0]
    action = parts[1] if len(parts) > 1 else ""

    if prefix != "tn":
        return

    if action == "add":
        # tn:add:<page_id>:<pending_key>
        page_id = int(parts[2])
        pending_key = parts[3]
        prod = _pending_products.pop(pending_key, None)

        page = db.get_page(page_id)
        if not page:
            answer_callback_query(token, callback_id, "Hedef liste bulunamadı!")
            return

        if prod:
            db.add_item(
                page_id=page_id,
                title=prod["title"],
                description=prod.get("description", ""),
                url=prod.get("url", ""),
                image_url=prod.get("image_url", ""),
                price=prod.get("price", "")
            )
            done_text = (
                f"✅ *Başarıyla Eklendi!*\n\n"
                f"📌 *{prod['title']}*\n"
                f"📂 Liste: *{page.get('icon','')} {page['title']}*\n"
                f"{'💰 Fiyat: ' + prod['price'] if prod.get('price') else ''}"
            )
            edit_telegram_message(token, chat_id, message_id, done_text, reply_markup=None)
            answer_callback_query(token, callback_id, "Ürün listeye eklendi!")
        else:
            answer_callback_query(token, callback_id, "İstek zaman aşımına uğramış olabilir.")

    elif action == "move":
        # tn:move:<item_id>:<target_page_id>
        item_id = int(parts[2])
        target_page_id = int(parts[3])
        target_page = db.get_page(target_page_id)
        if target_page:
            db.update_item(item_id, page_id=target_page_id)
            edit_telegram_message(token, chat_id, message_id, f"🚚 Madde *{target_page.get('icon','')} {target_page['title']}* listesine taşındı!")
            answer_callback_query(token, callback_id, "Taşındı!")
        else:
            answer_callback_query(token, callback_id, "Hedef liste bulunamadı!")

    elif action == "show":
        # tn:show:<page_id>
        page_id = int(parts[2])
        page = db.get_page(page_id)
        items = db.get_items(page_id)
        if not page:
            answer_callback_query(token, callback_id, "Liste bulunamadı!")
            return

        uncompleted = [i for i in items if not i["is_done"]]
        if not uncompleted:
            text = f"*{page.get('icon','')} {page['title']}*\n\n🎉 Tüm maddeler tamamlanmış! Harika."
            buttons = [[{"text": "« Listeler", "callback_data": "tn:list_all"}]]
            edit_telegram_message(token, chat_id, message_id, text, reply_markup={"inline_keyboard": buttons})
            answer_callback_query(token, callback_id)
            return

        text = f"*{page.get('icon','')} {page['title']}* ({len(uncompleted)} bekleyen madde):\n\n"
        buttons = []
        for i in uncompleted[:10]:
            btn_title = f"✓ {i['title']}"
            if i.get('price'):
                btn_title += f" ({i['price']})"
            buttons.append([{"text": btn_title, "callback_data": f"tn:done:{i['id']}:{page_id}"}])

        buttons.append([{"text": "« Geri", "callback_data": "tn:list_all"}])
        edit_telegram_message(token, chat_id, message_id, text, reply_markup={"inline_keyboard": buttons})
        answer_callback_query(token, callback_id)

    elif action == "done":
        # tn:done:<item_id>:<page_id>
        item_id = int(parts[2])
        page_id = int(parts[3])
        db.update_item(item_id, is_done=1)
        answer_callback_query(token, callback_id, "Madde tamamlandı!")
        # Sayfayı yeniden göster
        handle_incoming_callback(token, {
            "id": callback_id,
            "data": f"tn:show:{page_id}",
            "from": from_user,
            "message": msg
        })

    elif action == "proj_mat":
        page_id = int(parts[2])
        proj = db.get_project_data(page_id)
        page = db.get_page(page_id)
        materials = proj.get("materials", [])
        needed = [m for m in materials if m.get("status") == "needed"]
        title = page.get("title", "Proje") if page else "Proje"
        if not needed:
            text = f"🔬 *{title}*\n\n🎉 Tüm malzemeler temin edilmiş veya sipariş verilmiş! Eksik malzeme yok."
        else:
            text = f"🔬 *{title}* (Eksik Malzeme Listesi):\n\n"
            for m in needed:
                price_str = f" (~{m['unit_price']} TL)" if m.get('unit_price') else ""
                text += f"• *{m['name']}* ({m.get('quantity', '1')} adet){price_str}\n"
                if m.get('url'):
                    text += f"  🔗 {m['url']}\n"
        buttons = [[{"text": "« Projeler", "callback_data": "tn:proj_list"}]]
        edit_telegram_message(token, chat_id, message_id, text, reply_markup={"inline_keyboard": buttons})
        answer_callback_query(token, callback_id)

    elif action == "proj_list":
        projects = db.get_all_active_projects()
        buttons = []
        msg_text = "🔬 *Aktif Projeler & Atölye:*\n\n"
        for p in projects[:6]:
            tot_m = p.get('total_milestones', 0)
            cmp_m = p.get('completed_milestones', 0)
            pct = int((cmp_m / tot_m * 100)) if tot_m > 0 else 0
            needed = p.get('needed_mat_count', 0)
            msg_text += f"• *{p.get('icon', '🔬')} {p['title']}* — %{pct} tamamlandı ({needed} eksik)\n"
            buttons.append([{"text": f"📋 {p['title']} Malzemeler", "callback_data": f"tn:proj_mat:{p['id']}"}])
        edit_telegram_message(token, chat_id, message_id, msg_text, reply_markup={"inline_keyboard": buttons})
        answer_callback_query(token, callback_id)

    elif action == "list_all":
        pages = db.get_pages()
        buttons = []
        for p in pages[:8]:
            btn_text = f"{p.get('icon', '📝')} {p['title']} ({p.get('total_items', 0) - p.get('completed_items', 0)})"
            buttons.append([{"text": btn_text, "callback_data": f"tn:show:{p['id']}"}])
        edit_telegram_message(token, chat_id, message_id, "📋 *Listeleriniz:*", reply_markup={"inline_keyboard": buttons})
        answer_callback_query(token, callback_id)

    elif action == "rem_done":
        # tn:rem_done:<target_type>:<target_id>
        target_type = parts[2]
        target_id = int(parts[3])
        if target_type == "item":
            db.update_item(target_id, is_done=1)
            db.delete_reminder("item", target_id)
        edit_telegram_message(token, chat_id, message_id, "🎉 Tebrikler, tamamlandı olarak işaretlendi!")
        answer_callback_query(token, callback_id, "Tamamlandı!")

    elif action == "rem_snooze":
        # tn:rem_snooze:<target_type>:<target_id>:<minutes>
        target_type = parts[2]
        target_id = int(parts[3])
        minutes = int(parts[4])
        new_time = (datetime.now() + timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
        db.set_reminder(target_type, target_id, new_time)
        edit_telegram_message(token, chat_id, message_id, f"⏰ Hatırlatıcı {minutes} dakika sonraya ertelendi.")
        answer_callback_query(token, callback_id, f"{minutes} dk ertelendi")

    elif action == "fin_paid":
        # tn:fin_paid:<entry_id>:<page_id>
        entry_id = int(parts[2])
        page_id = int(parts[3])
        db.toggle_finance_paid(entry_id, is_paid=True)
        answer_callback_query(token, callback_id, "✓ Fatura ödendi olarak işaretlendi!")
        period = datetime.now().strftime("%Y-%m")
        due_bills = db.get_due_unpaid_bills(period, days_ahead=31)
        if not due_bills:
            edit_telegram_message(token, chat_id, message_id, f"🎉 *{period} Dönemi Tüm Faturaları Ödendi! Harika.*", reply_markup=None)
        else:
            total_due = sum(b.get("amount", 0.0) for b in due_bills)
            msg_text = f"💳 *{period} Kalan Bekleyen Faturalar*\n💰 *Kalan Toplam:* {total_due:,.2f} TL\n\n"
            buttons = []
            for b in due_bills[:10]:
                msg_text += f"• *{b['title']}* — {b['amount']:,.2f} TL (Ayın {b['due_day']}. günü)\n"
                buttons.append([{"text": f"✓ {b['title']} ({b['amount']} TL) Ödendi", "callback_data": f"tn:fin_paid:{b['id']}:{b['page_id']}"}])
            keyboard = {"inline_keyboard": buttons}
            edit_telegram_message(token, chat_id, message_id, msg_text, reply_markup=keyboard)

def send_page_to_telegram(chat_id: str, page_id: int) -> bool:
    """Belirli bir sayfayı Telegram sohbetine interaktif butonlarla iletir."""
    token = db.get_setting("telegram_bot_token", "").strip()
    if not token:
        return False
    page = db.get_page(page_id)
    if not page:
        return False

    if page.get("type") == "finance":
        period = datetime.now().strftime("%Y-%m")
        entries = db.get_finance_entries(page_id, period)
        incomes = [e for e in entries if e['entry_type'] == 'income']
        expenses = [e for e in entries if e['entry_type'] == 'expense']
        tot_inc = sum(e['amount'] for e in incomes)
        tot_exp = sum(e['amount'] for e in expenses)
        unpaid = [e for e in expenses if not e['is_paid']]

        text = (
            f"💳 *{page.get('icon','')} {page['title']}* ({period})\n\n"
            f"📈 *Toplam Gelir:* {tot_inc:,.2f} TL\n"
            f"📉 *Toplam Gider:* {tot_exp:,.2f} TL\n"
            f"💵 *Net Kalan:* {(tot_inc - tot_exp):,.2f} TL\n\n"
            f"📋 *Bekleyen Ödemeler:* ({len(unpaid)} adet)\n"
        )
        buttons = []
        for e in unpaid[:8]:
            text += f"• *{e['title']}* — {e['amount']:,.2f} TL (Ayın {e['due_day']}. günü)\n"
            buttons.append([{"text": f"✓ {e['title']} Ödendi", "callback_data": f"tn:fin_paid:{e['id']}:{page_id}"}])
        keyboard = {"inline_keyboard": buttons} if buttons else None
        send_telegram_message(token, chat_id, text, reply_markup=keyboard)
        return True
    else:
        items = db.get_items(page_id)
        uncompleted = [i for i in items if not i["is_done"]]
        completed = [i for i in items if i["is_done"]]

        text = f"🛒 *{page.get('icon','')} {page['title']}* ({len(uncompleted)} bekleyen)\n\n"
        if uncompleted:
            for i in uncompleted:
                qty_str = f" ({i['quantity']})" if i.get('quantity') else ""
                price_str = f" - {i['price']}" if i.get('price') else ""
                text += f"• ▫️ *{i['title']}*{qty_str}{price_str}\n"
        else:
            text += "🎉 _Tüm maddeler tamamlanmış._\n"

        if completed:
            text += f"\n_Tamamlananlar ({len(completed)}):_\n"
            for i in completed[:5]:
                text += f"• ~{i['title']}~ ✓\n"
            if len(completed) > 5:
                text += f"_... ve {len(completed) - 5} madde daha._\n"

        buttons = []
        for i in uncompleted[:10]:
            btn_title = f"✓ {i['title']}"
            buttons.append([{"text": btn_title, "callback_data": f"tn:done:{i['id']}:{page_id}"}])

        keyboard = {"inline_keyboard": buttons} if buttons else None
        send_telegram_message(token, chat_id, text, reply_markup=keyboard)
        return True

def _telegram_polling_loop():
    global _is_running
    log.info("TNOTE Telegram Polling thread başlatıldı.")
    offset = 0

    while not _stop_event.is_set():
        token = db.get_setting("telegram_bot_token", "").strip()
        enabled = db.get_setting("telegram_enabled", "0") == "1"

        if not token or not enabled:
            time.sleep(3)
            continue

        try:
            url = f"https://api.telegram.org/bot{token}/getUpdates"
            params = {"offset": offset, "timeout": 15}
            resp = requests.get(url, params=params, timeout=20)

            if not resp.ok:
                time.sleep(5)
                continue

            data = resp.json()
            if not data.get("ok"):
                time.sleep(5)
                continue

            for update in data.get("result", []):
                offset = update["update_id"] + 1

                if "message" in update:
                    handle_incoming_message(token, update["message"])
                elif "callback_query" in update:
                    handle_incoming_callback(token, update["callback_query"])

        except requests.exceptions.Timeout:
            continue
        except Exception as e:
            log.error(f"Telegram polling hatası: {e}")
            time.sleep(4)

    _is_running = False
    log.info("TNOTE Telegram Polling thread durduruldu.")

def start_telegram_bot():
    global _bot_thread, _stop_event, _is_running
    if is_bot_running():
        return
    _stop_event.clear()
    _is_running = True
    _bot_thread = threading.Thread(target=_telegram_polling_loop, daemon=True, name="tnote-telegram-bot")
    _bot_thread.start()

def stop_telegram_bot():
    global _stop_event, _is_running
    _stop_event.set()
    _is_running = False

def send_notification_to_all_chats(text: str, reply_markup: dict = None) -> int:
    """İzin verilen tüm Telegram Chat ID'lerine bildirim iletir."""
    token = db.get_setting("telegram_bot_token", "").strip()
    enabled = db.get_setting("telegram_enabled", "0") == "1"
    if not token or not enabled:
        return 0

    allowed_str = db.get_setting("telegram_chat_ids", "").strip()
    if not allowed_str:
        return 0

    allowed_ids = [c.strip() for c in allowed_str.replace(";", ",").split(",") if c.strip()]
    sent_count = 0
    for chat_id in allowed_ids:
        res = send_telegram_message(token, chat_id, text, reply_markup=reply_markup)
        if res.get("ok"):
            sent_count += 1
    return sent_count
