"""Draws the app icon (cream tile, blue pulse line) at every macOS size."""
import json, os, sys
from PIL import Image, ImageDraw
out = sys.argv[1]
def draw(px):
    s = 1024
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    m = 100
    d.rounded_rectangle([m, m, s - m, s - m], radius=185, fill=(250, 246, 238, 255))
    pts = [(190, 560), (360, 560), (430, 380), (520, 700), (600, 470), (650, 560), (834, 560)]
    d.line(pts, fill=(74, 149, 224, 255), width=58, joint="curve")
    d.ellipse([800, 300, 880, 380], fill=(255, 112, 153, 255))
    return im.resize((px, px), Image.LANCZOS)
images = []
for base in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        px = base * scale
        name = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
        draw(px).save(os.path.join(out, name))
        images.append({"idiom": "mac", "size": f"{base}x{base}", "scale": f"{scale}x", "filename": name})
json.dump({"images": images, "info": {"version": 1, "author": "xcode"}}, open(os.path.join(out, "Contents.json"), "w"), indent=1)
