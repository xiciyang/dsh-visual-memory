#!/usr/bin/env python3
"""Pixel engine for dsh-visual-memory.

One JSON request on stdin, one JSON reply on stdout. Exit code 0 on success.
Only the operations the vision toolkit does NOT own live here:
  probe    - dimensions / format / perceptual hash (dHash 64-bit)
  overlay  - draw labelled attention boxes (explicit-attention visualisation)
  compose  - labelled side-by-side / grid / stack comparison sheet

Cropping, pixel-diff, colour sampling, tracing and OCR stay with
dsh-vision-toolkit (vision_crop / vision_pixel_diff / vision_dominant_colors /
vision_trace / vision_glance) so each capability has exactly one owner.
"""

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def text_size(draw, text, font):
    try:
        box = draw.textbbox((0, 0), text, font=font)
        return box[2] - box[0], box[3] - box[1]
    except Exception:
        return draw.textsize(text, font=font)


def dhash64(im):
    """64-bit difference hash, hex string. Stable across resizes/compression."""
    g = im.convert("L").resize((9, 8), Image.LANCZOS)
    px = list(g.tobytes())
    bits = 0
    for y in range(8):
        for x in range(8):
            left = px[y * 9 + x]
            right = px[y * 9 + x + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return format(bits, "016x")


def op_probe(req):
    path = req["path"]
    with Image.open(path) as im:
        im.load()
        width, height = im.size
        fmt = im.format or ""
        mode = im.mode
        has_alpha = "A" in mode
        hash_value = dhash64(im)
    return {
        "width": width,
        "height": height,
        "format": (fmt or "").lower(),
        "mode": mode,
        "hasAlpha": has_alpha,
        "dhash": hash_value,
        "bytes": os.path.getsize(path),
    }


def op_overlay(req):
    """Draw labelled boxes on a copy. Returns geometry facts, not opinions."""
    src = req["path"]
    out = req["output"]
    regions = req.get("regions") or []
    scale = int(req.get("scale") or 1)
    with Image.open(src) as im:
        im = im.convert("RGBA")
        width, height = im.size
        draw = ImageDraw.Draw(im, "RGBA")
        font = load_font(max(13, int(min(width, height) / 34)))
        clamped = []
        for index, region in enumerate(regions):
            x1 = max(0, min(int(region["x1"]), width - 1))
            y1 = max(0, min(int(region["y1"]), height - 1))
            x2 = max(0, min(int(region["x2"]), width))
            y2 = max(0, min(int(region["y2"]), height))
            if x2 <= x1 or y2 <= y1:
                continue
            label = str(region.get("label") or ("R" + str(index + 1)))
            clamped.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "label": label})
            draw.rectangle([x1, y1, x2, y2], outline=(255, 64, 64, 255), width=max(2, int(min(width, height) / 300)))
            tw, th = text_size(draw, label, font)
            pad = 4
            ty = y1 - th - pad * 2
            if ty < 0:
                ty = min(height - th - pad * 2, y2 + 1)
            draw.rectangle([x1, ty, x1 + tw + pad * 2, ty + th + pad * 2], fill=(255, 64, 64, 235))
            draw.text((x1 + pad, ty + pad), label, fill=(255, 255, 255, 255), font=font)
        if scale != 1:
            im = im.resize((width * scale, height * scale), Image.LANCZOS)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        im.convert("RGB").save(out, "PNG")
    return {"output": out, "width": im.size[0], "height": im.size[1], "regions": clamped, "scale": scale}


def fit(im, max_w, max_h):
    ratio = min(max_w / im.size[0], max_h / im.size[1], 1.0)
    if ratio < 1.0:
        return im.resize((max(1, int(im.size[0] * ratio)), max(1, int(im.size[1] * ratio))), Image.LANCZOS)
    return im


def op_compose(req):
    """Labelled composite sheet: side-by-side | stack | grid."""
    items = req["items"]
    mode = req.get("mode") or "side-by-side"
    labels = req.get("labels") or []
    gap = int(req.get("gap") or 18)
    background = req.get("background") or "#ffffff"
    max_cell = int(req.get("maxCell") or 900)
    title = req.get("title")
    out = req["output"]
    only_label = req.get("labelsOnly") or False

    panels = []
    for index, item in enumerate(items):
        with Image.open(item["path"]) as im:
            im = im.convert("RGB")
            panels.append((fit(im, max_cell, max_cell), labels[index] if index < len(labels) and labels[index] else (item.get("label") or ""), im.size))

    if mode == "grid":
        count = len(panels)
        columns = 1
        while columns * columns < count:
            columns += 1
        rows = (count + columns - 1) // columns
    elif mode == "stack":
        columns, rows = 1, len(panels)
    else:
        columns, rows = len(panels), 1

    cell_w = max(p[0].size[0] for p in panels)
    cell_h = max(p[0].size[1] for p in panels)
    font = load_font(20)
    title_font = load_font(28)
    label_h = 30

    probe_draw = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    title_h = 0
    if title:
        title_h = text_size(probe_draw, title, title_font)[1] + 24

    width = gap + columns * (cell_w + gap)
    height = gap + title_h + rows * (cell_h + label_h + gap)
    sheet = Image.new("RGB", (max(width, 1), max(height, 1)), background)
    draw = ImageDraw.Draw(sheet)
    if title:
        draw.text((gap, 12), title, fill="#111111", font=title_font)

    origin_y = gap + title_h
    for index, (image, label, original) in enumerate(panels):
        row = index // columns
        col = index % columns
        x = gap + col * (cell_w + gap) + (cell_w - image.size[0]) // 2
        y = origin_y + row * (cell_h + label_h + gap) + (cell_h - image.size[1]) // 2
        sheet.paste(image, (x, y))
        draw.rectangle([gap + col * (cell_w + gap), origin_y + row * (cell_h + label_h + gap),
                        gap + col * (cell_w + gap) + cell_w, origin_y + row * (cell_h + label_h + gap) + cell_h],
                       outline="#d0d0d0")
        if label and not only_label:
            pass
        caption = label or ("#%d" % (index + 1))
        caption = "%s  (%dx%d)" % (caption, original[0], original[1])
        draw.text((gap + col * (cell_w + gap) + 6,
                   origin_y + row * (cell_h + label_h + gap) + cell_h + 6), caption, fill="#333333", font=font)

    os.makedirs(os.path.dirname(out), exist_ok=True)
    sheet.save(out, "PNG")
    return {
        "output": out,
        "width": sheet.size[0],
        "height": sheet.size[1],
        "mode": mode,
        "columns": columns,
        "rows": rows,
        "panels": [{"label": p[1], "sourceWidth": p[2][0], "sourceHeight": p[2][1]} for p in panels],
    }


