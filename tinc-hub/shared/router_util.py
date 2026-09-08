#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tinc Hub — Router & Modem Utility Module
Zyxel EX3501-T1 ve benzeri RSA + AES-256-CBC hibrit şifrelemeli modemleri destekler.
"""

import os
import json
import base64
import requests
import urllib3

from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


def _pad_pkcs7(data: bytes, block_size: int = 16) -> bytes:
    pad_len = block_size - (len(data) % block_size)
    return data + bytes([pad_len] * pad_len)


def _unpad_pkcs7(data: bytes) -> bytes:
    pad_len = data[-1]
    if pad_len < 1 or pad_len > 16:
        return data
    return data[:-pad_len]


def login_router(ip: str, username: str, password: str, timeout: int = 10) -> tuple[bool, str | None, str]:
    """
    Modeme RSA+AES ile bağlanır ve sessionkey alır.
    Döner: (başarılı_mı, sessionkey, mesaj)
    """
    base_url = f"http://{ip}"
    session = requests.Session()

    try:
        # 1. RSA Public Key
        r_rsa = session.get(f"{base_url}/getRSAPublickKey", timeout=timeout)
        if r_rsa.status_code != 200:
            return False, None, f"RSA anahtarı alınamadı (HTTP {r_rsa.status_code})"
        
        rsa_pem = r_rsa.json().get("RSAPublicKey")
        if not rsa_pem:
            return False, None, "Modem RSA açık anahtarı döndürmedi."
        rsa_pub = load_pem_public_key(rsa_pem.encode("utf-8"))

        # 2. AES anahtarı ve IV üretimi
        raw_aes_key = os.urandom(32)
        raw_iv_32 = os.urandom(32)
        actual_iv = raw_iv_32[:16]

        enc_aes_key = rsa_pub.encrypt(base64.b64encode(raw_aes_key), padding.PKCS1v15())
        b64_enc_key = base64.b64encode(enc_aes_key).decode("utf-8")
        b64_iv = base64.b64encode(raw_iv_32).decode("utf-8")

        # 3. Payload hazırla ve AES ile şifrele
        login_payload = {
            "Input_Account": username,
            "Input_Passwd": base64.b64encode(password.encode("utf-8")).decode("utf-8"),
            "currLang": "tr",
            "RememberPassword": 0,
            "SHA512_password": False
        }
        plaintext = json.dumps(login_payload, separators=(',', ':')).encode("utf-8")
        plaintext_padded = _pad_pkcs7(plaintext)

        cipher = Cipher(algorithms.AES(raw_aes_key), modes.CBC(actual_iv))
        encryptor = cipher.encryptor()
        ciphertext = encryptor.update(plaintext_padded) + encryptor.finalize()
        b64_content = base64.b64encode(ciphertext).decode("utf-8")

        # 4. POST /UserLogin
        body = {"content": b64_content, "key": b64_enc_key, "iv": b64_iv}
        headers = {
            "Content-Type": "application/json; charset=UTF-8",
            "Origin": base_url,
            "Referer": f"{base_url}/",
            "User-Agent": "Mozilla/5.0 (TincHub-RouterGuardian)"
        }
        resp = session.post(f"{base_url}/UserLogin", json=body, headers=headers, timeout=timeout)
        if resp.status_code == 401:
            try:
                res_err = resp.json()
                if res_err.get("result") == "Locked User":
                    rem = res_err.get("replyMsg", "")
                    return False, None, f"Modem kilitli! Güvenlik nedeniyle {rem} beklenmeli."
                return False, None, "Kullanıcı adı veya şifre hatalı."
            except Exception:
                return False, None, "Giriş reddedildi (401 Unauthorized)."
        elif resp.status_code != 200:
            return False, None, f"Giriş başarısız (HTTP {resp.status_code}): {resp.text[:100]}"

        # 5. Giriş yanıtını çöz
        resp_data = resp.json()
        if "content" not in resp_data or "iv" not in resp_data:
            return False, None, "Modemden beklenen formatta yanıt gelmedi."

        resp_iv = base64.b64decode(resp_data["iv"])[:16]
        resp_cipher = base64.b64decode(resp_data["content"])
        dec_cipher = Cipher(algorithms.AES(raw_aes_key), modes.CBC(resp_iv))
        decryptor = dec_cipher.decryptor()
        dec_padded = decryptor.update(resp_cipher) + decryptor.finalize()
        dec_text = _unpad_pkcs7(dec_padded).decode("utf-8")

        res_json = json.loads(dec_text)
        if res_json.get("result") != "ZCFG_SUCCESS":
            return False, None, f"Giriş sonucu başarısız: {res_json.get('result', 'Bilinmeyen hata')}"

        sessionkey = res_json.get("sessionkey")
        if not sessionkey:
            return False, None, "Oturum anahtarı (sessionkey) alınamadı."

        return True, sessionkey, "Giriş başarılı."

    except Exception as e:
        return False, None, f"Bağlantı hatası: {str(e)}"


def test_router_login(ip: str, username: str, password: str, timeout: int = 10) -> tuple[bool, str]:
    """Modeme bağlanıp giriş testi yapar ve oturumu güvenle kapatır."""
    ok, sessionkey, msg = login_router(ip, username, password, timeout=timeout)
    if not ok:
        return False, msg
    
    # Oturumu hemen kapat
    try:
        base_url = f"http://{ip}"
        headers = {
            "CSRFToken": sessionkey,
            "Referer": f"{base_url}/",
            "User-Agent": "Mozilla/5.0"
        }
        requests.post(f"{base_url}/cgi-bin/UserLogout?sessionkey={sessionkey}", headers=headers, timeout=5)
    except Exception:
        pass

    return True, "Modeme bağlantı ve kimlik doğrulama başarılı! (Zyxel EX3501-T1)"


def reboot_router(ip: str, username: str, password: str, timeout: int = 15) -> tuple[bool, str]:
    """Modeme bağlanır ve yeniden başlatma komutu gönderir."""
    ok, sessionkey, msg = login_router(ip, username, password, timeout=timeout)
    if not ok:
        return False, f"Reboot başarısız (Giriş yapılamadı): {msg}"

    base_url = f"http://{ip}"
    reboot_headers = {
        "CSRFToken": sessionkey,
        "Referer": f"{base_url}/",
        "User-Agent": "Mozilla/5.0"
    }
    reboot_url = f"{base_url}/cgi-bin/Reboot?sessionkey={sessionkey}"

    try:
        r = requests.post(reboot_url, headers=reboot_headers, timeout=timeout)
        if r.status_code == 200:
            return True, "Modem yeniden başlatma komutu başarıyla iletildi!"
        else:
            return False, f"Komut başarısız oldu (HTTP {r.status_code})"
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
        return True, "Modem yeniden başlatma komutu başarıyla iletildi (bağlantı kesildi, cihaz yeniden başlıyor)."
    except Exception as e:
        return False, f"Reboot hatası: {str(e)}"
