#!/usr/bin/env python3
"""
Render docs/assets/icon-180.png — the storefront tile.

Plugin marketplaces want a square GitHub-hosted raster icon (~96px drawn, so
180px for retina); SVG is refused. This keeps the PNG and the shipped icon.svg
in one visual language: a dashed "reference" frame, a solid "rebuild" frame, and
a copy arrow between them.

    python3 tools/make-icon.py --out docs/assets/icon-180.png
"""

from __future__ import annotations

import argparse
import os

from PIL import Image, ImageDraw

SIZE = 180
S = 4  # supersample


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="docs/assets/icon-180.png")
    args = parser.parse_args()

    width = SIZE * S
    canvas = Image.new("RGBA", (width, width), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)

    # rounded dark tile with a subtle vertical gradient
    tile = Image.new("RGBA", (width, width), (0, 0, 0, 0))
    td = ImageDraw.Draw(tile)
    for y in range(width):
        t = y / (width - 1)
        colour = (
            int(17 + (10 - 17) * t),
            int(26 + (16 - 26) * t),
            int(51 + (32 - 51) * t),
            255,
        )
        td.line([(0, y), (width, y)], fill=colour)
    mask = Image.new("L", (width, width), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, width - 1, width - 1], radius=int(width * 0.235), fill=255)
    canvas.paste(tile, (0, 0), mask)

    def box(values):
        return [v * S for v in values]

    # dashed reference frame
    d.rounded_rectangle(box((28, 44, 96, 96)), radius=13 * S, outline=(122, 162, 255, 150), width=5 * S)
    # redraw the dash pattern by hand: PIL has no dashes, so punch gaps
    for x in range(30, 96, 16):
        d.line([(x * S, 44 * S), (min(x + 8, 96) * S, 44 * S)], fill=(17, 26, 51, 255), width=5 * S)
    for y in range(46, 96, 16):
        d.line([(28 * S, y * S), (28 * S, min(y + 8, 96) * S)], fill=(17, 26, 51, 255), width=5 * S)

    # solid rebuild frame
    d.rounded_rectangle(box((74, 76, 150, 134)), radius=15 * S, fill=(10, 16, 32, 255), outline=(91, 124, 255, 255),
                        width=6 * S)
    # the rebuilt UI inside it
    d.rounded_rectangle(box((88, 90, 118, 96)), radius=3 * S, fill=(143, 176, 255, 255))
    d.rounded_rectangle(box((88, 104, 136, 108)), radius=2 * S, fill=(122, 162, 255, 140))
    d.rounded_rectangle(box((88, 116, 124, 120)), radius=2 * S, fill=(122, 162, 255, 96))

    # copy arrow
    d.line(box((60, 118)) + box((80, 118)), fill=(122, 162, 255, 190), width=5 * S)
    d.polygon([(86 * S, 118 * S), (74 * S, 110 * S), (74 * S, 126 * S)], fill=(122, 162, 255, 190))

    output = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    output.save(args.out, optimize=True)
    print(f"wrote {args.out} — {SIZE}x{SIZE}, {os.path.getsize(args.out) / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
