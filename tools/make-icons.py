#!/usr/bin/env python3
"""Draws the Strict Shield icon (red shield, white bar) at every size Chrome needs.

    python3 tools/make-icons.py
Needs Pillow (pip install pillow).
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
BIG = 1024


def shield(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size / 100.0
    # Shield outline: flat top with rounded corners, sides curving to a point.
    pts = []
    import math
    top, left, right, bottom = 8 * s, 14 * s, 86 * s, 94 * s
    r = 10 * s
    # top-left corner arc
    for a in range(180, 271, 5):
        pts.append((left + r + r * math.cos(math.radians(a)), top + r + r * math.sin(math.radians(a))))
    for a in range(270, 361, 5):
        pts.append((right - r + r * math.cos(math.radians(a)), top + r + r * math.sin(math.radians(a))))
    # right side down to the point (quadratic curve)
    def quad(p0, p1, p2, n=30):
        return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
                 (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1])
                for t in (i / n for i in range(1, n + 1))]
    pts += quad((right, top + r), (right, 70 * s), (50 * s, bottom))
    pts += quad((50 * s, bottom), (left, 70 * s), (left, top + r))
    d.polygon(pts, fill=(198, 40, 40, 255))
    # Inner highlight on the left half for depth.
    inner = [(x, y) for (x, y) in pts if x <= 50 * s]
    hl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(hl).polygon(inner + [(50 * s, top)], fill=(255, 255, 255, 28))
    img = Image.alpha_composite(img, hl)
    d = ImageDraw.Draw(img)
    # White "no entry" bar.
    d.rounded_rectangle((28 * s, 41 * s, 72 * s, 55 * s), radius=4 * s, fill=(255, 255, 255, 255))
    return img


big = shield(BIG)
OUT.mkdir(parents=True, exist_ok=True)
for n in (16, 32, 48, 128):
    big.resize((n, n), Image.LANCZOS).save(OUT / f"icon{n}.png")
# Store listing assets
big.resize((128, 128), Image.LANCZOS).save(OUT.parent.parent / "store" / "store-icon-128.png") if (OUT.parent.parent / "store").exists() else None
print("icons written to", OUT)
