#!/usr/bin/env python3
import os
import pystray
from PIL import Image, ImageDraw, ImageFont
import webbrowser
import threading

def create_image():
    # Koyu mavi/gri arka plana sahip "TH" yazan basit bir ikon
    width = 64
    height = 64
    color1 = (30, 41, 59)
    color2 = (226, 232, 240)
    
    image = Image.new('RGB', (width, height), color=color1)
    dc = ImageDraw.Draw(image)
    
    # Basit "TH" metni çizimi
    # Pillow font sorunu yaşamamak için manuel şekil veya default font
    try:
        # Default font ile
        dc.text((16, 24), "TH", fill=color2)
    except:
        pass
    
    return image

def on_open(icon, item):
    webbrowser.open("http://127.0.0.1:9010")

def on_exit(icon, item):
    icon.stop()

# İkon ve menü
icon = pystray.Icon(
    "Tinc Hub",
    create_image(),
    "Tinc Hub",
    menu=pystray.Menu(
        pystray.MenuItem("Tinc Hub'ı Aç", on_open, default=True),
        pystray.MenuItem("Çıkış", on_exit)
    )
)

icon.run()
