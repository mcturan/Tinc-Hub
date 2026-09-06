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

## 🚀 2. SIRADAKİ İŞ LİSTESİ (ROADMAP & BACKLOG)

Gelecek yapay zeka ajanları veya geliştiriciler sırasıyla şu maddeleri ele alacaktır:

- [ ] **1. Port Doluluk Takibi (Port Exhaustion / Port Capacity Check):**
  - Cihaza tanımlanan LAN port adedi (örn: 4 port) dolduğunda yeni kablo takılmasını engelleme veya "Tüm portlar dolu!" uyarısı verme.
- [ ] **2. LLM / AI API Entegrasyonu ile Otomatik Donanım Tanıma (İsteğe Bağlı Mod):**
  - Kullanıcı ayarlardan Gemini / OpenAI API anahtarı girdiğinde, yazılan marka/model için gerçek AI destekli datasheet çözümleme motoru.
- [ ] **3. Yerel Ağ Otomatik Donanım Keşfi (Nmap / UPnP / SNMP Entegrasyonu):**
  - Ağa yeni cihaz bağlandığında UPnP SSDP ve mDNS paketlerinden cihazın tam adını ve üreticisini okuyup otomatik haritaya ekleme.
- [ ] **4. VLAN & Alt Ağ (Subnet) Görselleştirmesi:**
  - Port bazlı VLAN atama (Trunk / Access Port) ve haritada farklı VLAN'ların renkli çerçevelerle gösterilmesi.
- [ ] **5. Ağ Trafiği ve Bant Genişliği Canlı Simülasyonu:**
  - Kabloların üzerinden geçen anlık veri akışını gösteren animasyonlu parçacıklar (Packet Tracer flow simulation).

---

## 🔍 3. AJAN DENETİMİ İÇİN KONTROL TALİMATI (INSPECTION GUIDE)

Bir sonraki ajan sistemi denetlerken aşağıdaki dosyaları referans almalıdır:
* **Ön Yüz Arayüzü & Olaylar:** `/home/turan/101/tinc-hub/dashboard/templates/network.html`
  - `populateNodeDetailsInSidebar`: Düğüm donanım portlarının doldurulması.
  - `saveNodeDetails`: Düğümün marka, model, LAN/WAN/Wi-Fi özelliklerinin kaydedilmesi.
  - `saveEdgeDetails`: Kablonun iki ucundaki arayüz eşleştirmesinin (Cisco mapping) kaydedilmesi.
  - `checkNodeServices`: Canlı soket port tarama sonuçlarının ekrana çizilmesi.
* **Backend Ağ API'si:** `/home/turan/101/tinc-hub/dashboard/blueprints/api_network.py`
* **Soket Servis Monitörü:** `/home/turan/101/tinc-hub/dashboard/service_monitor.py`
* **Canlı Servis:** `systemctl status tinc-hub.service` (Port: 9010)