def op_draw(req):
    """Author a fixture whose colours are known exactly (used by verify.mjs).

    Four 32x16 quadrants: red, green, blue, white. A 2x2 read_pixels over the
    whole frame must return exactly those four values.
    """
    out = req["path"]
    im = Image.new("RGB", (64, 32), (255, 255, 255))
    draw = ImageDraw.Draw(im)
    draw.rectangle([0, 0, 31, 15], fill=(255, 0, 0))
    draw.rectangle([32, 0, 63, 15], fill=(0, 255, 0))
    draw.rectangle([0, 16, 31, 31], fill=(0, 0, 255))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out, "PNG")
    return {
        "path": out,
        "width": 64,
        "height": 32,
        "dhash": dhash64(im),
        "quadrants": ["#ff0000", "#00ff00", "#0000ff", "#ffffff"],
    }


def op_crop(req):
    """Cut a region out of the ORIGINAL observation and optionally enlarge it."""
    src = req["path"]
    out = req["output"]
    region = req.get("region")
    scale = int(req.get("scale") or 1)
    with Image.open(src) as im:
        im = im.convert("RGB")
        width, height = im.size
        if region:
            x1 = max(0, min(int(region["x1"]), width - 1))
            y1 = max(0, min(int(region["y1"]), height - 1))
            x2 = max(x1 + 1, min(int(region["x2"]), width))
            y2 = max(y1 + 1, min(int(region["y2"]), height))
            im = im.crop((x1, y1, x2, y2))
            box = {"x1": x1, "y1": y1, "x2": x2, "y2": y2}
        else:
            box = {"x1": 0, "y1": 0, "x2": width, "y2": height}
        if scale > 1:
            im = im.resize((im.size[0] * scale, im.size[1] * scale), Image.LANCZOS)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        im.save(out, "PNG")
        size = im.size
    return {"output": out, "width": size[0], "height": size[1], "region": box, "scale": scale}


def op_pixels(req):
    """Read the exact colour of each cell of a region (VISTA's read_pixels).

    The region is split into rows x cols cells and each cell's centre pixel is
    read. Returns "#rrggbb" per cell plus the distinct values in order of first
    appearance. This is a measurement, not a description.
    """
    src = req["path"]
    rows = int(req.get("rows") or 8)
    cols = int(req.get("cols") or 8)
    region = req.get("region")
    with Image.open(src) as im:
        im = im.convert("RGB")
        width, height = im.size
        if region:
            x1 = max(0, min(int(region["x1"]), width - 1))
            y1 = max(0, min(int(region["y1"]), height - 1))
            x2 = max(x1 + 1, min(int(region["x2"]), width))
            y2 = max(y1 + 1, min(int(region["y2"]), height))
        else:
            x1, y1, x2, y2 = 0, 0, width, height
        box = {"x1": x1, "y1": y1, "x2": x2, "y2": y2}
        crop = im.crop((x1, y1, x2, y2))
        cw = max(1.0, (x2 - x1) / cols)
        ch = max(1.0, (y2 - y1) / rows)
        grid = []
        unique = []
        for r in range(rows):
            row = []
            for c in range(cols):
                px = int(min(x2 - 1, x1 + (c + 0.5) * cw))
                py = int(min(y2 - 1, y1 + (r + 0.5) * ch))
                value = im.getpixel((px, py))
                hexed = "#%02x%02x%02x" % value
                row.append(hexed)
                if hexed not in unique:
                    unique.append(hexed)
            grid.append(row)
    return {
        "region": box,
        "rows": rows,
        "cols": cols,
        "cellWidth": round(cw, 3),
        "cellHeight": round(ch, 3),
        "cells": grid,
        "distinct": unique,
        "distinctCount": len(unique),
        "sampling": "centre pixel of each cell (exact read, no averaging)",
    }


def main():
    raw = sys.stdin.read()
    req = json.loads(raw)
    op = req.get("op")
    if op == "probe":
        value = op_probe(req)
    elif op == "overlay":
        value = op_overlay(req)
    elif op == "compose":
        value = op_compose(req)
    elif op == "draw":
        value = op_draw(req)
    elif op == "crop":
        value = op_crop(req)
    elif op == "pixels":
        value = op_pixels(req)
    else:
        raise SystemExit("unknown op: %r" % (op,))
    sys.stdout.write(json.dumps({"ok": True, "value": value}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - the host needs a structured failure
        sys.stdout.write(json.dumps({"ok": False, "error": "%s: %s" % (type(error).__name__, error)}))
        sys.exit(0)
