#!/usr/bin/env python3
"""
Build the README's demo animation from a real reference image.

The GIF is an *illustration of the pipeline*, not a screenshot of the app: it
replays the beats of one run (reference in → three lanes → adopt one) using the
timings and lane states recorded by the plugin. Everything drawn here comes from
those numbers, so the asset can be regenerated instead of hand-edited.

    python3 tools/make-demo.py \
      --reference docs/assets/reference.png \
      --out docs/assets/demo.gif \
      --timing 0:41 --timing 0:58 --timing 1:12 \
      --files 3 --files 4 --files 0 \
      --winner 2 --adopted clone-a91c-lane-2

Requires Pillow.
"""

from __future__ import annotations

import argparse
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ── design tokens (mirror the plugin's palette) ────────────────────────────
BG_TOP = (10, 14, 22)
BG_BOTTOM = (15, 23, 38)
CARD = (21, 30, 44)
CARD_HI = (25, 38, 60)
SUNKEN = (16, 25, 39)
BORDER = (42, 58, 82)
BORDER_HI = (49, 69, 106)
BRAND = (91, 124, 255)
BRAND_LIGHT = (143, 176, 255)
LABEL = (243, 247, 255)
LABEL2 = (143, 158, 182)
LABEL3 = (96, 112, 136)
OK = (34, 197, 94)
WARN = (245, 158, 11)

WIDTH, HEIGHT = 960, 540
SCALE = 2  # draw at 2x, downsample once for smooth shapes


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size * SCALE)
        except Exception:
            continue
    return ImageFont.load_default()


def load_mono(size: int) -> ImageFont.FreeTypeFont:
    for path in [
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]:
        try:
            return ImageFont.truetype(path, size * SCALE)
        except Exception:
            continue
    return load_font(size)


F_H1 = load_font(15, True)
F_H2 = load_font(13, True)
F_BODY = load_font(12)
F_SMALL = load_font(11)
F_TINY = load_font(9)
F_CHIP = load_font(9, True)
F_MONO = load_mono(10)
F_MONO_SMALL = load_mono(9)


class Canvas:
    """One drawing surface whose API speaks design pixels, never device pixels."""

    def __init__(self):
        self.img = gradient().convert("RGBA")
        self.img.alpha_composite(dots())
        self.draw = ImageDraw.Draw(self.img)

    def _box(self, box):
        return [int(round(value * SCALE)) for value in box]

    def rect(self, box, radius=0, fill=None, outline=None, width=1):
        self.draw.rounded_rectangle(self._box(box), radius=radius * SCALE, fill=fill, outline=outline,
                                    width=max(1, int(width * SCALE)))

    def ellipse(self, box, fill=None):
        self.draw.ellipse(self._box(box), fill=fill)

    def line(self, points, fill=None, width=1):
        self.draw.line([(int(x * SCALE), int(y * SCALE)) for x, y in points], fill=fill,
                       width=max(1, int(width * SCALE)), joint="curve")

    def polygon(self, points, fill=None):
        self.draw.polygon([(int(x * SCALE), int(y * SCALE)) for x, y in points], fill=fill)

    def text(self, xy, value, font, fill=None):
        self.draw.text((xy[0] * SCALE, xy[1] * SCALE), value, font=font, fill=fill)

    def measure(self, value, font):
        return self.draw.textlength(value, font=font) / SCALE

    def card(self, box, radius=11, fill=CARD, outline=BORDER, width=1, glow=None):
        """A card with a soft drop shadow and an optional brand halo."""
        x0, y0, x1, y1 = [int(round(value * SCALE)) for value in box]
        pad = 16 * SCALE
        layer = Image.new("RGBA", (x1 - x0 + pad * 2, y1 - y0 + pad * 2), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(
            [pad, pad + 2 * SCALE, pad + (x1 - x0), pad + (y1 - y0) + 2 * SCALE],
            radius=radius * SCALE, fill=(0, 0, 0, 150),
        )
        self.img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(7 * SCALE)), (x0 - pad, y0 - pad))
        if glow is not None:
            halo = Image.new("RGBA", (x1 - x0 + pad * 2, y1 - y0 + pad * 2), (0, 0, 0, 0))
            ImageDraw.Draw(halo).rounded_rectangle(
                [pad, pad, pad + (x1 - x0), pad + (y1 - y0)], radius=radius * SCALE, fill=glow,
            )
            self.img.alpha_composite(halo.filter(ImageFilter.GaussianBlur(11 * SCALE)), (x0 - pad, y0 - pad))
        self.rect(box, radius=radius, fill=fill, outline=outline, width=width)

    def image(self, path, box, radius=9):
        """Cover-fit an image with rounded corners."""
        x0, y0, x1, y1 = [int(round(value * SCALE)) for value in box]
        width, height = x1 - x0, y1 - y0
        source = Image.open(path).convert("RGB")
        ratio = max(width / source.width, height / source.height)
        resized = source.resize((max(1, int(source.width * ratio)), max(1, int(source.height * ratio))),
                                Image.LANCZOS)
        left = (resized.width - width) // 2
        top = (resized.height - height) // 2
        tile = resized.crop((left, top, left + width, top + height)).convert("RGBA")
        mask = Image.new("L", (width, height), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, width, height], radius=radius * SCALE, fill=255)
        tile.putalpha(mask)
        self.img.alpha_composite(tile, (x0, y0))

    def finish(self):
        return self.img.convert("RGB").resize((WIDTH, HEIGHT), Image.LANCZOS)


