#!/usr/bin/env python3
"""
changelog_manager.py
--------------------
Tinc-Hub Topoloji Değişiklik Günlüğü Yöneticisi.

Her topoloji kaydında otomatik snapshot oluşturur ve
iki snapshot arasındaki farkları (eklenen/silinen node ve edge)
karşılaştırma imkânı sunar.

Snapshot dosyaları JSON formatında saklanır:
    /opt/tinc-hub/shared/changelog/YYYYMMDD_HHMMSS.json
"""

import json
import os
import time
import glob

# Snapshot'ların saklanacağı dizin (üretim ortamı)
CHANGELOG_DIR = '/opt/tinc-hub/shared/changelog/'

# Kaç snapshot'ı saklamak istiyoruz (en eski fazlalar silinir)
MAX_SNAPSHOTS = 30


# ──────────────────────────────────────────────────────────────────────────────
# Snapshot Kaydetme
# ──────────────────────────────────────────────────────────────────────────────

def save_snapshot(topology_data: dict, changed_by: str = 'system') -> str | None:
    """
    Mevcut topoloji verisini tarih damgalı bir JSON dosyası olarak kaydeder.
    En fazla MAX_SNAPSHOTS dosya tutulur; eskiler otomatik silinir.

    Parametreler:
        topology_data : Kaydedilecek topoloji dict'i (nodes + edges)
        changed_by    : Değişikliği yapan kişi/sistem (loglama amaçlı)

    Döner:
        Oluşturulan dosyanın adı (örn. '20260904_120000.json')
        Hata oluşursa None.
    """
    # Klasörün var olduğundan emin ol
    os.makedirs(CHANGELOG_DIR, exist_ok=True)

    # Tarih damgası oluştur (YYYYMMDD_HHMMSS formatı)
    timestamp = time.strftime('%Y%m%d_%H%M%S')
    filename = f'{timestamp}.json'
    filepath = os.path.join(CHANGELOG_DIR, filename)

    # Snapshot nesnesine üst veri ekle
    snapshot = {
        'timestamp': timestamp,
        'changed_by': changed_by,
        'saved_at': time.strftime('%Y-%m-%d %H:%M:%S'),
        'topology': topology_data
    }

    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(snapshot, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f'[ChangelogManager] Snapshot kayıt hatası: {e}')
        return None

    # Eski snapshot'ları temizle: yalnızca son MAX_SNAPSHOTS dosyayı tut
    _cleanup_old_snapshots()

    return filename


def _cleanup_old_snapshots():
    """
    Changelog dizinindeki snapshot sayısı MAX_SNAPSHOTS'u geçiyorsa
    en eski dosyaları siler. Dosyalar isim sırasıyla sıralanır;
    tarih damgalı isimlendirmede bu sıralama kronolojik sıraya karşılık gelir.
    """
    # Tüm JSON snapshot dosyalarını al ve sırala (eski → yeni)
    pattern = os.path.join(CHANGELOG_DIR, '*.json')
    files = sorted(glob.glob(pattern))

    # Eşiği aşan dosyaları sil
    while len(files) > MAX_SNAPSHOTS:
        oldest = files.pop(0)  # En eski dosyayı al (baştan)
        try:
            os.remove(oldest)
            print(f'[ChangelogManager] Eski snapshot silindi: {os.path.basename(oldest)}')
        except Exception as e:
            print(f'[ChangelogManager] Dosya silme hatası ({oldest}): {e}')


# ──────────────────────────────────────────────────────────────────────────────
# Snapshot Listeleme
# ──────────────────────────────────────────────────────────────────────────────

def list_snapshots() -> list:
    """
    Changelog dizinindeki tüm snapshot dosyalarını tarih ve boyut bilgisiyle listeler.

    Döner:
        Yeniden eskiye sıralı dict listesi:
        [
            {
                'filename' : '20260904_120000.json',
                'date'     : '2026-09-04 12:00:00',
                'size_kb'  : 12.4
            },
            ...
        ]
    """
    # Dizin yoksa boş liste döndür
    if not os.path.isdir(CHANGELOG_DIR):
        return []

    pattern = os.path.join(CHANGELOG_DIR, '*.json')
    files = sorted(glob.glob(pattern), reverse=True)  # Yeniden eskiye

    result = []
    for filepath in files:
        fname = os.path.basename(filepath)
        try:
            stat = os.stat(filepath)
            size_kb = round(stat.st_size / 1024, 2)

            # Dosya adından tarih ayrıştır (YYYYMMDD_HHMMSS)
            name_part = fname.replace('.json', '')
            try:
                # YYYYMMDD_HHMMSS → "YYYY-MM-DD HH:MM:SS"
                date_str = (
                    f'{name_part[0:4]}-{name_part[4:6]}-{name_part[6:8]} '
                    f'{name_part[9:11]}:{name_part[11:13]}:{name_part[13:15]}'
                )
            except IndexError:
                date_str = fname  # Ayrıştırılamazsa ham adı kullan

            result.append({
                'filename': fname,
                'date': date_str,
                'size_kb': size_kb
            })
        except Exception as e:
            print(f'[ChangelogManager] Dosya bilgisi okunamadı ({fname}): {e}')

    return result


