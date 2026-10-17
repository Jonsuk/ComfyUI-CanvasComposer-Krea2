"""Canvas Composer compositing core.

Pure numpy + Pillow (no torch, no ComfyUI imports) so it can be tested on its own.
Every effect here has a matching preview in web/canvas_composer.js - keep them in sync.

Layer pipeline (all in the layer's own pixel space, then placed on the canvas):
    crop -> scale -> cuts (Remove tool) -> colour -> flip -> feather/fade -> rotate -> blend
"""
import json
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

try:  # Pillow >= 9.1
    _LANCZOS = Image.Resampling.LANCZOS
    _BILINEAR = Image.Resampling.BILINEAR
    _BICUBIC = Image.Resampling.BICUBIC
    _BOX = Image.Resampling.BOX
except AttributeError:  # pragma: no cover
    _LANCZOS, _BILINEAR, _BICUBIC, _BOX = Image.LANCZOS, Image.BILINEAR, Image.BICUBIC, Image.BOX

BLEND_MODES = ("normal", "multiply", "screen", "overlay", "soft_light", "darken", "lighten", "add")


# ----------------------------------------------------------------------------- parsing
def parse_layers(raw):
    try:
        data = json.loads(raw or "[]")
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [layer for layer in data if isinstance(layer, dict)]


def _f(value, default=0.0):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(v) or math.isinf(v):
        return default
    return v


def _sub(layer, key):
    value = layer.get(key)
    return value if isinstance(value, dict) else {}


# ----------------------------------------------------------------------------- effects
def _render_cuts(cuts, src_w, src_h, crop, nw, nh):
    """Rasterise Remove-tool cuts into a float mask (nh, nw): 1 = removed.

    Cut points are stored normalised to the *source* image (u, v in 0..1), so they stay
    valid whatever the layer's scale, crop or rotation.
    """
    if not cuts:
        return None
    ss = 2 if nw * nh <= 16_000_000 else 1
    w2, h2 = nw * ss, nh * ss
    mask = Image.new("L", (w2, h2), 0)
    draw = ImageDraw.Draw(mask)
    cl, ct = crop[0], crop[1]
    cw = max(1, src_w - crop[0] - crop[2])
    ch = max(1, src_h - crop[1] - crop[3])
    kx, ky = w2 / cw, h2 / ch

    def pt(p):
        return ((_f(p[0]) * src_w - cl) * kx, (_f(p[1]) * src_h - ct) * ky)

    for cut in cuts:
        if not isinstance(cut, dict):
            continue
        raw_pts = [p for p in cut.get("pts", []) if isinstance(p, (list, tuple)) and len(p) >= 2]
        if not raw_pts:
            continue
        pts = [pt(p) for p in raw_pts]
        fill = 0 if cut.get("op") == "restore" else 255
        if cut.get("kind") == "poly":
            if len(pts) >= 3:
                draw.polygon(pts, fill=fill)
        else:  # stroke / brush
            width = max(1.0, _f(cut.get("size"), 0.02) * max(src_w, src_h) * kx)
            r = width / 2.0
            if len(pts) > 1:
                draw.line(pts, fill=fill, width=max(1, int(round(width))), joint="curve")
            for x, y in pts:
                draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)
    if ss > 1:
        mask = mask.resize((nw, nh), _BOX)
    return np.asarray(mask, dtype=np.float32) / 255.0


def _apply_color(rgb, color):
    """Brightness / contrast / saturation, mirroring CSS filter maths used by the preview."""
    b, c, s = (_f(color.get(k)) for k in ("b", "c", "s"))
    if b:
        rgb = np.clip(rgb * max(0.0, 1.0 + b / 100.0), 0.0, 1.0)
    if c:
        rgb = np.clip((rgb - 0.5) * max(0.0, 1.0 + c / 100.0) + 0.5, 0.0, 1.0)
    if s:
        k = max(0.0, 1.0 + s / 100.0)
        r, g, bl = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        out = np.empty_like(rgb)
        out[..., 0] = (0.213 + 0.787 * k) * r + (0.715 - 0.715 * k) * g + (0.072 - 0.072 * k) * bl
        out[..., 1] = (0.213 - 0.213 * k) * r + (0.715 + 0.285 * k) * g + (0.072 - 0.072 * k) * bl
        out[..., 2] = (0.213 - 0.213 * k) * r + (0.715 - 0.715 * k) * g + (0.072 + 0.928 * k) * bl
        rgb = np.clip(out, 0.0, 1.0)
    return rgb


