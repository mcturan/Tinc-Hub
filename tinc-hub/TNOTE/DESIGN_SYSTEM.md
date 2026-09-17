# TincNote — UI/UX Tasarım ve Mimari Standartları (Design System & Invariants)

Bu belge, TincNote bileşenlerinin, arayüz tasarımının, etkileşim kalıplarının ve veri akışının bozulmasını önlemek için hazırlanmış **değişmez kurallar bütünüdür (Single Source of Truth)**. Gelecekte yapılacak hiçbir geliştirme buradaki kuralları ihlal edemez.

---

## 1. Temel Tasarım Felsefesi & Kurumsal Kimlik
* **TincSuite Bütünlüğü:** TincNote, bağımsız rengarenk bir hobi aracı değil; TincHub ekosisteminin profesyonel, temiz, sade kurumsal slate arayüzüne tam uyumlu bir modülüdür.
* **Arka Plan ve Kart Standartları:**
  * Uygulama genel arka planı: `--bg: #f8fafc`
  * Kart ve panel yüzeyleri: `--surface: #ffffff`
  * İkincil yüzey / hover: `--surface2: #f1f5f9`
  * Kenarlıklar: `--border: #e2e8f0`
  * Birincil Vurgu Rengi: `--primary: #0284c7` (sakin kurumsal mavi)
  * Ana Metin: `--text: #0f172a`
  * Yardımcı / İkincil Metin: `--muted: #475569`
* **"Halk Pazarı" Dağınıklığı Yasağı:**
  * Kategori kenarlarında renkli dikey çizgiler (`border-left: 3px solid ...`) kesinlikle YASAKTIR.
  * Kategori yanlarında rastgele renkli yuvarlak noktalar (`.cat-color-dot`) kesinlikle YASAKTIR.
  * Kartlar arası aşırı dikey ve yatay boşluk (padding/margin israfı) yapılmaz; kompakt, bilgi yoğunluğu yüksek ve dengeli düzen korunur.

---

## 2. İkon ve Emoji Kullanım Kuralı
* **Sistem Dayatması Yasaktır:** Sistem tarafından kategori isimlerine, sayfa başlıklarına, butonlara, modal başlıklarına veya sekme etiketlerine otomatik emoji enjekte edilmesi (ör. `📁`, `⚡`, `💳`, `🔴`, `🟡`, `🟠`, `🟢`) KESİNLİKLE YASAKTIR.
* **Serbest Kullanıcı Tercihi:** Kullanıcı kendi isteğiyle bir sayfa, kategori veya görev ismi yazarken emoji kullanabilir (`"🛒 Market Listesi"`); sistem buna müdahale etmez ancak kendisi zorla eklemez.
* **SVG Vektör Standardı:** Arayüzdeki tüm buton, aksiyon ve navigasyon simgeleri kurumsal SVG sprite (`templates/tnote/_icons.html`) üzerinden çekilir:
  * Düzenle: `<svg class="svg-icon svg-icon-xs"><use href="#i-edit"/></svg>`
  * Sil: `<svg class="svg-icon svg-icon-xs"><use href="#i-trash"/></svg>`
  * Klasör: `<svg class="svg-icon svg-icon-xs"><use href="#i-folder"/></svg>`
  * Ekle: `<svg class="svg-icon svg-icon-xs"><use href="#i-plus"/></svg>`
  * Görev/Onay: `<svg class="svg-icon svg-icon-xs"><use href="#i-check-square"/></svg>`

---

## 3. "Görevler" (Unified Tasks) Etkileşim Standardı
* **Bölüm Başlığı:** Bölüm adı istisnasız **"Görevler"** olarak kalacaktır (eski `Planlanan Görev & Ödemeler` veya benzeri karmaşık başlıklar kullanılmaz).
* **Tek Rozet Kuralı (Anti-Duplication):**
  * Sayfa adı ile görev rozeti yan yana mükerrer yazdırılamaz (`[Market Listesi] [Market Listesi]` YASAKTIR).
  * `due_badge` yalnızca somut bir vade/tarih (`Gecikmiş (05.09)`, `20.09`, `Bugün`, `Yarın`) veya durum varsa gösterilir. Normal liste maddelerinde `due_badge` `None` olmalıdır.
* **Tam Etkileşim:**
  * **Satıra Tıklama:** Satırın herhangi bir yerine tıklandığında doğrudan kaynak sayfa açılır (`loadPage(t.page_id)`).
  * **Hızlı Düzenleme (`#i-edit`):** Görev başlığı yerinde veya modal ile anında düzenlenebilir.
  * **Doğrudan Silme (`#i-trash`):** Görev veya fatura listeden doğrudan silinebilir.
  * **Tamamlama (`checkbox`):** Tıklandığında `event.stopPropagation()` ile sayfa açılmadan anında işaretlenir ve durum eşitlenir.

---

## 4. OneNote Modeli Anında Otomatik Kayıt (Instant Auto-Save)
* **Manuel Kaydet Butonları Yasaktır:** Düz Not görünümünde veya Proje "Fikir & Şartname" panellerinde kullanıcıyı "Kaydet" butonuna basmaya zorlamak YASAKTIR.
* **Kayıt Mimarisi:**
  1. **400ms Debounce:** Kullanıcı yazarken her harfte istek atılmaz; tuş basımı durduktan 400ms sonra sessizce arka planda sunucuya aktarılır.
  2. **Anında Blur Tetikleyici:** Kullanıcı metin kutusundan çıktığı (`onblur`) anda debounce beklenmeden anında kaydedilir.
  3. **Tarayıcı Kapanma Güvencesi (`beforeunload` & `sendBeacon`):** Sayfa yenilenirken veya kapatılırken veriler `navigator.sendBeacon` ile garantiye alınır ve `localStorage` içine kaydedilir.
  4. **Durum Bildirimi:** Sağ üstte bağırmayan, zarif bir `Kaydedildi ✓` göstergesi yer alır.

---

## 5. Çevrimdışı (Offline-First) & PWA Mimarisi
* **Service Worker (`static/sw.js`):** Uygulama kabuğu, css, js ve statik varlıklar önbelleğe alınır. Uygulama mobil veya masaüstünde çevrimdışı açılabilir.
* **Yerel Taslak & Mutasyon Kuyruğu (`localStorage`):**
  * Her tuş vuruşunda `tnote_draft_${pageId}` güncellenir.
  * Cihaz çevrimdışıysa mutasyon `tnote_offline_queue` dizisine eklenir ve arayüzde `Kaydedildi (çevrimdışı) ✓` bilgisi verilir.
  * Bağlantı geri geldiğinde (`window.addEventListener('online')`) tüm kuyruk arka planda otomatik eşitlenir ve kullanıcıya `Tüm çevrimdışı değişiklikler eşitlendi ✓` tostu gösterilir.
