#!/usr/bin/env python3
"""
Render docs/assets/hero.png — the README banner.

Kept as a script so the banner can be regenerated (palette or copy change)
instead of hand-edited in an image editor.

    python3 tools/make-hero.py --out docs/assets/hero.png
"""

from __future__ import annotations

import argparse
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1280, 420
S = 2  # supersample for smooth shapes

BRAND = (91, 124, 255)
BRAND_LIGHT = (143, 176, 255)
LABEL = (243, 247, 255)
LABEL2 = (139, 155, 180)
LABEL3 = (110, 128, 154)
CARD = (22, 32, 47)
CARD_HI = (24, 36, 57)
BORDER = (42, 58, 82)
OK = (34, 197, 94)
WARN = (245, 158, 11)


def font(size, bold=False):
    for path in [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        try:
            return ImageFont.truetype(path, int(size * S))
        except Exception:
            continue
    return ImageFont.load_default()


F_BRAND = font(58, True)
F_TAG = font(22)
F_BODY = font(14)
F_CHIP = font(12)
F_LANE = font(10)
F_TINY = font(8, True)


def box(values):
    return [int(round(v * S)) for v in values]


def gradient():
    base = Image.new("RGB", (1, H * S))
    top, bottom = (9, 12, 20), (16, 25, 42)
    for y in range(H * S):
        t = y / max(1, H * S - 1)
        base.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return base.resize((W * S, H * S))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="docs/assets/hero.png")
    args = parser.parse_args()

    canvas = gradient().convert("RGBA")

    # dot texture
    dots = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    for y in range(26, H * S, 24 * S):
        for x in range(26, W * S, 24 * S):
            dd.ellipse([x, y, x + 1.6 * S, y + 1.6 * S], fill=(122, 162, 255, 20))
    canvas.alpha_composite(dots)

    # brand glow behind the flow
    glow = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(box((760, 40, 1330, 460)), fill=(*BRAND, 62))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(70 * S)))

    d = ImageDraw.Draw(canvas)

    # ── identity ──────────────────────────────────────────────────────────
    d.rounded_rectangle(box((72, 74, 106, 108)), radius=9 * S, fill=(*BRAND, 255))
    for offset, width in ((10, 12), (16, 16), (22, 9)):
        d.line([(84 * S, (74 + offset) * S), ((84 + width) * S, (74 + offset) * S)],
               fill=(9, 12, 20), width=int(2.4 * S))

    d.text((72 * S, 138 * S), "dsh-clone", font=F_BRAND, fill=LABEL)
    d.text((72 * S, 214 * S), "Screenshot in. Working UI out.", font=F_TAG, fill=BRAND_LIGHT)
    d.text((72 * S, 256 * S), "Several agents rebuild the same reference in parallel —", font=F_BODY, fill=LABEL2)
    d.text((72 * S, 278 * S), "you adopt the live page that looks right.", font=F_BODY, fill=LABEL2)

    chips = ["1–4 agents", "git worktrees", "one-click adopt", "sandboxed previews"]
    x = 72
    for text in chips:
        width = d.textlength(text, font=F_CHIP) / S + 26
        d.rounded_rectangle(box((x, 320, x + width, 348)), radius=14 * S, fill=(22, 32, 47), outline=BORDER)
        d.text(((x + 13) * S, 328 * S), text, font=F_CHIP, fill=(169, 188, 214))
        x += width + 10

    # ── the flow ──────────────────────────────────────────────────────────
    # reference frame
    d.rounded_rectangle(box((676, 150, 802, 262)), radius=12 * S, fill=CARD, outline=(42, 58, 82))
    d.rounded_rectangle(box((690, 164, 736, 170)), radius=3 * S, fill=(*BRAND_LIGHT, 165))
    for offset, width in ((178, 100), (188, 82), (198, 92)):
        d.rounded_rectangle(box((690, offset, 690 + width, offset + 4)), radius=2 * S, fill=(*BRAND_LIGHT, 70))
    for index, width in enumerate((34, 34, 18)):
        d.rounded_rectangle(box((690 + index * 42, 214, 690 + index * 42 + width, 248)), radius=7 * S,
                            fill=(*BRAND_LIGHT, 44 if index < 2 else 60))

    # fan-out
    for target_y in (118, 206, 294):
        d.line([(806 * S, 206 * S), (856 * S, 206 * S), (908 * S, target_y * S)],
               fill=(*BRAND_LIGHT, 120), width=int(1.6 * S))
        d.ellipse([(852 * S), (204 * S), (858 * S), (210 * S)], fill=(*BRAND_LIGHT, 160))

    lanes = [
        ("measure", OK, "ready", False),
        ("structure", OK, "ready", True),
        ("visual", WARN, "no page", False),
    ]
    for index, (name, dot, state, winner) in enumerate(lanes):
        y0 = 82 + index * 88
        d.rounded_rectangle(box((912, y0, 1030, y0 + 72)), radius=11 * S,
                            fill=CARD_HI if winner else CARD,
                            outline=BRAND if winner else BORDER, width=int((1.6 if winner else 1) * S))
        d.text((924 * S, (y0 + 10) * S), f"lane {index + 1}", font=font(10, True), fill=LABEL)
        d.text((924 * S, (y0 + 24) * S), name, font=F_LANE, fill=LABEL2)
        d.ellipse(box((924, y0 + 44, 931, y0 + 51)), fill=(*dot, 255))
        d.text((937 * S, (y0 + 42) * S), state, font=F_LANE, fill=LABEL3)
        if winner:
            d.rounded_rectangle(box((978, y0 + 10, 1018, y0 + 26)), radius=8 * S, fill=(*BRAND, 255))
            d.text((985 * S, (y0 + 13.5) * S), "PICK", font=font(8, True), fill=(255, 255, 255))

    # arrow + adopted folder
    d.line([(1040 * S, 206 * S), (1076 * S, 206 * S)], fill=(*BRAND, 255), width=int(2.2 * S))
    d.polygon([(1086 * S, 206 * S), (1074 * S, 199 * S), (1074 * S, 213 * S)], fill=(*BRAND, 255))
    d.rounded_rectangle(box((1096, 168, 1210, 244)), radius=12 * S, fill=(16, 26, 43), outline=(49, 69, 106))
    d.line([(1108 * S, 182 * S), (1124 * S, 182 * S), (1129 * S, 188 * S), (1162 * S, 188 * S)],
           fill=(*BRAND_LIGHT, 255), width=int(1.8 * S))
    d.rounded_rectangle(box((1108, 194, 1164, 214)), radius=6 * S, fill=(*BRAND, 44),
                        outline=(*BRAND_LIGHT, 130))
    d.text((1114 * S, 198 * S), "index.html", font=font(8), fill=BRAND_LIGHT)
    label = "clone-a91c-lane-2"
    d.text((1108 * S, 222 * S), label, font=font(8), fill=LABEL3)

    output = canvas.convert("RGB").resize((W, H), Image.LANCZOS)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    output.save(args.out, optimize=True)
    print(f"wrote {args.out} — {W}x{H}, {os.path.getsize(args.out) / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
