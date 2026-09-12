#!/usr/bin/env python3
"""
metrics_collector.py
--------------------
Tinc-Hub Tarihsel Metrik Toplayıcısı.

Nasıl çalışır:
- Her 5 dakikada bir ağdaki cihazları ping'ler ve yanıt süresini kaydeder.
- /proc/net/dev okunarak sunucunun toplam RX/TX verisi alınır.
- Tüm veriler METRICS_FILE'a saklanır (son 288 kayıt = 24 saat).
- Frontend Chart.js ile bu API'den veri çekip grafik çizer.
"""

import subprocess, json, os, time, threading, re

METRICS_FILE = "/opt/tinc-hub/shared/metrics.json"
TRAFFIC_FILE = "/opt/tinc-hub/shared/traffic_metrics.json"
MAX_POINTS = 288          # Her cihaz için saklanacak maksimum veri noktası (5dk x 288 = 24 saat)
INTERVAL_SEC = 300        # Ölçüm aralığı (saniye)

_last_iface_bytes: dict = {}    # Trafik delta hesabı için önceki değer


def ping_host(ip: str) -> float:
    """
    Tek bir ping gönderir, yanıt süresini ms cinsinden döndürür.
    Cihaz cevap vermezse -1 döner.
    Gerçek ICMP ping kullanır — mock değil.
    """
    try:
        r = subprocess.run(
            ["ping", "-c", "1", "-W", "1", ip],
            capture_output=True, text=True, timeout=3
        )
        match = re.search(r"time=([\d.]+)", r.stdout)
        if match:
            return float(match.group(1))
        return -1.0
    except Exception:
        return -1.0


def get_iface_bytes() -> dict:
    """
    /proc/net/dev'den anlık RX/TX bayt değerlerini okur.
    Gerçek çekirdek (kernel) verisini kullanır — simüle değil.
    """
    result = {}
    try:
        with open("/proc/net/dev") as f:
            for line in f.readlines()[2:]:
                parts = line.split(":")
                if len(parts) == 2:
                    iface = parts[0].strip()
                    stats = parts[1].split()
                    result[iface] = {"rx": int(stats[0]), "tx": int(stats[8])}
    except Exception:
        pass
    return result


def load_metrics() -> dict:
    if os.path.exists(METRICS_FILE):
        try:
            with open(METRICS_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_metrics(data: dict):
    os.makedirs(os.path.dirname(METRICS_FILE), exist_ok=True)
    with open(METRICS_FILE, "w") as f:
        json.dump(data, f)


def load_traffic() -> list:
    if os.path.exists(TRAFFIC_FILE):
        try:
            with open(TRAFFIC_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return []


def save_traffic(data: list):
    os.makedirs(os.path.dirname(TRAFFIC_FILE), exist_ok=True)
    with open(TRAFFIC_FILE, "w") as f:
        json.dump(data, f)


def collect_once(ips_to_monitor: list):
    """
    Bir ölçüm döngüsü: tüm IP'leri ping'le, trafik deltasını hesapla, kaydet.
    Bu fonksiyon her INTERVAL_SEC saniyede bir çağrılır.
    """
    global _last_iface_bytes
    now = time.strftime("%H:%M")
    timestamp = int(time.time())

    # ── 1. Ping Metrikleri ────────────────────────────────────────────────────
    metrics = load_metrics()

    for ip in ips_to_monitor:
        latency = ping_host(ip)

        if ip not in metrics:
            metrics[ip] = {"timestamps": [], "latency": []}

        metrics[ip]["timestamps"].append(now)
        metrics[ip]["latency"].append(latency)

        # Sadece son MAX_POINTS veri noktasını sakla
        if len(metrics[ip]["timestamps"]) > MAX_POINTS:
            metrics[ip]["timestamps"] = metrics[ip]["timestamps"][-MAX_POINTS:]
            metrics[ip]["latency"] = metrics[ip]["latency"][-MAX_POINTS:]

    save_metrics(metrics)

    # ── 2. Sunucu Trafik Metrikleri ───────────────────────────────────────────
    current_bytes = get_iface_bytes()
    traffic_log = load_traffic()

    entry = {"time": now, "timestamp": timestamp, "ifaces": {}}

    for iface, vals in current_bytes.items():
        if iface == "lo":   # Loopback'i atla
            continue

        prev = _last_iface_bytes.get(iface)
        if prev:
            delta_rx = max(0, vals["rx"] - prev["rx"])
            delta_tx = max(0, vals["tx"] - prev["tx"])
            # Mbps = (bayt_farkı * 8 bit) / (300 saniye * 1_000_000)
            rx_mbps = round(delta_rx * 8 / INTERVAL_SEC / 1_000_000, 3)
            tx_mbps = round(delta_tx * 8 / INTERVAL_SEC / 1_000_000, 3)
            entry["ifaces"][iface] = {"rx_mbps": rx_mbps, "tx_mbps": tx_mbps}

    _last_iface_bytes = current_bytes

    traffic_log.append(entry)
    if len(traffic_log) > MAX_POINTS:
        traffic_log = traffic_log[-MAX_POINTS:]
    save_traffic(traffic_log)


def _scheduler_loop(get_ips_func):
    """
    Arka plan thread döngüsü. get_ips_func() her ölçümden önce çağrılarak
    güncel IP listesini alır (haritaya yeni cihaz eklenirse bunu da izler).
    """
    while True:
        try:
            ips = get_ips_func()
            if ips:
                collect_once(ips)
        except Exception as e:
            print(f"[MetricsCollector] Hata: {e}")
        time.sleep(INTERVAL_SEC)


def start_metrics_collector(get_ips_func):
    """
    Metrik toplayıcıyı arka plan thread olarak başlatır.
    get_ips_func: Çağrıldığında izlenecek IP listesini döndüren fonksiyon.
    """
    t = threading.Thread(target=_scheduler_loop, args=(get_ips_func,), daemon=True)
    t.start()
