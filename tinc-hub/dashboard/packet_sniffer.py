#!/usr/bin/env python3
import subprocess
import re
import json
import time
import threading
import os

STATS_FILE = "/opt/tinc-hub/shared/wireshark_stats.json"

# Bu sözlük tüm ağ istatistiklerini hafızada tutar
stats = {
    "top_talkers": {}, # IP bazlı paket/veri sayacı
    "protocols": {"HTTP (80)": 0, "HTTPS (443)": 0, "DNS (53)": 0, "SSH (22)": 0, "DİĞER": 0},
    "dns_queries": [], # Hangi IP hangi siteye girdi
    "rogue_dhcp": []   # Ağda IP dağıtan yabancı (Rogue) cihazlar
}

KNOWN_GATEWAY = "192.168.1.1"  # İdealde bu topology'den dinamik çekilmelidir

def save_stats_loop():
    """Her 5 saniyede bir istatistikleri diske yazar, Dashboard (API) buradan okur."""
    while True:
        try:
            os.makedirs(os.path.dirname(STATS_FILE), exist_ok=True)
            # Hafızanın şişmemesi için DNS listesini son 50 kayıtla sınırla
            if len(stats["dns_queries"]) > 50:
                stats["dns_queries"] = stats["dns_queries"][-50:]
                
            # Top talkers listesinde gereksiz ip'leri silip en yüksek 20'yi tutabiliriz, 
            # ancak POC (Proof of Concept) için bırakıyoruz.
            
            with open(STATS_FILE, "w") as f:
                json.dump(stats, f)
        except Exception as e:
            print(f"Stats save error: {e}")
        time.sleep(5)

def run_tcpdump():
    """Arka planda tcpdump çalıştırır ve çıktı satırlarını canlı olarak parse eder."""
    # -l: satır bazlı tamponlama (canlı akış için)
    # -nn: port ve IP çözümlemelerini iptal et (sayısal kalsın)
    # -i any: tüm ağ kartlarını dinle
    cmd = ["sudo", "tcpdump", "-l", "-i", "any", "-nn", "-q"]
    
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    
    # Regex kalıpları (Halisünasyon olmaması için kesin kurallar)
    # Örnek satır: 15:23:45.123 IP 192.168.1.10.51234 > 8.8.8.8.53: UDP, length 45
    ip_port_pattern = re.compile(r'IP ([\d\.]+)\.(\d+) > ([\d\.]+)\.(\d+)')
    dns_pattern = re.compile(r'A\? ([\w\.-]+)')
    dhcp_pattern = re.compile(r'BOOTP/DHCP, Reply')
    
    for line in iter(process.stdout.readline, ''):
        match = ip_port_pattern.search(line)
        if match:
            src_ip = match.group(1)
            src_port = match.group(2)
            dst_ip = match.group(3)
            dst_port = match.group(4)
            
            # --- 1. TOP TALKERS KONTROLÜ ---
            # IP adreslerinin veri miktarını sayıyoruz (Basit paket sayısı)
            stats["top_talkers"][src_ip] = stats["top_talkers"].get(src_ip, 0) + 1
            stats["top_talkers"][dst_ip] = stats["top_talkers"].get(dst_ip, 0) + 1
            
            # --- 2. PROTOKOL ANALİZİ KONTROLÜ ---
            # Gidilen portlara göre internetin ne amaçla kullanıldığını saptıyoruz
            if dst_port == '80' or src_port == '80':
                stats["protocols"]["HTTP (80)"] += 1
            elif dst_port == '443' or src_port == '443':
                stats["protocols"]["HTTPS (443)"] += 1
            elif dst_port == '53' or src_port == '53':
                stats["protocols"]["DNS (53)"] += 1
                # --- 3. DNS SNOOPING (Hangi Siteye Giriliyor?) KONTROLÜ ---
                dns_match = dns_pattern.search(line)
                if dns_match and dst_port == '53': # Sadece giden istekler
                    domain = dns_match.group(1).rstrip('.')
                    stats["dns_queries"].append({
                        "time": time.strftime("%H:%M:%S"),
                        "ip": src_ip,
                        "domain": domain
                    })
            elif dst_port == '22' or src_port == '22':
                stats["protocols"]["SSH (22)"] += 1
            elif dst_port == '67' or dst_port == '68':
                # --- 4. ROGUE DHCP TESPİTİ KONTROLÜ ---
                # Eğer cihaz ağa IP dağıtıyorsa (DHCP Reply) ve bu bizim Gateway değilse!
                if dhcp_pattern.search(line) and src_ip != KNOWN_GATEWAY:
                    if src_ip not in stats["rogue_dhcp"]:
                        stats["rogue_dhcp"].append(src_ip)
            else:
                stats["protocols"]["DİĞER"] += 1

if __name__ == "__main__":
    t_save = threading.Thread(target=save_stats_loop, daemon=True)
    t_save.start()
    run_tcpdump()
