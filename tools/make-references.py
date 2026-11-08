#!/usr/bin/env python3
"""
Generate the showcase reference screenshots for the README and the landing page.

These are the "specs" a person would hand dsh-clone: dense, design-led screens
with gradients, charts, tables and glass panels — deliberately harder than a
login form, and all reproducible from this script.

    python3 tools/make-references.py --out docs/assets

Writes nebula-dashboard.png (1280x800) and aperture-landing.png (1280x800).
"""

from __future__ import annotations

import argparse
import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 2  # supersample


def font(size, bold=False):
    for path in [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]:
        try:
            return ImageFont.truetype(path, int(size * S))
        except Exception:
            continue
    return ImageFont.load_default()


def mono(size, bold=False):
    for path in [
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/Supplemental/Courier New Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Courier New.ttf",
    ]:
        try:
            return ImageFont.truetype(path, int(size * S))
        except Exception:
            continue
    return font(size, bold)


class Art:
    """Design-pixel drawing surface with gradient, shadow and chart helpers."""

    def __init__(self, width, height, top, bottom):
        self.w, self.h = width, height
        base = Image.new("RGB", (1, height * S))
        for y in range(height * S):
            t = y / max(1, height * S - 1)
            base.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
        self.img = base.resize((width * S, height * S)).convert("RGBA")
        self.draw = ImageDraw.Draw(self.img)

    def box(self, values):
        return [int(round(v * S)) for v in values]

    def glow(self, box, colour, blur=90, alpha=140):
        layer = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse(self.box(box), fill=(*colour, alpha))
        self.img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur * S)))
        self.draw = ImageDraw.Draw(self.img)

    @staticmethod
    def _translucent(fill):
        """Whether a paint colour would need real alpha blending."""
        return isinstance(fill, tuple) and len(fill) == 4 and fill[3] < 255

    def _composite(self, paint):
        """Draw into a scratch layer and blend it, so alpha means alpha.

        PIL writes raw pixel values instead of blending when it draws on an RGBA
        image, so every translucent fill would land as its opaque RGB.
        """
        layer = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
        paint(ImageDraw.Draw(layer))
        self.img.alpha_composite(layer)
        self.draw = ImageDraw.Draw(self.img)

    def rect(self, box, r=0, fill=None, outline=None, width=1):
        args = dict(radius=int(r * S), fill=fill, outline=outline, width=max(1, int(width * S)))
        if self._translucent(fill) or self._translucent(outline):
            self._composite(lambda d: d.rounded_rectangle(self.box(box), **args))
        else:
            self.draw.rounded_rectangle(self.box(box), **args)

    def shape(self, points, fill=None):
        coords = [(int(x * S), int(y * S)) for x, y in points]
        if self._translucent(fill):
            self._composite(lambda d: d.polygon(coords, fill=fill))
        else:
            self.draw.polygon(coords, fill=fill)

    def line(self, points, fill, width=1):
        coords = [(int(x * S), int(y * S)) for x, y in points]
        args = dict(fill=fill, width=max(1, int(width * S)), joint="curve")
        if self._translucent(fill):
            self._composite(lambda d: d.line(coords, **args))
        else:
            self.draw.line(coords, **args)

    def text(self, xy, value, f, fill):
        self.draw.text((xy[0] * S, xy[1] * S), value, font=f, fill=fill)

    def measure(self, value, f):
        return self.draw.textlength(value, font=f) / S

    def card(self, box, r=14, fill=(17, 26, 43, 255), outline=(40, 56, 82, 255), shadow=26, glow=None):
        x0, y0, x1, y1 = [int(round(v * S)) for v in box]
        pad = 20 * S
        layer = Image.new("RGBA", (x1 - x0 + pad * 2, y1 - y0 + pad * 2), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(
            [pad, pad + 3 * S, pad + (x1 - x0), pad + (y1 - y0) + 3 * S], radius=int(r * S), fill=(0, 0, 0, 150))
        self.img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(shadow * S / 2)), (x0 - pad, y0 - pad))
        if glow is not None:
            halo = Image.new("RGBA", (x1 - x0 + pad * 2, y1 - y0 + pad * 2), (0, 0, 0, 0))
            ImageDraw.Draw(halo).rounded_rectangle(
                [pad, pad, pad + (x1 - x0), pad + (y1 - y0)], radius=int(r * S), fill=glow)
            self.img.alpha_composite(halo.filter(ImageFilter.GaussianBlur(18 * S)), (x0 - pad, y0 - pad))
        self.rect(box, r, fill, outline, 1)

    def sparkline(self, box, values, colour, width=2.2, fill_alpha=48):
        x0, y0, x1, y1 = box
        lo, hi = min(values), max(values)
        span = (hi - lo) or 1
        points = []
        for index, value in enumerate(values):
            x = x0 + (x1 - x0) * index / (len(values) - 1)
            y = y1 - (y1 - y0) * (value - lo) / span
            points.append((x, y))
        if fill_alpha:
            self.shape(points + [(x1, y1), (x0, y1)], fill=(*colour, fill_alpha))
        self.line(points, (*colour, 255), width)

    def donut(self, centre, radius, thickness, segments):
        total = sum(value for _, value in segments)
        start = -90.0
        for colour, value in segments:
            sweep = 360.0 * value / total
            self.draw.arc(
                [int((centre[0] - radius) * S), int((centre[1] - radius) * S),
                 int((centre[0] + radius) * S), int((centre[1] + radius) * S)],
                start=start, end=start + sweep - 2, fill=(*colour, 255), width=int(thickness * S))
            start += sweep

    def avatar(self, centre, radius, colour, initials=None):
        self.draw.ellipse(self.box((centre[0] - radius, centre[1] - radius,
                                    centre[0] + radius, centre[1] + radius)), fill=(*colour, 255))
        if initials:
            f = font(radius * 0.85, True)
            width = self.measure(initials, f)
            self.text((centre[0] - width / 2, centre[1] - radius * 0.62), initials, f, (10, 14, 24))

    def save(self, path):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.img.convert("RGB").resize((self.w, self.h), Image.LANCZOS).save(path, optimize=True)
        print(f"wrote {path} — {self.w}x{self.h}")


