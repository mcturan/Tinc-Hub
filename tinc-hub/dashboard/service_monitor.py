#!/usr/bin/env python3
"""
service_monitor.py
------------------
Tinc-Hub Servis İzleme Modülü.

Bu modül belirtilen IP adresindeki HTTP ve TCP servislerinin
gerçek bağlantı testlerini yapar. Mock veri döndürmez —
her test gerçek bir ağ bağlantısı kurmaya çalışır.
"""

import socket
import time
import requests as _requests  # HTTP GET istekleri için

# HTTP isteği sırasında çekilecek standart başlıklar
DEFAULT_HEADERS = {
    'User-Agent': 'Tinc-Hub/1.0 ServiceMonitor',
}


# ──────────────────────────────────────────────────────────────────────────────
# HTTP Kontrolü
# ──────────────────────────────────────────────────────────────────────────────

def check_http(ip: str, port: int = 80, path: str = '/', timeout: int = 5) -> dict:
    """
    Belirtilen IP, port ve path'e gerçek bir HTTP GET isteği gönderir.

    Parametreler:
        ip      : Hedef IP adresi (örn. '192.168.1.1')
        port    : HTTP portu (varsayılan 80; HTTPS için 443 kullanılabilir)
        path    : İstek yapılacak path (varsayılan '/')
        timeout : Bağlantı zaman aşımı süresi (saniye, varsayılan 5)

    Döner:
        {
            'success'    : bool   — HTTP 2xx/3xx aldıysa True
            'status_code': int    — HTTP durum kodu (bağlantı hatasında None)
            'latency_ms' : float  — Yanıt süresi milisaniye cinsinden
            'error'      : str    — Hata varsa mesaj, yoksa None
        }
    """
    # Protokolü port numarasına göre otomatik belirle
    scheme = 'https' if port == 443 else 'http'
    url = f'{scheme}://{ip}:{port}{path}'

    start = time.time()  # Gecikme ölçümü başlat
    try:
        resp = _requests.get(
            url,
            timeout=timeout,
            headers=DEFAULT_HEADERS,
            allow_redirects=True,
            verify=False  # Öz-imzalı sertifikalara izin ver (NOC ortamı)
        )
        latency_ms = (time.time() - start) * 1000  # ms cinsine çevir
        return {
            'success': resp.ok,
            'status_code': resp.status_code,
            'latency_ms': round(latency_ms, 2),
            'error': None
        }
    except _requests.exceptions.ConnectionError as e:
        # Hedef porta bağlantı kurulamadı
        latency_ms = (time.time() - start) * 1000
        return {
            'success': False,
            'status_code': None,
            'latency_ms': round(latency_ms, 2),
            'error': f'Bağlantı hatası: {e}'
        }
    except _requests.exceptions.Timeout:
        # Zaman aşımı
        return {
            'success': False,
            'status_code': None,
            'latency_ms': timeout * 1000,
            'error': f'Zaman aşımı ({timeout}s)'
        }
    except Exception as e:
        latency_ms = (time.time() - start) * 1000
        return {
            'success': False,
            'status_code': None,
            'latency_ms': round(latency_ms, 2),
            'error': str(e)
        }


# ──────────────────────────────────────────────────────────────────────────────
# TCP Bağlantı Kontrolü
# ──────────────────────────────────────────────────────────────────────────────

def check_tcp(ip: str, port: int, timeout: int = 3) -> dict:
    """
    Belirtilen IP:port'a gerçek bir TCP bağlantısı kurmaya çalışır.
    socket.connect_ex kullanır — exception fırlatmaz, hata kodu döner.

    Parametreler:
        ip      : Hedef IP adresi
        port    : Hedef TCP portu (örn. 22, 3306, 5432)
        timeout : Bağlantı zaman aşımı süresi (saniye, varsayılan 3)

    Döner:
        {
            'success'   : bool  — Port açıksa True
            'latency_ms': float — Bağlantı süresi milisaniye cinsinden
            'error'     : str   — Hata varsa mesaj, yoksa None
        }
    """
    start = time.time()  # Gecikme ölçümü başlat
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)  # Zaman aşımı ayarla
    try:
        result = sock.connect_ex((ip, port))  # 0 → başarılı, diğerleri → hata
        latency_ms = (time.time() - start) * 1000
        if result == 0:
            # Port açık, bağlantı kuruldu
            return {
                'success': True,
                'latency_ms': round(latency_ms, 2),
                'error': None
            }
        else:
            # Port kapalı veya bağlantı reddedildi
            return {
                'success': False,
                'latency_ms': round(latency_ms, 2),
                'error': f'Port kapalı veya erişim reddedildi (errno={result})'
            }
    except socket.timeout:
        latency_ms = (time.time() - start) * 1000
        return {
            'success': False,
            'latency_ms': round(latency_ms, 2),
            'error': f'TCP zaman aşımı ({timeout}s)'
        }
    except Exception as e:
        latency_ms = (time.time() - start) * 1000
        return {
            'success': False,
            'latency_ms': round(latency_ms, 2),
            'error': str(e)
        }
    finally:
        sock.close()  # Soketi her durumda kapat (kaynak sızıntısını önle)


# ──────────────────────────────────────────────────────────────────────────────
# Toplu Servis Kontrolü
# ──────────────────────────────────────────────────────────────────────────────

def check_services(ip: str, services_list: list) -> list:
    """
    Verilen IP için birden fazla servis kontrolü yapar.

    Parametreler:
        ip            : Hedef IP adresi
        services_list : Kontrol edilecek servislerin listesi. Her eleman:
                        {'type': 'http', 'port': 80, 'path': '/'}  veya
                        {'type': 'tcp',  'port': 22}

    Döner:
        Her servis için sonuç içeren dict listesi:
        [
            {
                'type'       : 'http' | 'tcp',
                'port'       : int,
                'success'    : bool,
                'latency_ms' : float,
                'status_code': int | None,   # Sadece HTTP için
                'error'      : str | None
            },
            ...
        ]

    Örnek kullanım:
        results = check_services('192.168.1.1', [
            {'type': 'http', 'port': 80, 'path': '/admin'},
            {'type': 'tcp',  'port': 22},
        ])
    """
    results = []

    for svc in services_list:
        svc_type = svc.get('type', 'tcp').lower()
        port = int(svc.get('port', 80))

        if svc_type == 'http':
            # HTTP servisi kontrolü
            path = svc.get('path', '/')
            timeout = int(svc.get('timeout', 5))
            result = check_http(ip, port=port, path=path, timeout=timeout)
            result['type'] = 'http'
            result['port'] = port
        elif svc_type == 'tcp':
            # TCP servisi kontrolü
            timeout = int(svc.get('timeout', 3))
            result = check_tcp(ip, port=port, timeout=timeout)
            result['type'] = 'tcp'
            result['port'] = port
            result['status_code'] = None  # TCP'de HTTP durum kodu olmaz
        else:
            # Bilinmeyen servis türü — hata döndür
            result = {
                'type': svc_type,
                'port': port,
                'success': False,
                'latency_ms': 0.0,
                'status_code': None,
                'error': f'Bilinmeyen servis türü: {svc_type}'
            }

        result['name'] = svc.get('name', f"{result.get('type', 'tcp').upper()} ({port})")
        results.append(result)

    return results
