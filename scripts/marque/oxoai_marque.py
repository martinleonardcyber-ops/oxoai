"""Génère toutes les images de la marque OxoAI à partir d'un seul dessin.

L'icône : le dégradé de la famille Oxo (iris -> orchidée -> braise), un « O »
blanc et l'étincelle de l'IA posée sur son bord. Sorties :

  build/icon.png, build/icon.ico, build/icons/*.png   application (Mac, Windows, Linux)
  build/tray.png, build/tray@2x.png                   zone de notification
  src/assets/oxoai-mark.png, public/brand/oxoai-mark.png   marque seule (accueil)
  src/assets/oxoai-logo.png, public/brand/oxoai-logo.png   marque + nom (barre latérale)
  public/brand/app-icon-256.png                       favicon

Il faut Pillow, fontTools et brotli (la police est en woff2) :
  uv pip install pillow fonttools brotli && python scripts/marque/oxoai_marque.py
"""
import io
import math
import os

from fontTools.ttLib import TTFont
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ICI = os.path.dirname(os.path.abspath(__file__))
RACINE = os.path.normpath(os.path.join(ICI, "..", ".."))
IRIS = (139, 108, 255)
ORCHIDEE = (226, 102, 178)
BRAISE = (255, 122, 89)
ENCRE = (25, 23, 15)  # #19170F, le texte de l'application


def diagonale(taille, *arrets):
    """Dégradé du coin haut gauche au coin bas droit, par arrêts réguliers."""
    graine = Image.new("L", (2, 2))
    graine.putdata([0, 128, 128, 255])
    rampe = graine.resize(taille, Image.BILINEAR, box=(0.5, 0.5, 1.5, 1.5))
    sortie = Image.new("RGB", taille, arrets[0])
    n = len(arrets) - 1
    for i in range(1, n + 1):
        bas = 255 * (i - 1) / n
        bande = rampe.point(lambda v, bas=bas: max(0, min(255, round((v - bas) * n))))
        sortie = Image.composite(Image.new("RGB", taille, arrets[i]), sortie, bande)
    return sortie


def squircle(s, n=5.0):
    """Superellipse, proche de la forme des icônes Apple."""
    pts = []
    for i in range(720):
        a = 2 * math.pi * i / 720
        c, d = math.cos(a), math.sin(a)
        pts.append(((math.copysign(abs(c) ** (2 / n), c) + 1) * s / 2, (math.copysign(abs(d) ** (2 / n), d) + 1) * s / 2))
    m = Image.new("L", (s, s), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m


def etincelle(d, cx, cy, r, fill):
    """Étoile à quatre branches aux flancs creusés."""
    pts = []
    for i in range(64):
        a = 2 * math.pi * i / 64
        c, s = math.cos(a), math.sin(a)
        k = (abs(c) ** 0.5 + abs(s) ** 0.5) ** -2  # astroïde : creuse entre les branches
        pts.append((cx + r * c * k, cy + r * s * k))
    d.polygon(pts, fill=fill)


def glyphe(s):
    """Le masque blanc : un O et l'étincelle qui en déborde, détourée d'un liseré."""
    m = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(m)
    cx, cy, r, ep = s * 0.47, s * 0.53, s * 0.25, s * 0.095
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=255, width=round(ep))
    ex, ey, er = cx + r * 0.80, cy - r * 0.80, s * 0.17
    etoile = Image.new("L", (s, s), 0)
    etincelle(ImageDraw.Draw(etoile), ex, ey, er, 255)
    # Un liseré d'épaisseur constante autour de l'étincelle : elle se détache du O.
    marge = etoile.filter(ImageFilter.GaussianBlur(s * 0.022)).point(lambda v: 255 if v > 6 else 0)
    m = ImageChops.subtract(m, marge)
    m = ImageChops.lighter(m, etoile)
    return m