# ── reference 1: a dense product dashboard ────────────────────────────────
def nebula(width=1280, height=800):
    art = Art(width, height, (8, 11, 20), (11, 16, 30))
    art.glow((760, -220, 1500, 340), (124, 92, 255), blur=150, alpha=120)
    art.glow((-200, 420, 420, 980), (34, 211, 238), blur=160, alpha=70)

    ink = (240, 245, 255, 255)
    muted = (150, 166, 196, 255)
    faint = (108, 126, 158, 255)
    panel = (16, 24, 41, 255)
    edge = (38, 53, 78, 255)
    violet = (139, 92, 246)
    cyan = (34, 211, 238)
    mint = (52, 211, 153)
    amber = (251, 191, 36)

    # ── sidebar
    art.rect((0, 0, 232, height), 0, fill=(12, 18, 32, 255))
    art.line([(232, 0), (232, height)], (34, 48, 72, 255), 1)
    art.rect((20, 22, 46, 48), 8, fill=(*violet, 255))
    art.rect((28, 30, 38, 40), 2, fill=(10, 14, 24, 255))
    art.text((56, 26), "Nebula", font(16, True), ink)
    art.text((56, 44), "observability", font(9), faint)

    nav = [("Overview", True), ("Traces", False), ("Models", False),
           ("Datasets", False), ("Alerts", False), ("Settings", False)]
    y = 88
    for label, active in nav:
        if active:
            art.rect((12, y - 8, 220, y + 26), 10, fill=(*violet, 40), outline=(*violet, 120))
        art.rect((28, y + 3, 38, y + 13), 3,
                 fill=(*violet, 255) if active else (60, 76, 104, 255))
        art.text((50, y), label, font(13, active), ink if active else muted)
        y += 42

    art.rect((12, height - 108, 220, height - 24), 12, fill=panel, outline=edge)
    art.avatar((44, height - 66), 16, (56, 189, 248), "AK")
    art.text((70, height - 82), "Ava Kessler", font(12, True), ink)
    art.text((70, height - 66), "platform · admin", font(10), faint)
    art.rect((70, height - 48, 194, height - 30), 6, fill=(*mint, 34), outline=(*mint, 110))
    art.text((80, height - 47), "on-call this week", font(9), (167, 243, 208, 255))

    # ── top bar
    art.text((264, 30), "Overview", font(24, True), ink)
    art.text((264, 62), "prod · eu-central · last 24 hours", font(11), faint)
    art.rect((700, 30, 980, 66), 10, fill=(16, 24, 41, 255), outline=edge)
    art.text((716, 42), "⌕  Search traces, models, users…", font(11), faint)
    art.rect((1000, 30, 1120, 66), 10, fill=(16, 24, 41, 255), outline=edge)
    art.text((1016, 42), "Last 24h  ⌄", font(11), muted)
    for index, colour in enumerate([(244, 114, 182), (96, 165, 250), (52, 211, 153)]):
        art.avatar((1146 + index * 22, 48), 14, colour)
    art.rect((1226, 30, 1256, 66), 10, fill=(*violet, 255))
    art.text((1234, 42), "+", font(16, True), (255, 255, 255, 255))

    # ── KPI cards
    kpis = [
        ("Requests", "18.4M", "+12.6%", mint, [4, 6, 5, 8, 7, 11, 9, 13, 12, 15]),
        ("p95 latency", "412 ms", "−38 ms", mint, [15, 14, 15, 12, 13, 10, 11, 9, 8, 7]),
        ("Error rate", "0.42%", "+0.06%", amber, [3, 4, 3, 5, 4, 6, 5, 7, 6, 8]),
        ("Cost / 1k", "$0.019", "−8.1%", mint, [9, 8, 8, 7, 6, 6, 5, 5, 4, 4]),
    ]
    for index, (title, value, delta, colour, series) in enumerate(kpis):
        x = 264 + index * 248
        art.card((x, 96, x + 232, 212), 14, panel, edge, shadow=18)
        art.text((x + 18, 112), title, font(11), faint)
        art.text((x + 18, 132), value, font(26, True), ink)
        pill_w = art.measure(delta, font(9, True)) + 20
        art.rect((x + 18, 176, x + 18 + pill_w, 196), 10, fill=(*colour, 30), outline=(*colour, 120))
        art.text((x + 28, 180), delta, font(9, True), (230, 245, 255, 255))
        art.sparkline((x + 120, 168, x + 214, 200), series, colour)

    # ── main chart
    art.card((264, 232, 890, 520), 16, panel, edge, shadow=24)
    art.text((286, 252), "Latency distribution", font(14, True), ink)
    art.text((286, 274), "p50 / p95 / p99 across 6 services", font(10), faint)
    for index, (label, colour) in enumerate([("p50", mint), ("p95", cyan), ("p99", violet)]):
        x = 660 + index * 76
        art.rect((x, 256, x + 8, 264), 2, fill=(*colour, 255))
        art.text((x + 14, 254), label, font(10), muted)

    for step in range(5):
        y = 320 + step * 40
        art.line([(290, y), (866, y)], (30, 43, 64, 255), 1)
        art.text((286, y - 16), f"{600 - step * 150}ms", font(8), (86, 102, 132, 255))

    series_p95 = [210, 250, 230, 300, 270, 340, 320, 400, 360, 330, 300, 280]
    series_p50 = [120, 140, 130, 160, 150, 180, 170, 200, 190, 180, 160, 150]
    art.sparkline((300, 340, 860, 500), series_p95, cyan, 2.6, 40)
    art.sparkline((300, 380, 860, 500), series_p50, mint, 2.2, 26)
    art.sparkline((300, 320, 860, 500), [v + 120 for v in series_p95], violet, 1.8, 0)
    for index, label in enumerate(["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"]):
        art.text((300 + index * 112, 506), label, font(8), (86, 102, 132, 255))

    # ── right column: donut + model list
    art.card((906, 232, 1256, 520), 16, panel, edge, shadow=24)
    art.text((926, 252), "Token spend", font(14, True), ink)
    art.text((926, 274), "by model family", font(10), faint)
    art.donut((1080, 356), 52, 16, [(violet, 46), (cyan, 28), (mint, 18), (amber, 8)])
    art.draw.ellipse(art.box((1056, 332, 1104, 380)), fill=(17, 25, 42, 255))
    total_w = art.measure("$3.8k", font(15, True))
    art.text((1080 - total_w / 2, 344), "$3.8k", font(15, True), ink)
    art.text((1058, 366), "total", font(9), faint)

    models = [("deepseek-v4", 46, violet), ("kimi-k3", 28, cyan), ("qwen-4", 18, mint), ("other", 8, amber)]
    y = 424
    for name, share, colour in models:
        art.rect((926, y + 3, 936, y + 11), 2, fill=(*colour, 255))
        art.text((944, y), name, font(11), muted)
        art.rect((1090, y + 3, 1236, y + 9), 3, fill=(30, 43, 64, 255))
        art.rect((1090, y + 3, 1090 + 146 * share / 100, y + 9), 3, fill=(*colour, 230))
        share_text = f"{share}%"
        art.text((1236 - art.measure(share_text, font(9)) - 2, y - 8), share_text, font(9), faint)
        y += 24

    # ── table
    art.card((264, 540, 1256, 764), 16, panel, edge, shadow=24)
    art.text((286, 560), "Slowest traces", font(14, True), ink)
    art.rect((1120, 556, 1236, 582), 8, fill=(*violet, 40), outline=(*violet, 130))
    art.text((1136, 563), "Open in console", font(9, True), (196, 181, 253, 255))

    columns = [("trace", 286), ("service", 470), ("model", 660), ("tokens", 830), ("latency", 960), ("status", 1090)]
    for label, x in columns:
        art.text((x, 596), label.upper(), font(8, True), (108, 126, 158, 255))
    art.line([(286, 614), (1236, 614)], (34, 48, 72, 255), 1)

    rows = [
        ("4f8a2c91", "gateway", "deepseek-v4", "18.4k", 412, "ok"),
        ("a12b7e04", "retriever", "kimi-k3", "9.2k", 890, "slow"),
        ("c90e3f55", "summariser", "deepseek-v4", "31.0k", 1240, "slow"),
        ("77bd1180", "router", "qwen-4", "2.1k", 96, "ok"),
    ]
    y = 626
    for trace, service, model, tokens, latency, status in rows:
        art.text((286, y), trace, mono(10), (196, 181, 253, 255))
        art.text((470, y), service, font(11), muted)
        art.text((660, y), model, mono(10), (147, 197, 253, 255))
        art.text((830, y), tokens, mono(10), muted)
        colour = mint if latency < 300 else amber
        art.text((960, y), f"{latency} ms", mono(10), colour)
        art.rect((1090, y - 4, 1090 + max(20, latency / 12), y + 2), 2, fill=(*colour, 200))
        art.rect((1160, y - 6, 1210, y + 10), 8,
                 fill=(*mint, 34) if status == "ok" else (*amber, 34),
                 outline=(*mint, 110) if status == "ok" else (*amber, 110))
        art.text((1172, y - 4), status, font(8, True), mint if status == "ok" else amber)
        y += 34
        art.line([(286, y - 10), (1236, y - 10)], (28, 40, 60, 255), 1)

    art.save(os.path.join(OUT, "nebula-dashboard.png"))


