#!/usr/bin/env python3
"""Generate the app icon for Video Merging Tool.

Design: a rounded blue "film" tile with two clip streams converging (merging)
into a single play button — i.e. several videos merged into one. Rendered at
high resolution then downsampled, so every size stays crisp and anti-aliased.

Outputs:
  build/icon.ico       multi-size Windows icon (used by electron-builder + EXE)
  build/icon.png       512px PNG (Linux / electron-builder)
  assets/icon.png      256px PNG shipped in the app (BrowserWindow window icon)

Run:  python build/gen_icon.py
"""
import os
from PIL import Image, ImageDraw

S = 1024  # master render size
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Palette (matches the app's accent blue / dark theme).
BLUE_LIGHT = (90, 155, 255)
BLUE_DEEP = (28, 70, 150)
DARK = (15, 18, 24)
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_tile(size, c1, c2):
    """A diagonal gradient square."""
    img = Image.new("RGB", (size, size), c1)
    px = img.load()
    maxd = (size - 1) * 2
    for y in range(size):
        for x in range(size):
            px[x, y] = lerp(c1, c2, (x + y) / maxd)
    return img


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def build_master():
    # Background: gradient clipped to a rounded square.
    bg = gradient_tile(S, BLUE_LIGHT, BLUE_DEEP)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), rounded_mask(S, int(S * 0.205)))

    d = ImageDraw.Draw(icon)

    # Film perforations along the top and bottom edges (subtle, for "video").
    hole_w, hole_h, r = int(S * 0.052), int(S * 0.045), int(S * 0.016)
    cols = 6
    gap = (S - cols * hole_w) / (cols + 1)
    hole = (255, 255, 255, 38)
    for i in range(cols):
        x = gap + i * (hole_w + gap)
        d.rounded_rectangle([x, S * 0.052, x + hole_w, S * 0.052 + hole_h], radius=r, fill=hole)
        d.rounded_rectangle([x, S * 0.903, x + hole_w, S * 0.903 + hole_h], radius=r, fill=hole)

    cx, cy = S * 0.50, S * 0.50

    # Two clip streams converging (the "merge"): thick rounded bars from the
    # top-left and bottom-left that meet at the play button. A soft shadow first.
    bar_w = int(S * 0.072)
    join = (S * 0.545, cy)
    starts = [(S * 0.250, S * 0.305), (S * 0.250, S * 0.695)]
    nodes = [(S * 0.515, S * 0.385), (S * 0.515, S * 0.615)]

    def stream(shadow=False):
        col = (0, 0, 0, 60) if shadow else WHITE
        off = S * 0.012 if shadow else 0
        for s, n in zip(starts, nodes):
            d.line([(s[0] + off, s[1] + off), (n[0] + off, n[1] + off),
                    (join[0] + off, join[1] + off)], fill=col, width=bar_w, joint="curve")
            # round the open end
            rr = bar_w / 2
            d.ellipse([s[0] + off - rr, s[1] + off - rr, s[0] + off + rr, s[1] + off + rr], fill=col)

    stream(shadow=True)
    stream(shadow=False)

    # Source nodes (two clips) as small filled circles at the stream starts.
    nr = int(S * 0.052)
    for s in starts:
        d.ellipse([s[0] - nr, s[1] - nr, s[0] + nr, s[1] + nr], fill=WHITE)
        d.ellipse([s[0] - nr * 0.45, s[1] - nr * 0.45, s[0] + nr * 0.45, s[1] + nr * 0.45], fill=BLUE_DEEP)

    # Play triangle (the merged video output) — shadow then white.
    tri = [(S * 0.500, S * 0.355), (S * 0.500, S * 0.645), (S * 0.760, S * 0.500)]
    sh = S * 0.012
    d.polygon([(x + sh, y + sh) for (x, y) in tri], fill=(0, 0, 0, 70))
    d.polygon(tri, fill=WHITE)

    return icon


def main():
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "assets"), exist_ok=True)
    master = build_master()

    ico_path = os.path.join(ROOT, "build", "icon.ico")
    master.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    master.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, "build", "icon.png"))
    master.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, "assets", "icon.png"))
    # A small preview strip to eyeball the small sizes.
    prev = Image.new("RGBA", (16 + 32 + 48 + 64 + 5 * 8, 64), (40, 44, 52, 255))
    x = 8
    for sz in (16, 32, 48, 64):
        prev.alpha_composite(master.resize((sz, sz), Image.LANCZOS), (x, (64 - sz) // 2))
        x += sz + 8
    prev.save(os.path.join(ROOT, "build", "icon_preview.png"))
    print("Wrote build/icon.ico, build/icon.png, assets/icon.png")


if __name__ == "__main__":
    main()
