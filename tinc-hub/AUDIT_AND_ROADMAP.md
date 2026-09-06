# 📋 TINC-HUB & NETWORK MAP — GELİŞTİRME, DENETİM VE İŞ LİSTESİ (AUDIT & ROADMAP)

> **Tarih:** 2026-09-06  
> **Amaç:** Bu doküman, Tinc-Hub ve İnteraktif Ağ Haritası (Cisco Packet Tracer benzeri) modülü üzerinde yapılan geliştirmeleri, mimari kararları, test sonuçlarını ve sırada bekleyen iş listesini diğer yapay zeka ajanları veya geliştiricilerin eksiksiz denetleyebilmesi için hazırlanmıştır.

---

## 📌 1. BİTEN İŞLER VE YAPILAN GELİŞTİRMELER (COMPLETED)

### A. Ağ Haritası UI/UX & Etkileşim İyileştirmeleri
1. **Kablo Tıklama / Tuval Yapışması (Sticky Drag Bug) Düzeltildi:**
   * Sorun: Kabloya tıklandığında tuval fareye yapışıp sürükleniyordu.
   * Çözüm: Vis.js mousedown event capturing ve propagation mekanizması düzeltildi; düğüm/kablo tıklamalarında tuval pan motoru ile çakışma önlendi.
2. **Sağ Sidebar Sabitleme (Always Visible Sidebar):**
   * Sidebar'ın kendi kendine kapanması/küçülmesi engellendi, flex yapısıyla tuvalin yanında daima görünür kılındı. Boş alana tıklandığında genel ağ istatistiklerini gösteren `idle-details` paneline geçer.
3. **Saydamlık & Okunabilirlik Düzenlemesi:**
   * Context menü, modal pencereler ve panellerdeki aşırı şeffaflık ve backdrop-filter kaldırıldı. Katı (solid) profesyonel arka plan renkleri uygulandı.
4. **Buton Karmaşası ve Sadeleştirme:**
   * Ağ haritası araç çubuğundaki (toolbar) butonlar sadeleştirildi, metin kalabalığı azaltılarak simgeli ve gruplu hale getirildi.

---

### B. Cisco Standartlarında Modüler Port & Donanım Arayüzleri
1. **Sahte / İllüzyon Arama Motorunun Kaldırılması:**
   * Botnet/captcha engellerine takılan ve sahte hissiyat oluşturan "Web/Datasheet ara" butonu tamamen kaldırıldı.
2. **Marka ve Model Serbest Girişi:**
   * Hem "Yeni Cihaz Ekle" modalına hem de "Cihaz Özellikleri" paneline bağımsız `Marka` (Brand) ve `Model No` girişleri eklendi.
3. **Cisco Tarzı Modüler Donanım Portları (Interface Architecture):**
   * **LAN Portları:** Adet (0-52) ve Hız (100 Mbps, 1 Gbps, 2.5 Gbps, 10 Gbps, Yok).
   * **WAN Portu:** Yok, 100M WAN, 1G WAN, 2.5G WAN.
   * **Wi-Fi Modülü (AP):** Yok, 2.4 GHz, Dual-Band (2.4 + 5 GHz), Wi-Fi 6 AX.
   * **PoE Desteği:** Güç anahtarı (Power over Ethernet).
4. **Kablolarda Uçtan Uca Arayüz Eşleştirmesi (Interface-to-Interface Mapping):**
   * Kablo seçildiğinde iki ucundaki cihazların yeteneklerine göre dinamik port listesi oluşturulur (Örn: Cihaz A: `LAN 1`, Cihaz B: `WAN`).
   * Kablo etiketinde Cisco tarzı arayüz bilgisi gösterilir: `1 Gbps [LAN1↔WAN]`.
5. **Otomatik Hız Anlaşması (Auto-Negotiation):**
   * Örneğin 1 Gbps portlu bir PC, 100 Mbps portlu bir switch/router'a bağlandığında hat hızı otomatik olarak düşük olan donanım portunun hızına (100 Mbps) çekilir ve bottleneck uyarısı verilir.

---