# ── reference 2: a landing page hero ──────────────────────────────────────
def aperture(width=1280, height=800):
    art = Art(width, height, (5, 7, 13), (9, 12, 22))
    art.glow((480, -260, 1180, 380), (99, 102, 241), blur=170, alpha=130)
    art.glow((60, 300, 520, 760), (16, 185, 129), blur=170, alpha=80)
    art.glow((900, 420, 1400, 900), (236, 72, 153), blur=170, alpha=70)

    ink = (244, 248, 255, 255)
    muted = (158, 172, 200, 255)
    faint = (110, 126, 154, 255)
    glass = (255, 255, 255, 16)
    edge = (255, 255, 255, 46)

    # nav
    art.rect((28, 24, 1252, 84), 16, fill=(12, 16, 28, 190), outline=(255, 255, 255, 34))
    art.rect((52, 42, 76, 66), 7, fill=(129, 140, 248, 255))
    art.shape([(60, 49), (68, 54), (60, 59)], fill=(10, 14, 24, 255))
    art.text((84, 44), "aperture", font(17, True), ink)
    for index, label in enumerate(["Product", "Customers", "Pricing", "Docs"]):
        art.text((250 + index * 108, 48), label, font(12), muted)
    art.rect((1074, 42, 1150, 72), 9, fill=(255, 255, 255, 0), outline=(255, 255, 255, 60))
    art.text((1100, 49), "Sign in", font(11), ink)
    art.rect((1160, 42, 1232, 72), 9, fill=(255, 255, 255, 245))
    art.text((1176, 49), "Get access", font(11, True), (10, 14, 24, 255))

    # hero copy
    art.text((78, 148), "SHIP VISUALS AT THE SPEED OF THOUGHT", font(9, True), (129, 140, 248, 255))
    art.text((78, 176), "Design systems", font(52, True), ink)
    art.text((78, 236), "that build", font(52, True), ink)
    art.text((78, 296), "themselves.", font(52, True), (167, 139, 250, 255))
    art.text((78, 372), "Aperture turns a reference into production", font(13), muted)
    art.text((78, 394), "components: type, spacing, colour and behaviour —", font(13), muted)
    art.text((78, 416), "extracted, not guessed.", font(13), muted)
    art.rect((78, 452, 246, 498), 12, fill=(255, 255, 255, 246))
    art.text((104, 465), "Start free  →", font(13, True), (10, 14, 24, 255))
    art.rect((258, 452, 420, 498), 12, fill=(255, 255, 255, 16), outline=(255, 255, 255, 64))
    art.text((282, 465), "Watch the demo", font(13), ink)

    # social proof
    for index, colour in enumerate([(244, 114, 182), (96, 165, 250), (52, 211, 153), (251, 191, 36)]):
        art.avatar((94 + index * 26, 534), 14, colour)
    art.text((204, 518), "Trusted by 4,200 product teams", font(11), muted)
    art.text((204, 536), "SOC 2 Type II · 99.99% uptime", font(9), faint)

    # floating glass preview
    art.card((600, 140, 1220, 560), 18, fill=(20, 26, 44, 235), outline=(255, 255, 255, 54),
             shadow=40, glow=(129, 140, 248, 46))
    art.rect((620, 160, 1200, 194), 10, fill=(255, 255, 255, 10), outline=(255, 255, 255, 28))
    for index, colour in enumerate([(248, 113, 113), (251, 191, 36), (52, 211, 153)]):
        art.draw.ellipse(art.box((634 + index * 16, 171, 644 + index * 16, 181)), fill=(*colour, 255))
    art.text((700, 170), "aperture / theme / generated", mono(9), faint)

    art.text((628, 210), "Palette extracted", font(12, True), ink)
    swatches = [(139, 92, 246), (99, 102, 241), (34, 211, 238), (52, 211, 153), (251, 191, 36), (244, 63, 94)]
    for index, colour in enumerate(swatches):
        art.rect((628 + index * 54, 234, 672 + index * 54, 286), 8, fill=(*colour, 255))

    art.text((628, 314), "Components", font(12, True), ink)
    art.rect((628, 338, 792, 380), 10, fill=(*((139, 92, 246)), 255))
    art.text((656, 350), "Primary action", font(11, True), (255, 255, 255, 255))
    art.rect((804, 338, 932, 380), 10, fill=(255, 255, 255, 10), outline=(255, 255, 255, 46))
    art.text((830, 350), "Secondary", font(11), ink)
    art.rect((628, 392, 1016, 430), 9, fill=(255, 255, 255, 10), outline=(255, 255, 255, 30))
    art.text((642, 402), "Email address", font(10), faint)
    art.rect((1024, 392, 1196, 430), 9, fill=(52, 211, 153, 255))
    art.text((1074, 403), "Generate →", font(11, True), (6, 20, 14, 255))

    art.text((628, 448), "Token graph", font(12, True), ink)
    art.sparkline((628, 470, 1196, 536), [4, 7, 6, 10, 9, 14, 12, 18, 16, 22, 20, 26], (129, 140, 248), 2.4, 46)

    # feature cards
    cards = [
        ("Extract, don't guess", "Type scale, spacing rhythm and colour tokens read straight off the reference.", (129, 140, 248)),
        ("Every state", "Hover, focus, disabled and error states generated from one picture.", (34, 211, 238)),
        ("Ships as code", "React, Vue or plain HTML — with the tokens as CSS variables.", (52, 211, 153)),
    ]
    for index, (title, body, colour) in enumerate(cards):
        x = 78 + index * 250
        art.rect((x, 580, x + 232, 728), 14, fill=(12, 16, 28, 200), outline=(255, 255, 255, 34))
        art.rect((x + 18, 598, x + 50, 630), 9, fill=(*colour, 46), outline=(*colour, 150))
        art.text((x + 28, 605), "◇", font(12), colour)
        art.text((x + 18, 644), title, font(13, True), ink)
        words = body.split(" ")
        line = ""
        row = 0
        for word in words:
            candidate = (line + " " + word).strip()
            if art.measure(candidate, font(10)) > 196:
                art.text((x + 18, 668 + row * 16), line, font(10), muted)
                line = word
                row += 1
            else:
                line = candidate
        art.text((x + 18, 668 + row * 16), line, font(10), muted)

    # footer strip
    art.line([(78, 752), (1202, 752)], (255, 255, 255, 26), 1)
    for index, label in enumerate(["Changelog", "Security", "Careers", "X / Twitter"]):
        art.text((78 + index * 150, 766), label, font(9), faint)
    right = "© 2026 Aperture Labs"
    art.text((1202 - art.measure(right, font(9)), 766), right, font(9), faint)

    art.save(os.path.join(OUT, "aperture-landing.png"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="docs/assets")
    OUT = parser.parse_args().out
    nebula()
    aperture()
