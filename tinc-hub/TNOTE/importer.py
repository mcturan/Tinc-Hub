"""
TincNote — İçe Aktarma & Veri Taşıma Modülü (Data Importer)
Google Keep, Evernote (.enex), Microsoft To-Do / OneNote, JSON, CSV ve Markdown
dosyalarını ayrıştırıp TincNote kategorileri, sayfaları ve maddeleri olarak içe aktarır.
"""

import os
import re
import io
import json
import csv
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime

from . import db

def clean_enml_html(content_str: str) -> str:
    """Evernote ENML içeriğini temizler ve sade metne / markdown'a çevirir."""
    if not content_str:
        return ""
    # XML / CDATA ve en-note başlıklarını temizle
    text = re.sub(r'<\?xml[^>]*\?>', '', content_str)
    text = re.sub(r'<!DOCTYPE[^>]*>', '', text)
    # Checkbox dönüşümü
    text = re.sub(r'<en-todo\s+checked="true"[^>]*/>', '[x] ', text)
    text = re.sub(r'<en-todo[^>]*/>', '[ ] ', text)
    # Satır sonları
    text = re.sub(r'<br\s*/?>', '\n', text)
    text = re.sub(r'</div>', '\n', text)
    text = re.sub(r'</p>', '\n\n', text)
    text = re.sub(r'</li>', '\n', text)
    # Kalan HTML etiketlerini kaldır
    text = re.sub(r'<[^>]+>', '', text)
    # HTML entities
    text = text.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"')
    return text.strip()