# ──────────────────────────────────────────────────────────────────────────────
# Snapshot Yükleme
# ──────────────────────────────────────────────────────────────────────────────

def load_snapshot(filename: str) -> dict | None:
    """
    Belirtilen snapshot dosyasını yükler ve içeriğini döner.

    Parametreler:
        filename : Yüklenecek dosyanın adı (örn. '20260904_120000.json')
                   Path traversal saldırılarına karşı yalnızca basename kullanılır.

    Döner:
        Snapshot dict'i, dosya bulunamazsa None.
    """
    # Güvenlik: yalnızca basename al, path traversal engelle
    safe_name = os.path.basename(filename)
    filepath = os.path.join(CHANGELOG_DIR, safe_name)

    if not os.path.exists(filepath):
        print(f'[ChangelogManager] Snapshot bulunamadı: {safe_name}')
        return None

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f'[ChangelogManager] Snapshot yükleme hatası ({safe_name}): {e}')
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Snapshot Karşılaştırma (Diff)
# ──────────────────────────────────────────────────────────────────────────────

def diff_snapshots(filename1: str, filename2: str) -> dict:
    """
    İki snapshot arasındaki topoloji farklarını karşılaştırır.
    Eklenen ve silinen node'ları ve edge'leri bulur.

    Parametreler:
        filename1 : İlk (eski) snapshot dosyasının adı
        filename2 : İkinci (yeni) snapshot dosyasının adı

    Döner:
        {
            'nodes_added'   : [node_id, ...],   — filename2'de var, filename1'de yok
            'nodes_removed' : [node_id, ...],   — filename1'de var, filename2'de yok
            'edges_added'   : [edge_key, ...],  — filename2'de var, filename1'de yok
            'edges_removed' : [edge_key, ...],  — filename1'de var, filename2'de yok
            'error'         : str | None        — Hata varsa mesaj
        }
    """
    # Her iki dosyayı yükle
    snap1 = load_snapshot(filename1)
    snap2 = load_snapshot(filename2)

    if snap1 is None:
        return {'error': f'Snapshot bulunamadı: {filename1}',
                'nodes_added': [], 'nodes_removed': [],
                'edges_added': [], 'edges_removed': []}
    if snap2 is None:
        return {'error': f'Snapshot bulunamadı: {filename2}',
                'nodes_added': [], 'nodes_removed': [],
                'edges_added': [], 'edges_removed': []}

    # Topoloji verilerini çıkar
    topo1 = snap1.get('topology', snap1)  # Eski format uyumluluğu
    topo2 = snap2.get('topology', snap2)

    # Node'ları karşılaştır
    # nodes dict ise key'leri, list ise id alanlarını kullan
    nodes1 = _extract_node_ids(topo1.get('nodes', {}))
    nodes2 = _extract_node_ids(topo2.get('nodes', {}))

    nodes_added = list(nodes2 - nodes1)    # Yenide var, eskide yok
    nodes_removed = list(nodes1 - nodes2)  # Eskide var, yenide yok

    # Edge'leri karşılaştır
    edges1 = _extract_edge_keys(topo1.get('edges', []))
    edges2 = _extract_edge_keys(topo2.get('edges', []))

    edges_added = list(edges2 - edges1)    # Yenide var, eskide yok
    edges_removed = list(edges1 - edges2)  # Eskide var, yenide yok

    return {
        'file1': filename1,
        'file2': filename2,
        'nodes_added': sorted(nodes_added),
        'nodes_removed': sorted(nodes_removed),
        'edges_added': sorted(edges_added),
        'edges_removed': sorted(edges_removed),
        'error': None
    }


def _extract_node_ids(nodes) -> set:
    """
    Node veri yapısından ID setini çıkarır.
    nodes hem dict (id → node_data) hem de list ([{id: ...}, ...]) olabilir.
    """
    if isinstance(nodes, dict):
        return set(nodes.keys())
    elif isinstance(nodes, list):
        return {n.get('id') for n in nodes if n.get('id')}
    return set()


def _extract_edge_keys(edges) -> set:
    """
    Edge listesinden benzersiz anahtar setini çıkarır.
    Edge anahtarı 'from-to' formatında oluşturulur.
    """
    result = set()
    if isinstance(edges, list):
        for edge in edges:
            # Edge hem 'from/to' hem de 'source/target' anahtarlarını destekle
            frm = edge.get('from') or edge.get('source') or ''
            to = edge.get('to') or edge.get('target') or ''
            if frm and to:
                # Yönsüz karşılaştırma: her iki yön de aynı kenar sayılır
                result.add(f'{min(frm, to)}-{max(frm, to)}')
    elif isinstance(edges, dict):
        # Bazı eski formatlarda edges dict olarak saklanıyor
        result = set(edges.keys())
    return result