def _edge_mask(nw, nh, feather, fade):
    """Feather (soft border) and one-sided gradient fades, in final layer pixels.

    Feather = inset rectangle blurred: inset f/2, sigma f/4 -> alpha 0 at the border and
    ~1 at distance f. Matches the preview (canvas blur on an inset rectangle).
    """
    mask = None
    f = min(max(0.0, feather), float(min(nw, nh) - 2))
    if f >= 1.0:
        inset = int(round(f / 2.0))
        m = Image.new("L", (nw, nh), 0)
        if nw - inset - 1 > inset and nh - inset - 1 > inset:
            ImageDraw.Draw(m).rectangle([inset, inset, nw - inset - 1, nh - inset - 1], fill=255)
        m = m.filter(ImageFilter.GaussianBlur(f / 4.0))
        mask = np.asarray(m, dtype=np.float32) / 255.0

    xs = np.arange(nw, dtype=np.float32) + 0.5
    ys = np.arange(nh, dtype=np.float32) + 0.5
    ramps = []
    fl, fr, ft, fb = (_f(fade.get(k)) for k in ("l", "r", "t", "b"))
    if fl > 0:
        ramps.append(np.clip(xs / fl, 0.0, 1.0)[None, :])
    if fr > 0:
        ramps.append(np.clip((nw - xs) / fr, 0.0, 1.0)[None, :])
    if ft > 0:
        ramps.append(np.clip(ys / ft, 0.0, 1.0)[:, None])
    if fb > 0:
        ramps.append(np.clip((nh - ys) / fb, 0.0, 1.0)[:, None])
    for ramp in ramps:
        mask = ramp * np.ones((nh, nw), np.float32) if mask is None else mask * ramp
    return mask


def _rotate(rgb, alpha, rot):
    """Rotate (clockwise-positive) on premultiplied channels to avoid dark fringes."""
    pm = rgb * alpha[..., None]
    chans = [pm[..., 0], pm[..., 1], pm[..., 2], alpha]
    out = []
    for ch in chans:
        im = Image.fromarray(np.ascontiguousarray(ch, dtype=np.float32))
        im = im.rotate(-rot, resample=_BICUBIC, expand=True)
        out.append(np.asarray(im, dtype=np.float32))
    a2 = np.clip(out[3], 0.0, 1.0)
    pm2 = np.stack(out[:3], axis=-1)
    rgb2 = np.where(a2[..., None] > 1e-4, pm2 / np.maximum(a2[..., None], 1e-4), 0.0)
    return np.clip(rgb2, 0.0, 1.0).astype(np.float32), a2.astype(np.float32)


def process_layer(img, layer):
    """img: PIL image. Returns (rgb float32 HxWx3, alpha float32 HxW) ready to place."""
    img = img.convert("RGBA")
    w, h = img.size
    crop_d = _sub(layer, "crop")
    cl = int(min(max(round(_f(crop_d.get("l"))), 0), w - 1))
    ct = int(min(max(round(_f(crop_d.get("t"))), 0), h - 1))
    cr = int(min(max(round(_f(crop_d.get("r"))), 0), w - 1 - cl))
    cb = int(min(max(round(_f(crop_d.get("b"))), 0), h - 1 - ct))
    cw, ch = w - cl - cr, h - ct - cb
    if (cl, ct, cr, cb) != (0, 0, 0, 0):
        img = img.crop((cl, ct, w - cr, h - cb))

    scale = max(0.001, _f(layer.get("scale"), 1.0))
    nw, nh = max(1, int(round(cw * scale))), max(1, int(round(ch * scale)))
    img = img.resize((nw, nh), _LANCZOS)

    arr = np.asarray(img, dtype=np.float32) / 255.0
    rgb, alpha = arr[..., :3].copy(), arr[..., 3].copy()

    cuts = layer.get("cuts")
    if isinstance(cuts, list) and cuts:
        removed = _render_cuts(cuts, w, h, (cl, ct, cr, cb), nw, nh)
        if removed is not None:
            alpha = alpha * (1.0 - removed)

    rgb = _apply_color(rgb, _sub(layer, "color"))

    if layer.get("flip"):
        rgb = np.ascontiguousarray(rgb[:, ::-1])
        alpha = np.ascontiguousarray(alpha[:, ::-1])

    edge = _edge_mask(nw, nh, _f(layer.get("feather")), _sub(layer, "fade"))
    if edge is not None:
        alpha = alpha * edge

    rot = _f(layer.get("rot"))
    if abs(rot) > 1e-6:
        rgb, alpha = _rotate(rgb, alpha, rot)
    return rgb, alpha


