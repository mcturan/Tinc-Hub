import re
import json
import socket
import ipaddress
from urllib.parse import urlparse
import requests
from bs4 import BeautifulSoup

URL_REGEX = re.compile(r'https?://[^\s<>"]+|www\.[^\s<>"]+')

def is_safe_url(url: str) -> bool:
    """SSRF Koruması: Localhost, private ve link-local IP'lere erişimi engeller."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            return False
        hostname = parsed.hostname
        if not hostname:
            return False
        if hostname.lower() in ('localhost', '127.0.0.1', '::1', '0.0.0.0'):
            return False
        # DNS çözümleme ve IP kontrolü
        addr_infos = socket.getaddrinfo(hostname, None)
        for addr_info in addr_infos:
            ip_str = addr_info[4][0]
            ip = ipaddress.ip_address(ip_str)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        return True
    except Exception:
        return False

def extract_first_url(text: str) -> str:
    """Metin içindeki ilk URL'yi yakalar."""
    if not text:
        return ""
    match = URL_REGEX.search(text)
    if match:
        url = match.group(0)
        if url.startswith("www."):
            url = "https://" + url
        return url
    return ""

def scrape_url_metadata(url: str) -> dict:
    """
    Verilen URL'den ürün başlığı, görseli, fiyatı ve site adını ayıklar.
    Hepsiburada, Trendyol, Amazon, n11 ve genel web sayfalarını destekler.
    """
    result = {
        "url": url,
        "title": "",
        "image_url": "",
        "price": "",
        "description": "",
        "site_name": ""
    }

    if not is_safe_url(url):
        result["title"] = "Geçersiz veya engellenmiş URL"
        return result

    try:
        domain = urlparse(url).netloc.lower()
        if "hepsiburada" in domain:
            result["site_name"] = "Hepsiburada"
        elif "trendyol" in domain:
            result["site_name"] = "Trendyol"
        elif "amazon" in domain:
            result["site_name"] = "Amazon"
        elif "n11" in domain:
            result["site_name"] = "n11"
        elif "migros" in domain:
            result["site_name"] = "Migros"
        elif "carrefoursa" in domain:
            result["site_name"] = "CarrefourSA"
        elif "getir" in domain:
            result["site_name"] = "Getir"
        else:
            clean_dom = domain.replace("www.", "").split(".")[0].capitalize()
            result["site_name"] = clean_dom

        headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        }

        resp = requests.get(url, headers=headers, timeout=7, allow_redirects=True)
        if resp.status_code != 200:
            result["title"] = url
            return result

        soup = BeautifulSoup(resp.text, "html.parser")

        # 1. Başlık
        og_title = soup.find("meta", property="og:title") or soup.find("meta", attrs={"name": "twitter:title"})
        if og_title and og_title.get("content"):
            result["title"] = og_title["content"].strip()
        elif soup.title and soup.title.string:
            result["title"] = soup.title.string.strip()

        # Başlıktan site ismini temizle (örn. "Logitech Mouse - Fiyatı | Trendyol")
        if result["title"]:
            for sep in [" - Trendyol", " | Trendyol", " - Hepsiburada", " | Hepsiburada", " : Amazon.com.tr", " - n11"]:
                if sep.lower() in result["title"].lower():
                    result["title"] = re.split(re.escape(sep), result["title"], flags=re.IGNORECASE)[0].strip()

        # 2. Görsel
        og_image = soup.find("meta", property="og:image") or soup.find("meta", attrs={"name": "twitter:image"})
        if og_image and og_image.get("content"):
            result["image_url"] = og_image["content"].strip()

        # 3. Açıklama
        og_desc = soup.find("meta", property="og:description") or soup.find("meta", attrs={"name": "description"})
        if og_desc and og_desc.get("content"):
            result["description"] = og_desc["content"].strip()[:200]

        # 4. Fiyat (JSON-LD veya Meta)
        # Önce meta product:price:amount
        price_meta = soup.find("meta", property="product:price:amount") or soup.find("meta", attrs={"name": "twitter:data1"})
        currency_meta = soup.find("meta", property="product:price:currency")
        if price_meta and price_meta.get("content"):
            val = price_meta["content"].strip()
            curr = currency_meta.get("content", "TL") if currency_meta else "TL"
            result["price"] = f"{val} {curr}"

        # JSON-LD kontrolü
        if not result["price"]:
            for script in soup.find_all("script", type="application/ld+json"):
                try:
                    if not script.string:
                        continue
                    data = json.loads(script.string)
                    items = data if isinstance(data, list) else [data]
                    for item in items:
                        offers = item.get("offers")
                        if offers:
                            if isinstance(offers, list) and offers:
                                offers = offers[0]
                            price = offers.get("price") or offers.get("lowPrice")
                            currency = offers.get("priceCurrency", "TL")
                            if price:
                                result["price"] = f"{price} {currency}"
                                break
                    if result["price"]:
                        break
                except Exception:
                    pass

        # Eğer başlık hala boşsa URL'i ver
        if not result["title"]:
            result["title"] = url

    except Exception as e:
        if not result["title"]:
            result["title"] = url

    return result
