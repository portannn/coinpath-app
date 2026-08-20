from PIL import Image, ImageDraw
import os, math

os.makedirs("/home/claude/app/icons", exist_ok=True)

BG_TOP = (26, 26, 25)
BG_BOT = (13, 13, 13)
BLUE = (57, 135, 229)
AQUA = (27, 175, 122)
WHITE = (255, 255, 255)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size, top, bot):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=c)
    return img


def draw_mark(img, cx, cy, scale):
    """A rising path ending in a coin — 'coinpath'."""
    d = ImageDraw.Draw(img, "RGBA")
    w = int(24 * scale)

    # rising polyline, leaving room at upper-right for the coin
    pts_n = [(-0.60, 0.46), (-0.22, 0.06), (0.06, 0.24), (0.40, -0.24)]
    pts = [(cx + x * scale * 100, cy + y * scale * 100) for x, y in pts_n]

    d.line(pts, fill=BLUE, width=w, joint="curve")
    for p in pts:  # round the joints and both ends
        d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=BLUE)

    # coin sitting at the end of the path
    px, py = pts[-1]
    r = int(27 * scale)
    d.ellipse([px - r, py - r, px + r, py + r], fill=AQUA)


def build(size, path, maskable=False):
    img = gradient(size, BG_TOP, BG_BOT)
    # content scale: maskable icons keep art inside the inner 80% safe zone
    content = size * (0.56 if maskable else 0.72)
    scale = content / 140.0
    draw_mark(img, size / 2, size / 2, scale)

    if maskable:
        # full-bleed square background (launcher applies its own mask)
        img.save(path)
    else:
        radius = int(size * 0.22)
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(img, (0, 0), rounded_mask(size, radius))
        out.save(path)


build(192, "/home/claude/app/icons/icon-192.png")
build(512, "/home/claude/app/icons/icon-512.png")
build(512, "/home/claude/app/icons/icon-maskable-512.png", maskable=True)

# apple touch icon (no transparency, iOS applies its own rounding)
img = gradient(180, BG_TOP, BG_BOT)
draw_mark(img, 90, 90, (180 * 0.72) / 140.0)
img.save("/home/claude/app/icons/apple-touch-icon.png")

# favicon
img = gradient(64, BG_TOP, BG_BOT)
draw_mark(img, 32, 32, (64 * 0.80) / 140.0)
img.save("/home/claude/app/icons/favicon.png")

print("icons written")