def clean_html_to_markdown(html_str: str) -> str:
    """OneNote veya genel HTML içeriklerini temiz ve okunaklı Markdown / metne dönüştürür."""
    if not html_str:
        return ""
    
    text = re.sub(r'<style[^>]*>.*?</style>', '', html_str, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<head[^>]*>.*?</head>', '', text, flags=re.DOTALL | re.IGNORECASE)

    # Checkbox ve To-Do işaretleri
    text = re.sub(r'<input[^>]*type=[\'"]checkbox[\'"][^>]*checked[^>]*>', '[x] ', text, flags=re.IGNORECASE)
    text = re.sub(r'<input[^>]*type=[\'"]checkbox[\'"][^>]*>', '[ ] ', text, flags=re.IGNORECASE)
    text = re.sub(r'<span[^>]*data-tag=[\'"]to-do[\'"][^>]*checked[^>]*>', '[x] ', text, flags=re.IGNORECASE)
    text = re.sub(r'<span[^>]*data-tag=[\'"]to-do[\'"][^>]*>', '[ ] ', text, flags=re.IGNORECASE)
    text = text.replace('☑', '[x] ').replace('☒', '[x] ').replace('☐', '[ ] ').replace('&#9745;', '[x] ').replace('&#9744;', '[ ] ')

    # Başlıklar
    text = re.sub(r'<h1[^>]*>(.*?)</h1>', r'\n# \1\n', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<h2[^>]*>(.*?)</h2>', r'\n## \1\n', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<h3[^>]*>(.*?)</h3>', r'\n### \1\n', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<h4[^>]*>(.*?)</h4>', r'\n#### \1\n', text, flags=re.DOTALL | re.IGNORECASE)

    # Kalın, İtalik
    text = re.sub(r'<(b|strong)[^>]*>(.*?)</\1>', r'**\2**', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<(i|em)[^>]*>(.*?)</\1>', r'*\2*', text, flags=re.DOTALL | re.IGNORECASE)

    # Linkler
    text = re.sub(r'<a\s+[^>]*href=[\'"]([^\'"]+)[\'"][^>]*>(.*?)</a>', r'[\2](\1)', text, flags=re.DOTALL | re.IGNORECASE)

    # Listeler ve Paragraflar
    text = re.sub(r'<li[^>]*>', r'\n- ', text, flags=re.IGNORECASE)
    text = re.sub(r'</li>', '', text, flags=re.IGNORECASE)
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<p[^>]*>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</p>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<div[^>]*>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</div>', '', text, flags=re.IGNORECASE)

    # Kalan HTML etiketleri
    text = re.sub(r'<[^>]+>', '', text)

    # HTML Entities
    entities = {
        '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
        '&quot;': '"', '&#39;': "'", '&ccedil;': 'ç', '&Ccedil;': 'Ç',
        '&ouml;': 'ö', '&Ouml;': 'Ö', '&uuml;': 'ü', '&Uuml;': 'Ü',
        '&lsquo;': "'", '&rsquo;': "'", '&ldquo;': '"', '&rdquo;': '"',
        '&bull;': '•', '&hellip;': '...'
    }
    for ent, val in entities.items():
        text = text.replace(ent, val)

    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def import_onenote_html_content(html_str: str, default_cat_id: int, fallback_title: str = "") -> dict:
    """OneNote veya HTML dosyasını ayrıştırıp liste veya serbest not sayfası oluşturur."""
    title = fallback_title or "OneNote Notu"
    m_title = re.search(r'<title[^>]*>(.*?)</title>', html_str, flags=re.IGNORECASE | re.DOTALL)
    if m_title and m_title.group(1).strip():
        title = m_title.group(1).strip()
    else:
        m_h1 = re.search(r'<h1[^>]*>(.*?)</h1>', html_str, flags=re.IGNORECASE | re.DOTALL)
        if m_h1 and m_h1.group(1).strip():
            raw_h1 = re.sub(r'<[^>]+>', '', m_h1.group(1)).strip()
            if raw_h1:
                title = raw_h1

    clean_text = clean_html_to_markdown(html_str)

    if title == "OneNote Notu" and clean_text:
        first_line = clean_text.split('\n')[0].replace('#', '').strip()[:40]
        if first_line:
            title = first_line

    # Checkbox var mı?
    if '[ ] ' in clean_text or '[x] ' in clean_text:
        page_id = db.add_page(default_cat_id, title, page_type="checklist", icon="🟣")
        lines = clean_text.split('\n')
        items_count = 0
        for line in lines:
            l = line.strip().lstrip('-').strip()
            if not l:
                continue
            if l.startswith('[x] '):
                db.add_item(page_id, l[4:].strip(), is_done=1)
                items_count += 1
            elif l.startswith('[ ] '):
                db.add_item(page_id, l[4:].strip(), is_done=0)
                items_count += 1
            else:
                db.add_item(page_id, l, is_done=0)
                items_count += 1
        return {"title": title, "type": "checklist", "source": "OneNote", "items_count": items_count}
    else:
        page_id = db.add_page(default_cat_id, title, page_type="notes", icon="🟣", content=clean_text)
        return {"title": title, "type": "notes", "source": "OneNote", "length": len(clean_text)}

def extract_text_from_one_binary(binary_bytes: bytes) -> str:
    """OneNote .one ikili dosyasından okunabilir metin bloklarını ayıklar."""
    try:
        raw_text = binary_bytes.decode('utf-16le', errors='ignore')
        lines = [re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', '', l).strip() for l in raw_text.split('\n')]
        clean_lines = [l for l in lines if len(l) > 3 and any(c.isalnum() for c in l)]
        if clean_lines:
            return '\n\n'.join(clean_lines[:100])
    except Exception:
        pass
    return ""

def import_google_keep_json_data(data: dict, default_cat_id: int) -> dict:
    """Tek bir Google Keep JSON verisini ayrıştırır."""
    title = data.get("title", "").strip()
    text_content = data.get("textContent", "").strip()
    list_content = data.get("listContent", [])
    labels = data.get("labels", [])

    cat_id = default_cat_id
    if labels:
        label_name = labels[0].get("name", "").strip()
        if label_name:
            cats = db.get_categories()
            matched_cat = next((c for c in cats if c['name'].lower() == label_name.lower()), None)
            if matched_cat:
                cat_id = matched_cat['id']
            else:
                cat_id = db.add_category(label_name, icon="🏷️", color="#6366f1")

    if not title:
        title = "Adsız Keep Notu"
        if text_content:
            first_line = text_content.split('\n')[0][:30]
            if first_line:
                title = first_line

    if list_content:
        # Checklist sayfası
        page_id = db.add_page(cat_id, title, page_type="checklist", icon="🛒")
        for item in list_content:
            item_text = item.get("text", "").strip()
            if item_text:
                is_done = 1 if item.get("isChecked") else 0
                db.add_item(page_id, item_text, is_done=is_done)
        return {"type": "checklist", "title": title, "items_count": len(list_content)}
    else:
        # Serbest not sayfası
        page_id = db.add_page(cat_id, title, page_type="notes", icon="📝", content=text_content)
        return {"type": "notes", "title": title, "length": len(text_content)}

def import_evernote_enex_str(enex_content: str, default_cat_id: int) -> list:
    """Evernote .enex XML içeriğini ayrıştırıp sayfalar oluşturur."""
    results = []
    # Güvenli XML ayrıştırma
    try:
        root = ET.fromstring(enex_content)
    except Exception:
        # CDATA hataları veya bozuk XML varsa regex ile note bloklarını yakala
        notes_raw = re.findall(r'<note>(.*?)</note>', enex_content, re.DOTALL)
        for nr in notes_raw:
            t_match = re.search(r'<title>(.*?)</title>', nr)
            title = t_match.group(1).strip() if t_match else "Evernote Notu"
            c_match = re.search(r'<content>(.*?)</content>', nr, re.DOTALL)
            content_raw = c_match.group(1) if c_match else ""
            clean_text = clean_enml_html(content_raw)

            # Checkbox içeriyor mu?
            has_todos = '[ ] ' in clean_text or '[x] ' in clean_text
            if has_todos:
                page_id = db.add_page(default_cat_id, title, page_type="checklist", icon="✅")
                lines = clean_text.split('\n')
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    if line.startswith('[x] '):
                        db.add_item(page_id, line[4:].strip(), is_done=1)
                    elif line.startswith('[ ] '):
                        db.add_item(page_id, line[4:].strip(), is_done=0)
                    else:
                        db.add_item(page_id, line, is_done=0)
                results.append({"title": title, "type": "checklist"})
            else:
                db.add_page(default_cat_id, title, page_type="notes", icon="📝", content=clean_text)
                results.append({"title": title, "type": "notes"})
        return results

    for note_el in root.findall('note'):
        title_el = note_el.find('title')
        title = title_el.text.strip() if (title_el is not None and title_el.text) else "Evernote Notu"

        cat_id = default_cat_id
        tag_el = note_el.find('tag')
        if tag_el is not None and tag_el.text:
            tag_name = tag_el.text.strip()
            cats = db.get_categories()
            matched_cat = next((c for c in cats if c['name'].lower() == tag_name.lower()), None)
            if matched_cat:
                cat_id = matched_cat['id']
            else:
                cat_id = db.add_category(tag_name, icon="📁", color="#10b981")

        content_el = note_el.find('content')
        content_raw = content_el.text if content_el is not None and content_el.text else ""
        clean_text = clean_enml_html(content_raw)

        if '[ ] ' in clean_text or '[x] ' in clean_text:
            page_id = db.add_page(cat_id, title, page_type="checklist", icon="✅")
            for line in clean_text.split('\n'):
                line = line.strip()
                if not line:
                    continue
                if line.startswith('[x] '):
                    db.add_item(page_id, line[4:].strip(), is_done=1)
                elif line.startswith('[ ] '):
                    db.add_item(page_id, line[4:].strip(), is_done=0)
                else:
                    db.add_item(page_id, line, is_done=0)
            results.append({"title": title, "type": "checklist"})
        else:
            db.add_page(cat_id, title, page_type="notes", icon="📝", content=clean_text)
            results.append({"title": title, "type": "notes"})

    return results

def import_microsoft_or_csv(csv_content: str, default_cat_id: int) -> list:
    """Microsoft To-Do / Wunderlist veya genel CSV dosyasını ayrıştırır."""
    reader = csv.DictReader(io.StringIO(csv_content))
    # Grupla (List Name veya Kategori bazında)
    groups = {}
    for row in reader:
        # Alan isimlerini normalize et
        norm = {k.lower().replace(' ', '_').replace('-', '_'): v for k, v in row.items() if k}
        list_name = norm.get('list_name') or norm.get('list') or norm.get('kategori') or norm.get('folder') or "Microsoft To-Do"
        task_title = norm.get('task_name') or norm.get('title') or norm.get('subject') or norm.get('görev') or norm.get('name')
        if not task_title:
            continue
        is_completed = 1 if norm.get('completed', '').lower() in ['true', '1', 'yes', 'evet', 'completed'] or norm.get('status', '').lower() in ['completed', 'tamamlandı'] else 0
        note = norm.get('notes') or norm.get('note') or norm.get('description') or ''

        if list_name not in groups:
            groups[list_name] = []
        groups[list_name].append({
            "title": task_title.strip(),
            "is_done": is_completed,
            "description": note.strip()
        })

    results = []
    for list_name, tasks in groups.items():
        page_id = db.add_page(default_cat_id, list_name, page_type="checklist", icon="📋")
        for t in tasks:
            db.add_item(page_id, t["title"], description=t.get("description", ""), is_done=t.get("is_done", 0))
        results.append({"title": list_name, "items_count": len(tasks)})

    return results

def process_uploaded_import_file(file_storage, source_type: str = 'auto', target_category_id: int = None) -> dict:
    """
    Yüklenen dosyayı inceler, türünü tespit eder ve veritabanına aktarır.
    """
    filename = (file_storage.filename or "").lower()
    content_bytes = file_storage.read()

    # Varsayılan aktarım kategorisi belirle
    if target_category_id:
        default_cat_id = int(target_category_id)
    else:
        cats = db.get_categories()
        import_cat_name = "İçe Aktarılanlar"
        cat_match = next((c for c in cats if import_cat_name.lower() in c['name'].lower()), None)
        if cat_match:
            default_cat_id = cat_match['id']
        else:
            default_cat_id = db.add_category(import_cat_name, icon="📥", color="#8b5cf6")

    imported_items = []
    errors = []

    # 1. ZIP veya OneNote Paketi (.onepkg) Dosyası
    if filename.endswith('.zip') or filename.endswith('.onepkg') or zipfile.is_zipfile(io.BytesIO(content_bytes)):
        try:
            with zipfile.ZipFile(io.BytesIO(content_bytes)) as z:
                for name in z.namelist():
                    if name.endswith('/') or '__MACOSX' in name:
                        continue
                    
                    # OneNote / HTML Dosyası
                    if name.lower().endswith(('.htm', '.html', '.mht')):
                        try:
                            html_str = z.read(name).decode('utf-8', errors='ignore')
                            base_name = os.path.splitext(os.path.basename(name))[0]
                            res = import_onenote_html_content(html_str, default_cat_id, fallback_title=base_name)
                            imported_items.append(res)
                        except Exception as e:
                            errors.append(f"{name}: {str(e)}")

                    # OneNote .one ikili dosya
                    elif name.lower().endswith('.one'):
                        try:
                            bin_data = z.read(name)
                            extracted = extract_text_from_one_binary(bin_data)
                            base_name = os.path.splitext(os.path.basename(name))[0] or "OneNote Bölümü"
                            if extracted:
                                db.add_page(default_cat_id, base_name, page_type="notes", icon="🟣", content=extracted)
                                imported_items.append({"title": base_name, "type": "notes", "source": "OneNote"})
                        except Exception as e:
                            errors.append(f"{name}: {str(e)}")

                    # Google Keep JSON
                    elif name.lower().endswith('.json'):
                        try:
                            f_data = json.loads(z.read(name).decode('utf-8', errors='ignore'))
                            if isinstance(f_data, dict) and ('listContent' in f_data or 'textContent' in f_data or 'title' in f_data):
                                res = import_google_keep_json_data(f_data, default_cat_id)
                                imported_items.append(res)
                        except Exception as e:
                            errors.append(f"{name}: {str(e)}")

                    # Evernote ENEX
                    elif name.lower().endswith('.enex'):
                        try:
                            enex_str = z.read(name).decode('utf-8', errors='ignore')
                            res_list = import_evernote_enex_str(enex_str, default_cat_id)
                            imported_items.extend(res_list)
                        except Exception as e:
                            errors.append(f"{name}: {str(e)}")

                    # Markdown / Metin Dosyası
                    elif name.lower().endswith('.md') or name.lower().endswith('.txt'):
                        try:
                            md_str = z.read(name).decode('utf-8', errors='ignore')
                            base_name = os.path.splitext(os.path.basename(name))[0]
                            if '- [ ]' in md_str or '- [x]' in md_str:
                                p_id = db.add_page(default_cat_id, base_name, page_type="checklist", icon="📋")
                                for line in md_str.split('\n'):
                                    l_str = line.strip()
                                    if l_str.startswith('- [x] ') or l_str.startswith('* [x] '):
                                        db.add_item(p_id, l_str[6:].strip(), is_done=1)
                                    elif l_str.startswith('- [ ] ') or l_str.startswith('* [ ] '):
                                        db.add_item(p_id, l_str[6:].strip(), is_done=0)
                            else:
                                db.add_page(default_cat_id, base_name, page_type="notes", icon="📝", content=md_str)
                            imported_items.append({"title": base_name, "type": "markdown"})
                        except Exception as e:
                            errors.append(f"{name}: {str(e)}")

        except Exception as e:
            return {"ok": False, "error": f"Arşiv dosyası açılamadı: {str(e)}"}

    # 2. OneNote / HTML Dosyası (.htm, .html, .mht)
    elif filename.endswith(('.htm', '.html', '.mht')) or source_type == 'onenote':
        try:
            html_str = content_bytes.decode('utf-8', errors='ignore')
            base_name = os.path.splitext(filename)[0] or "OneNote Notu"
            res = import_onenote_html_content(html_str, default_cat_id, fallback_title=base_name)
            imported_items.append(res)
        except Exception as e:
            return {"ok": False, "error": f"OneNote/HTML dosyası okunamadı: {str(e)}"}

    # 3. OneNote .one ikili dosya
    elif filename.endswith('.one'):
        try:
            extracted = extract_text_from_one_binary(content_bytes)
            base_name = os.path.splitext(filename)[0] or "OneNote Bölümü"
            if extracted:
                db.add_page(default_cat_id, base_name, page_type="notes", icon="🟣", content=extracted)
                imported_items.append({"title": base_name, "type": "notes", "source": "OneNote"})
            else:
                return {"ok": False, "error": "OneNote (.one) ikili dosyasından okunabilir metin çıkarılamadı. Lütfen OneNote içinden HTML/PDF olarak dışa aktarınız."}
        except Exception as e:
            return {"ok": False, "error": f"OneNote dosyası okunamadı: {str(e)}"}

    # 4. Evernote .enex Dosyası
    elif filename.endswith('.enex') or source_type == 'evernote':
        try:
            enex_str = content_bytes.decode('utf-8', errors='ignore')
            res = import_evernote_enex_str(enex_str, default_cat_id)
            imported_items.extend(res)
        except Exception as e:
            return {"ok": False, "error": f"Evernote dosyası okunamadı: {str(e)}"}

    # 5. JSON Dosyası (Google Keep veya Microsoft To-Do)
    elif filename.endswith('.json') or source_type == 'google_keep':
        try:
            json_data = json.loads(content_bytes.decode('utf-8', errors='ignore'))
            if isinstance(json_data, dict):
                res = import_google_keep_json_data(json_data, default_cat_id)
                imported_items.append(res)
            elif isinstance(json_data, list):
                for item in json_data:
                    if isinstance(item, dict) and ('listContent' in item or 'textContent' in item):
                        res = import_google_keep_json_data(item, default_cat_id)
                        imported_items.append(res)
                    elif isinstance(item, dict) and 'title' in item:
                        p_id = db.add_page(default_cat_id, item.get('title', 'Liste'), page_type="checklist", icon="📋")
                        for sub in item.get('items', item.get('tasks', [])):
                            stitle = sub.get('title') if isinstance(sub, dict) else str(sub)
                            sdone = 1 if isinstance(sub, dict) and sub.get('completed') else 0
                            db.add_item(p_id, stitle, is_done=sdone)
                        imported_items.append({"title": item.get('title'), "type": "checklist"})
        except Exception as e:
            return {"ok": False, "error": f"JSON dosyası ayrıştırılamadı: {str(e)}"}

    # 6. CSV Dosyası (Microsoft To-Do / Wunderlist / Excel)
    elif filename.endswith('.csv') or source_type == 'microsoft':
        try:
            csv_str = content_bytes.decode('utf-8', errors='ignore')
            res = import_microsoft_or_csv(csv_str, default_cat_id)
            imported_items.extend(res)
        except Exception as e:
            return {"ok": False, "error": f"CSV dosyası ayrıştırılamadı: {str(e)}"}

    # 7. Düz Metin veya Markdown
    elif filename.endswith('.md') or filename.endswith('.txt'):
        try:
            txt_str = content_bytes.decode('utf-8', errors='ignore')
            base_name = os.path.splitext(filename)[0] or "İçe Aktarılan Not"
            db.add_page(default_cat_id, base_name, page_type="notes", icon="📝", content=txt_str)
            imported_items.append({"title": base_name, "type": "notes"})
        except Exception as e:
            return {"ok": False, "error": f"Metin dosyası aktarılamadı: {str(e)}"}
    else:
        return {"ok": False, "error": "Desteklenmeyen dosya formatı. Lütfen .zip, .onepkg, .htm, .enex, .json, .csv veya .md yükleyin."}

    return {
        "ok": True,
        "imported_count": len(imported_items),
        "imported_items": imported_items,
        "errors": errors
    }
