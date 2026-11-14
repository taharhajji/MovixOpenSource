"""Génère les images de l'appli Android TV à partir de l'icône de l'appli de bureau.

  app/src/main/res/mipmap-xxxhdpi/ic_launcher.png   192 x 192 (icône)
  app/src/main/res/drawable-xhdpi/banner.png        320 x 180 (bandeau de l'accueil Android TV)

Usage (Windows, Pillow installé) : python android-tv/scripts/make-images.py
Les deux PNG sont versionnés : à relancer seulement si l'icône change.
"""
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
ICON = os.path.join(ROOT, 'desktop', 'build', 'icon.png')
RES = os.path.join(HERE, '..', 'app', 'src', 'main', 'res')

BACKGROUND = (20, 21, 24)       # BRAND.BACKGROUND
ACCENT = (219, 230, 246)        # BRAND.ACCENT
ICON_SIZE = 192
BANNER_SIZE = (320, 180)
BANNER_ICON = 96
BANNER_FONT_SIZE = 34
FONT_CANDIDATES = [
    r'C:\Windows\Fonts\seguibl.ttf',   # Segoe UI Black
    r'C:\Windows\Fonts\segoeuib.ttf',  # Segoe UI Bold
    r'C:\Windows\Fonts\arialbd.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def main():
    icon = Image.open(ICON).convert('RGBA')

    launcher_dir = os.path.join(RES, 'mipmap-xxxhdpi')
    os.makedirs(launcher_dir, exist_ok=True)
    icon.resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS).save(os.path.join(launcher_dir, 'ic_launcher.png'))

    banner = Image.new('RGB', BANNER_SIZE, BACKGROUND)
    small = icon.resize((BANNER_ICON, BANNER_ICON), Image.LANCZOS)
    font = load_font(BANNER_FONT_SIZE)
    draw = ImageDraw.Draw(banner)
    text = 'MEWFLIX'
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    gap = 14
    total = BANNER_ICON + gap + (right - left)
    x = (BANNER_SIZE[0] - total) // 2
    banner.paste(small, (x, (BANNER_SIZE[1] - BANNER_ICON) // 2), small)
    draw.text((x + BANNER_ICON + gap - left, (BANNER_SIZE[1] - (bottom - top)) // 2 - top), text, font=font, fill=ACCENT)
    banner_dir = os.path.join(RES, 'drawable-xhdpi')
    os.makedirs(banner_dir, exist_ok=True)
    banner.save(os.path.join(banner_dir, 'banner.png'))
    print('icône et bandeau générés')


if __name__ == '__main__':
    main()