### C. Servis Taraması & Backend Denetimi (Audit)
1. **192.168.1.2 (Pi-hole) Servis Tarama Hatası Giderildi:**
   * Sorun: Kullanıcı `Servis Tara` yaptığında açık olan portlar kırmızı "KAPALI" görünüyordu.
   * Kök Neden: Backend `s.success: true` dönerken, frontend `s.status` kontrolü yapıyordu (undefined -> false).
   * Çözüm: `s.success || s.status` kontrolü sağlandı, DNS (Port 53) listeye eklendi. Canlı testle HTTP(80), HTTPS(443), SSH(22), DNS(53) portlarının gerçek bağlantıyla doğru çalıştığı doğrulandı.
2. **Gerçek Cihaz Testi (192.168.1.9 Zyxel VMG3312-B10A):**
   * Canlı bağlantı kurularak sistemin WAN uplink modu ve Wi-Fi/LAN port mimarisi doğrulandı.

---

### D. Güvenlik, Dayanıklılık ve Backend İyileştirmeleri (Security & Backend Enhancements)
1. **Terminal API Rol Tabanlı Erişim Denetimi (RBAC):**
   * Sadece `role == 'admin'` yetkisine sahip kullanıcıların terminal komutu çalıştırabilmesi sağlandı.
   * Komut uzunluğu 500 karakter ile sınırlandı ve tehlikeli kalıplardan oluşan kara liste genişletildi.
2. **Open Redirect Koruması:**
   * `/login` endpoint'inde `next` yönlendirmesi `urlparse` ile kontrol edilerek harici URL'lere yetkisiz yönlendirmeler engellendi.
3. **Otomatik Kriptografik SECRET_KEY Üretimi:**
   * `install.sh` içerisine varsayılan anahtar yerine `openssl rand -hex 32` ile rastgele gizli anahtar oluşturma eklendi.
4. **Varsayılan Misafir (Guest) Kullanıcısının Kaldırılması:**
   * `users.py` içindeki varsayılan `misafir:1234` kullanıcısı temizlendi, sadece admin rolü korundu.
5. **api_remote.py Yetkilendirme Koruması:**
   * `/action` endpoint'i `HUB_API_TOKEN` zorunlu tutularak token tanımlı değilse 403 ile kapatıldı.
6. **Kritik API Endpoint'lerine `@admin_required` Koruması:**
   * `api_apps.py`, `api_settings.py`, `api_system.py` altındaki kritik yönetim API'leri `@admin_required` decorator'ı ile koruma altına alındı.
7. **XDG_RUNTIME_DIR f-string Düzeltmesi:**
   * `api_apps.py` ve `api_system.py` içindeki eksik `f` formatlama string hatası düzeltildi.
8. **packet_sniffer.py Thread-Safety ve Dinamik Gateway:**
   * Ortak `stats` sözlüğü erişimlerine `_stats_lock = threading.Lock()` eklendi.
   * Hardcoded `KNOWN_GATEWAY = "192.168.1.1"` yerine `topology.json`'dan dinamik okuyan mekanizma eklendi.
9. **Hardcoded Repo Yollarının Parametrik Yapılması:**
   * `/home/turan/101/` sabit dizin referansları `config.env` dosyasındaki `REPO_BASE_DIR` parametresine bağlandı.

---

### E. Ağ Haritası Sayfa Düzeltmeleri & Gerçek Entegrasyonlar
1. **Düz Metin (Plaintext) Şifre Kaydının Kaldırılması:**
   * `network.html` içindeki `saveTopology` fonksiyonundan cihaz şifresi kaldırıldı, `topology.json` dosyasına şifre kaydedilmesi engellendi. Arayüzde sadece aktif SSH oturumunda kullanılacağı belirtildi.
2. **Gerçek Ping ve Nmap Backend Entegrasyonu:**
   * `network.html` context menüsündeki sahte / illüzyon setTimeout simülasyonları kaldırıldı.
   * `api_network.py` içerisine gerçek `/api/network/ping` (`ping -c 4 -W 1`) ve `/api/network/nmap` (`nmap -T3 --top-ports 20 --open`) endpoint'leri yazıldı ve haritaya bağlandı.
3. **Port Doluluk Takibi (Port Exhaustion Check):**
   * Kablo çekildiğinde kaynak veya hedef cihazın tanımlı `port_count` limitine ulaşıp ulaşmadığı (`checkPortExhaustion`) denetlenerek aşırı kablo çekilmesi engellendi ve uyarı verildi.