# ----------------------------------------------------------------------------- blending
def _blend(cb, cs, mode):
    if mode == "multiply":
        return cb * cs
    if mode == "screen":
        return cb + cs - cb * cs
    if mode == "overlay":  # hard-light with the layers swapped
        return np.where(cb <= 0.5, 2.0 * cb * cs, 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs))
    if mode == "soft_light":
        d = np.where(cb <= 0.25, ((16.0 * cb - 12.0) * cb + 4.0) * cb, np.sqrt(cb))
        return np.where(cs <= 0.5, cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb), cb + (2.0 * cs - 1.0) * (d - cb))
    if mode == "darken":
        return np.minimum(cb, cs)
    if mode == "lighten":
        return np.maximum(cb, cs)
    if mode == "add":
        return np.clip(cb + cs, 0.0, 1.0)
    return cs


# ----------------------------------------------------------------------------- seams
def _seam_mask(shapes, width, height, seam_width):
    """Soft mask along the borders between visible layer regions (and gaps).

    shapes: bool arrays (H, W), bottom layer first. Each layer is reduced to the part that
    is actually visible (not covered by layers above), then its border band is taken.
    seam_width is the total band width in px.
    """
    if seam_width <= 0 or not shapes:
        return np.zeros((height, width), np.float32)
    r = max(1.0, seam_width / 2.0)
    f = max(1, int(math.ceil(r / 6.0)))
    rs = max(1, int(round(r / f)))
    sw, sh = max(1, width // f), max(1, height // f)

    covered_above = np.zeros((height, width), bool)
    small_band = np.zeros((sh, sw), np.float32)
    for shape in reversed(shapes):
        visible = shape & ~covered_above
        covered_above |= shape
        if not visible.any():
            continue
        small = Image.fromarray((visible * 255).astype(np.uint8)).resize((sw, sh), _BOX)
        s_arr = (np.asarray(small) >= 128).astype(np.uint8) * 255
        padded = np.pad(s_arr, rs, mode="edge")  # replicate edges: canvas borders are not seams
        im = Image.fromarray(padded)
        size = 2 * rs + 1
        dil = np.asarray(im.filter(ImageFilter.MaxFilter(size)), dtype=np.float32)
        ero = np.asarray(im.filter(ImageFilter.MinFilter(size)), dtype=np.float32)
        band = ((dil - ero) / 255.0)[rs:rs + sh, rs:rs + sw]
        small_band = np.maximum(small_band, band)

    big = Image.fromarray((small_band * 255).astype(np.uint8)).resize((width, height), _BILINEAR)
    big = big.filter(ImageFilter.GaussianBlur(max(1.0, r / 3.0)))
    return np.asarray(big, dtype=np.float32) / 255.0


# ----------------------------------------------------------------------------- compose
def compose(width, height, bg_rgb, layers, loader, seam_width=32):
    """Compose layers onto a canvas.

    loader(layer) -> PIL image or None. Returns (image HxWx3, covered HxW, gap HxW, seam HxW),
    all float32 in 0..1.
    """
    canvas = np.empty((height, width, 3), np.float32)
    canvas[:] = np.asarray(bg_rgb, np.float32) / 255.0
    covered = np.zeros((height, width), np.float32)
    shapes = []

    for layer in layers:
        if layer.get("visible", True) is False:
            continue
        img = loader(layer)
        if img is None:
            continue

        rgb, alpha = process_layer(img, layer)
        rh, rw = alpha.shape
        left = int(round(_f(layer.get("x"), width / 2.0) - rw / 2.0))
        top = int(round(_f(layer.get("y"), height / 2.0) - rh / 2.0))

        x0, y0 = max(left, 0), max(top, 0)
        x1, y1 = min(left + rw, width), min(top + rh, height)
        if x1 <= x0 or y1 <= y0:
            continue
        lx0, ly0 = x0 - left, y0 - top
        lx1, ly1 = lx0 + (x1 - x0), ly0 + (y1 - y0)

        cs = rgb[ly0:ly1, lx0:lx1]
        shape_a = alpha[ly0:ly1, lx0:lx1]
        opacity = min(1.0, max(0.0, _f(layer.get("opacity"), 1.0)))
        a = shape_a * opacity

        mode = layer.get("blend")
        mode = mode if mode in BLEND_MODES else "normal"
        cb = canvas[y0:y1, x0:x1]
        blended = _blend(cb, cs, mode)
        canvas[y0:y1, x0:x1] = cb * (1.0 - a[..., None]) + blended * a[..., None]
        covered[y0:y1, x0:x1] = 1.0 - (1.0 - covered[y0:y1, x0:x1]) * (1.0 - a)

        shape = np.zeros((height, width), bool)
        shape[y0:y1, x0:x1] = shape_a > 0.05
        shapes.append(shape)

    canvas = np.clip(canvas, 0.0, 1.0)
    covered = np.clip(covered, 0.0, 1.0)
    seam = _seam_mask(shapes, width, height, _f(seam_width, 32))
    return canvas, covered, 1.0 - covered, seam