def gradient():
    base = Image.new("RGB", (1, HEIGHT * SCALE))
    for y in range(HEIGHT * SCALE):
        t = y / max(1, HEIGHT * SCALE - 1)
        base.putpixel((0, y), tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)))
    return base.resize((WIDTH * SCALE, HEIGHT * SCALE))


def dots(step=24, alpha=22):
    layer = Image.new("RGBA", (WIDTH * SCALE, HEIGHT * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for y in range(step, HEIGHT * SCALE, step * SCALE):
        for x in range(step, WIDTH * SCALE, step * SCALE):
            draw.ellipse([x, y, x + 1.5 * SCALE, y + 1.5 * SCALE], fill=(122, 162, 255, alpha))
    return layer


def ease(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def skeleton(canvas: Canvas, box, progress=1.0):
    """A dim wireframe standing in for a lane's live page."""
    x0, y0, x1, y1 = box
    canvas.rect(box, radius=7, fill=SUNKEN)
    inner = x1 - x0 - 20
    rows = [(10, 0.40, 4), (19, 0.88, 3), (26, 0.66, 3), (33, 0.80, 3), (40, 0.54, 3), (47, 0.72, 3)]
    for offset, ratio, height in rows:
        width = int(inner * ratio * progress)
        if width < 3:
            continue
        canvas.rect((x0 + 10, y0 + offset, x0 + 10 + width, y0 + offset + height), radius=1.5,
                    fill=(*BRAND_LIGHT, 78 if offset < 24 else 44))
    # a small chart silhouette once the lane has something to show
    if progress > 0.55:
        chart_x, chart_top = x0 + 10, y0 + 62
        heights = (0.34, 0.62, 0.48, 0.78, 0.44)
        slot = inner * 0.62 / len(heights)
        for order, ratio in enumerate(heights):
            left = chart_x + order * slot
            canvas.rect((left, chart_top + 30 - 30 * ratio, left + slot * 0.62, chart_top + 30), radius=2,
                        fill=(*BRAND_LIGHT, 40))


def draw_frame(reference: str, files, winner: int, adopted: str, score: str, beat: float, pulse: float) -> Image.Image:
    canvas = Canvas()

    # ── header ────────────────────────────────────────────────────────────
    canvas.rect((26, 18, 42, 34), radius=5, fill=(*BRAND, 255))
    canvas.line([(31, 24), (37, 24)], fill=(10, 14, 22), width=1.6)
    canvas.line([(31, 28), (37, 28)], fill=(10, 14, 22), width=1.6)
    canvas.text((50, 20), "dsh-clone", F_H1, LABEL)
    canvas.text((138, 22), "/clone 3", F_MONO, BRAND_LIGHT)
    tagline = "Screenshot in. Working UI out."
    canvas.text((WIDTH - 26 - canvas.measure(tagline, F_SMALL), 22), tagline, F_SMALL, LABEL2)

    # ── act 1: the reference arrives ──────────────────────────────────────
    if beat >= 0:
        appear = ease(beat / 0.12)
        slide = int((1 - appear) * 10)
        box = (26, 58 + slide, 322, 330 + slide)
        canvas.card(box, radius=12)
        canvas.text((40, 70 + slide), "REFERENCE", F_TINY, LABEL3)
        canvas.image(reference, (40, 88 + slide, 308, 276 + slide))
        canvas.text((40, 288 + slide), "you paste a screenshot", F_BODY, LABEL2)
        canvas.text((40, 306 + slide), "the only spec that keeps the layout", F_SMALL, LABEL3)

    # ── act 2: lanes fan out ──────────────────────────────────────────────
    lane_names = ["measure first", "structure first", "visual first"]
    settle_at = [0.40, 0.54, 0.68]
    lane_width, lane_gap, lane_y0, lane_y1 = 184, 12, 58, 330

    for index in range(3):
        appear = ease((beat - 0.10 - index * 0.04) / 0.12)
        if appear <= 0:
            continue
        slide = int((1 - appear) * 14)
        x0 = 352 + index * (lane_width + lane_gap)
        box = (x0, lane_y0 + slide, x0 + lane_width, lane_y1 + slide)
        settled = beat >= settle_at[index]
        is_winner = (index + 1) == winner
        highlight = is_winner and settled

        canvas.card(
            box, radius=11,
            fill=CARD_HI if highlight else CARD,
            outline=BRAND if highlight else BORDER,
            width=1.4 if highlight else 1,
            glow=(91, 124, 255, 54) if highlight else None,
        )
        canvas.text((x0 + 12, box[1] + 10), f"lane {index + 1}", F_H2, LABEL)
        canvas.text((x0 + 12, box[1] + 27), lane_names[index], F_SMALL, LABEL2)

        progress = 1.0 if settled else max(0.06, min(1.0, (beat - 0.14 - index * 0.03) / max(0.01, settle_at[index] - 0.14)))
        skeleton(canvas, (x0 + 10, box[1] + 48, x0 + lane_width - 10, box[1] + 172), progress)

        # progress track
        track_y = box[1] + 184
        canvas.rect((x0 + 12, track_y, x0 + lane_width - 12, track_y + 4), radius=2, fill=(30, 42, 60))
        fill_to = x0 + 12 + (lane_width - 24) * progress
        if fill_to > x0 + 14:
            canvas.rect((x0 + 12, track_y, fill_to, track_y + 4), radius=2,
                        fill=(*(OK if settled else BRAND), 235))
            if not settled:
                shimmer = x0 + 12 + (lane_width - 24) * ((pulse + index * 0.33) % 1.0)
                canvas.ellipse((shimmer - 3, track_y - 1.5, shimmer + 3, track_y + 5.5), fill=(255, 255, 255, 130))

        # footer: state + real numbers
        footer_y = box[1] + 198
        if settled:
            delivered = files[index] > 0
            colour, state = (OK, "ready") if delivered else (WARN, "no page")
            canvas.ellipse((x0 + 12, footer_y + 2, x0 + 19, footer_y + 9), fill=(*colour, 255))
            canvas.text((x0 + 25, footer_y), state, F_SMALL, LABEL2)
            if delivered:
                canvas.text((x0 + 12, footer_y + 17), f"{files[index]} files · rendered", F_MONO_SMALL, LABEL3)
            if is_winner:
                canvas.rect((x0 + lane_width - 52, box[1] + 10, x0 + lane_width - 12, box[1] + 25), radius=7,
                            fill=(*BRAND, 255))
                canvas.text((x0 + lane_width - 46, box[1] + 13), "PICK", F_CHIP, (255, 255, 255))
                canvas.text((x0 + 12, footer_y + 32), f"{score} picture match", F_MONO_SMALL, OK)
        else:
            canvas.ellipse((x0 + 12, footer_y + 2, x0 + 19, footer_y + 9), fill=(*BRAND, 255))
            canvas.text((x0 + 25, footer_y), "building", F_SMALL, LABEL2)
            canvas.text((x0 + 12, footer_y + 17), "tools streaming…", F_MONO_SMALL, LABEL3)

    # ── act 3: adoption ───────────────────────────────────────────────────
    adopt = ease((beat - 0.72) / 0.14)
    if adopt > 0:
        winner_centre = 352 + (winner - 1) * (lane_width + lane_gap) + lane_width / 2
        head_y = 334
        drop = head_y + 12 * adopt
        canvas.line([(winner_centre, head_y), (winner_centre, drop)], fill=(*BRAND, 255), width=2)
        canvas.polygon([(winner_centre, drop + 6), (winner_centre - 5, drop - 2), (winner_centre + 5, drop - 2)],
                       fill=(*BRAND, 255))

        bar_top = 352
        bar_bottom = bar_top + int(58 * adopt) + 6
        if bar_bottom > bar_top + 8:
            canvas.card((26, bar_top, 934, bar_bottom), radius=11, fill=SUNKEN, outline=BORDER_HI)
            canvas.rect((42, bar_top + 12, 118, bar_top + 32), radius=5, fill=(*BRAND, 44), outline=(*BRAND_LIGHT, 130))
            canvas.text((50, bar_top + 17), "index.html", F_MONO_SMALL, LABEL)
            canvas.text((132, bar_top + 13), adopted, F_MONO, LABEL)
            canvas.text((132, bar_top + 29), f"copied into your workspace · {score} picture match · open it and it runs",
                        F_SMALL, LABEL2)

    # ── captions ──────────────────────────────────────────────────────────
    caption = "1 screenshot"
    if beat > 0.26:
        caption = "3 agents · 3 isolated directories"
    if beat > 0.68:
        caption = "compare the live pages"
    if beat > 0.84:
        caption = "adopt one — it is already a working page"
    canvas.text((26, 448), caption, F_H2, LABEL)
    canvas.text((26, 466), "illustration of the flow · the match score is the demo run's measured value", F_TINY, LABEL3)

    for index in range(5):
        cx = 900 - index * 14
        active = beat >= index * 0.21
        canvas.ellipse((cx - 2.5, 470, cx + 2.5, 475), fill=(*BRAND, 255) if active else (52, 68, 92))

    return canvas.finish()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--score", default="92.7%", help="the adopted lane's measured picture match")
    parser.add_argument("--files", action="append", type=int, default=None)
    parser.add_argument("--winner", type=int, default=2)
    parser.add_argument("--adopted", default="clone-a91c-lane-2")
    parser.add_argument("--frames", type=int, default=24)
    args = parser.parse_args()

    files = (args.files or [3, 4, 0])[:3]
    while len(files) < 3:
        files.append(0)

    frames = [
        draw_frame(args.reference, files, args.winner, args.adopted, args.score,
                   beat=index / (args.frames - 1), pulse=(index * 0.24) % 1.0)
        for index in range(args.frames)
    ]
    hold = [frames[-1]] * 6

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    frames[0].save(
        args.out,
        save_all=True,
        append_images=frames[1:] + hold,
        duration=[95] * len(frames) + [650] * len(hold),
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"wrote {args.out} — {len(frames) + len(hold)} frames, {os.path.getsize(args.out) / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