4. **Otomatik Kayıt (Debounced Autosave):**
   * Düğüm ve kablo değişikliklerinde 5 saniyelik debounced autosave (`scheduleAutosave`) tetiklenerek veri kaybı önlendi.
5. **Akıllı Cihaz Tanıma Modal Entegrasyonu:**
   * "Yeni Cihaz Ekle" modalında model girilip alan terk edildiğinde (`onblur`) `lookupAndFillNewNodeSpecs()` tetiklenerek donanım özellikleri otomatik dolduruldu.
6. **Dark Mode PNG Dışa Aktarım Düzeltmesi:**
   * `exportTopology` fonksiyonunda dark mode aktifliğine göre dinamik arka plan (`#0b0f19` / `#ffffff`) kullanılarak koyu tema export hatası giderildi.
7. **Çevrimdışı (Offline) Vis-Network Kütüphanesi:**
   * Dış CDN bağımlılığı kaldırılarak `vis-network.min.js` lokal `dashboard/static/js/` dizinine indirildi, `network.html` ve `install.sh` bu yola uyarlandı.

---

## 🚀 2. SIRADAKİ İŞ LİSTESİ (ROADMAP & BACKLOG)

Gelecek yapay zeka ajanları veya geliştiriciler sırasıyla şu maddeleri ele alacaktır:

- [x] **1. Port Doluluk Takibi (Port Exhaustion / Port Capacity Check):** (TAMAMLANDI ✅)
- [x] **2. Güvenlik ve Kod Kalitesi İyileştirmeleri:** (TAMAMLANDI ✅)
- [x] **3. Gerçek Ping & Nmap Backend Entegrasyonu:** (TAMAMLANDI ✅)
- [ ] **4. LLM / AI API Entegrasyonu ile Otomatik Donanım Tanıma (İsteğe Bağlı Mod):**
  - Kullanıcı ayarlardan Gemini / OpenAI API anahtarı girdiğinde, yazılan marka/model için gerçek AI destekli datasheet çözümleme motoru.
- [ ] **5. Yerel Ağ Otomatik Donanım Keşfi (Nmap / UPnP / SNMP Entegrasyonu):**
  - Ağa yeni cihaz bağlandığında UPnP SSDP ve mDNS paketlerinden cihazın tam adını ve üreticisini okuyup otomatik haritaya ekleme.
- [ ] **6. VLAN & Alt Ağ (Subnet) Görselleştirmesi:**
  - Port bazlı VLAN atama (Trunk / Access Port) ve haritada farklı VLAN'ların renkli çerçevelerle gösterilmesi.
- [ ] **7. Ağ Trafiği ve Bant Genişliği Canlı Simülasyonu:**
  - Kabloların üzerinden geçen anlık veri akışını gösteren animasyonlu parçacıklar (Packet Tracer flow simulation).

---

## 🔍 3. AJAN DENETİMİ İÇİN KONTROL TALİMATI (INSPECTION GUIDE)

Bir sonraki ajan sistemi denetlerken aşağıdaki dosyaları referans almalıdır:
* **Ön Yüz Arayüzü & Olaylar:** `/home/turan/101/tinc-hub/dashboard/templates/network.html`
  - `checkPortExhaustion`: Cihazın LAN port kapasite denetimi.
  - `scheduleAutosave`: Debounced otomatik harita kaydı.
  - `exportTopology`: Temaya duyarlı PNG dışa aktarma.
  - `handleContextMenuAction`: Gerçek `/api/network/ping` ve `/api/network/nmap` çağrıları.
* **Backend Ağ API'si:** `/home/turan/101/tinc-hub/dashboard/blueprints/api_network.py`
  - `/ping` ve `/nmap` endpoint'leri.
* **Yetkilendirme & Güvenlik:**
  - `dashboard/app.py`: `@admin_required` decorator'ı.
  - `dashboard/blueprints/api_terminal.py`: Rol kontrolü ve komut filtreleme.
  - `dashboard/blueprints/auth.py`: Open Redirect doğrulaması.
  - `dashboard/blueprints/api_remote.py`: Token zorunluluğu.
* **Paket Dinleyici & Servis:**
  - `dashboard/packet_sniffer.py`: `_stats_lock` ve `get_known_gateway()`.
* **Canlı Servis:** `systemctl status tinc-hub.service` (Port: 9010)