def tuile(s, lumiere=True):
    t = diagonale((s, s), IRIS, ORCHIDEE, BRAISE).convert("RGBA")
    if lumiere:
        l = Image.new("L", (s, s), 0)
        ImageDraw.Draw(l).ellipse((-s * 0.3, -s * 0.75, s * 1.3, s * 0.5), fill=38)
        t = Image.composite(Image.new("RGBA", (s, s), (255, 255, 255, 255)), t, l.filter(ImageFilter.GaussianBlur(s * 0.1)))
    g = glyphe(s)
    ombre = ImageChops.offset(g.filter(ImageFilter.GaussianBlur(s * 0.02)).point(lambda v: v * 0.35), 0, round(s * 0.012))
    t = Image.composite(Image.new("RGBA", (s, s), (60, 20, 60, 255)), t, ombre)
    return Image.composite(Image.new("RGBA", (s, s), (255, 255, 255, 255)), t, g)


def icone(taille=1024, corps=0.805, ombre=True):
    """Grille macOS : la forme fait ~824/1024, avec une ombre douce dessous."""
    S = taille * 2
    b = round(S * corps)
    dec = (S - b) // 2
    sortie = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    masque = squircle(b)
    if ombre:
        o = Image.new("L", (S, S), 0)
        o.paste(masque.point(lambda v: v * 0.45), (dec, dec + round(S * 0.012)))
        sortie.paste(Image.new("RGBA", (S, S), (0, 0, 0, 255)), (0, 0), o.filter(ImageFilter.GaussianBlur(S * 0.014)))
    sortie.paste(tuile(b), (dec, dec), masque)
    return sortie.resize((taille, taille), Image.LANCZOS)


def police(px):
    f = TTFont(os.path.join(ICI, "figtree.woff2"))
    f.flavor = None
    tampon = io.BytesIO()
    f.save(tampon)
    tampon.seek(0)
    p = ImageFont.truetype(tampon, px)
    try:
        p.set_variation_by_axes([700])
    except Exception:
        pass
    return p


def logo(l=2068, h=760):
    """La marque et le nom, sur fond transparent (la barre latérale le pose sur son fond)."""
    k = 2
    W, H = l * k, h * k
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cote = round(H * 0.62)
    im.alpha_composite(icone(cote, corps=0.96, ombre=False), (round(H * 0.19), (H - cote) // 2))
    d = ImageDraw.Draw(im)
    p = police(round(H * 0.42))
    d.text((round(H * 0.19) + cote + round(H * 0.17), H / 2), "OxoAI", font=p, fill=ENCRE + (255,), anchor="lm")
    return im.resize((l, h), Image.LANCZOS)


def ecrire(image, *chemins):
    for c in chemins:
        chemin = os.path.join(RACINE, c)
        os.makedirs(os.path.dirname(chemin), exist_ok=True)
        image.save(chemin)


def main():
    ecrire(icone(1024), "build/icon.png")
    serre = icone(512, corps=0.94, ombre=False)
    for t in (16, 24, 32, 48, 64, 128, 256, 512):
        ecrire(serre.resize((t, t), Image.LANCZOS), f"build/icons/{t}x{t}.png")
    tailles = [16, 24, 32, 48, 64, 128, 256]
    images = [serre.resize((t, t), Image.LANCZOS) for t in tailles]
    images[-1].save(os.path.join(RACINE, "build/icon.ico"), format="ICO", sizes=[(t, t) for t in tailles], append_images=images[:-1])
    ecrire(serre.resize((16, 16), Image.LANCZOS), "build/tray.png")
    ecrire(serre.resize((32, 32), Image.LANCZOS), "build/tray@2x.png")
    ecrire(icone(1254, corps=0.94, ombre=False), "src/assets/oxoai-mark.png", "public/brand/oxoai-mark.png")
    ecrire(logo(), "src/assets/oxoai-logo.png", "public/brand/oxoai-logo.png")
    ecrire(serre.resize((256, 256), Image.LANCZOS), "public/brand/app-icon-256.png")
    print("marque OxoAI écrite")


if __name__ == "__main__":
    main()
