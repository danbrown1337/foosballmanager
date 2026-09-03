#!/usr/bin/env python3
"""Generates the extension's toolbar icons: a simple football mark on the
accent blue, at the three sizes Chrome asks for. Run from this directory.
"""
from PIL import Image, ImageDraw

BLUE = (29, 78, 216, 255)
WHITE = (255, 255, 255, 255)


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = round(size * 0.08)
    radius = round(size * 0.22)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=BLUE)

    # A simple football (pigskin) shape: an ellipse with laces, centered.
    cx, cy = size / 2, size / 2
    w, h = size * 0.58, size * 0.36
    d.ellipse([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], fill=WHITE)

    lw = max(1, round(size * 0.02))
    d.line([cx - w * 0.22, cy, cx + w * 0.22, cy], fill=BLUE, width=lw)
    for dx in (-0.11, 0, 0.11):
        x = cx + w * dx
        d.line([x, cy - h * 0.14, x, cy + h * 0.14], fill=BLUE, width=lw)

    return img


for size in (16, 48, 128):
    draw_icon(size).save(f"icon{size}.png")

print("wrote icon16.png icon48.png icon128.png")
