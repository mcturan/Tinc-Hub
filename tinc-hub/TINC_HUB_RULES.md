# TINC HUB KURALLARI VE MİMARİSİ (AI MANIFEST)

## 1. Genel Bilgi
- **Proje Adı:** Tinc Hub
- **Eski Adı:** TINC Köle (Tüm eski adlar silinmiş ve Tinc Hub olarak değiştirilmiştir. Bir yerde TINC Köle görürsen Tinc Hub olarak değiştir).
- **Amaç:** CasaOS benzeri, portları, servisleri ve Docker container'larını tek bir panelden yöneten bir Dashboard.
- **Konum:** Github deposunda `101/tinc-hub` altında geliştirilir. Ancak çalışan sistem `/opt/tinc-hub` dizininde, ayarlar ise `/etc/tinc-hub` dizinindedir. Herhangi bir kod yazıldığında önce `/home/turan/101/tinc-hub` içine yazılır, ardından `install.sh` çalıştırılarak `/opt/` dizinine alınır.

## 2. Mimari
- **Backend:** Flask (`app.py`), veritabanı SQLite (`shared/db.py`).
- **Uygulama Kayıt Defteri:** `/etc/tinc-hub/apps.yaml`. Bu dosya uygulamaların ID, ad, port, repo, kategori ve en önemlisi **parent** (alt/üst ilişkisi) bilgilerini tutar.
- **Kullanıcı Servisleri:** Eğer bir systemd servisi `--user` bayrağı ile çalışıyorsa, `apps.yaml`'da `is_user_service: true` olmalıdır. Bu sayede `health.py` root yetkisinden çıkıp `sudo -u turan XDG_RUNTIME_DIR=/run/user/1000` ile kontrol eder.
- **Arayüz (UI):** Dikey listeleme, light tema. Ana ekran `hub.html`. Eski `apps.html` silinmiş ve özellikleri (Kategoriler, Docker container keşfi, modal) ana ekrana taşınmıştır.

## 3. Kurallar (Yeni Bir Şey Eklerken)
1. **Kurulum Mantığı:** `dashboard/templates`, `dashboard/static` veya `dashboard/*.py` dosyalarında değişiklik yaptığında mutlaka `sudo bash /home/turan/101/tinc-hub/dashboard/install.sh --only=dashboard` komutunu çalıştır ve `sudo systemctl restart tinc-hub` ile servisi yeniden başlat. Aksi halde değişiklikler yayına alınmaz. (Ek olarak tarayıcıda Ctrl+F5 ile cache temizliği istenmelidir.)
2. **Uygulama Butonları:** UI tarafındaki Butonlar dinamik olarak DOM'dan kaldırılmamalı (örn. URL'si yoksa "Aç" butonu silinmesin). Bunun yerine koşullara göre `.btn-disabled` sınıfı eklenmeli ve tıklanınca `alert` göstermelidir. Standart UI görünümü korunmalıdır.
3. **Loglar:** SSE log akışı `app.py` üzerinde aktiftir ve `proxy_buffering off;` Nginx ayarı sayesinde gecikmesiz gelir.
4. **Agent/Sub-process Eklentileri:** `tinc-hub/agents` dizini altında eklenebilir. Tinc Hub veritabanına log ve metrik basmak için `shared/db.py` import edilmelidir.
