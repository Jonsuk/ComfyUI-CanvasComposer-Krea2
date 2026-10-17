import hashlib
import os

import numpy as np
import torch
from PIL import Image, ImageColor, ImageOps

import folder_paths

from .canvas_core import compose, parse_layers

SUBFOLDER = "canvas_composer"
NUM_INPUTS = 4


def _resolve_path(layer):
    """Map a layer to a file inside ComfyUI's input folder (blocks path escapes)."""
    base = os.path.realpath(folder_paths.get_input_directory())
    sub = layer.get("subfolder") or SUBFOLDER
    name = str(layer.get("file", ""))
    path = os.path.realpath(os.path.join(base, sub, name))
    if not path.startswith(base + os.sep):
        return None
    return path


def _tensor_to_pil(t):
    """First frame of an IMAGE tensor (B,H,W,C) -> PIL image."""
    arr = t[0].cpu().numpy() if hasattr(t[0], "cpu") else np.asarray(t[0])
    arr = np.clip(arr * 255.0, 0, 255).astype(np.uint8)
    if arr.shape[-1] == 1:
        arr = np.repeat(arr, 3, axis=-1)
    return Image.fromarray(arr)


class JOnsukCanvasComposer:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {f"image_{i}": ("IMAGE",) for i in range(1, NUM_INPUTS + 1)}
        optional["seam_width"] = ("INT", {"default": 32, "min": 0, "max": 512, "step": 2})
        return {
            "required": {
                "width": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "background": ("STRING", {"default": "#808080"}),
                "canvas_data": ("STRING", {"default": "[]", "multiline": True}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("IMAGE", "MASK", "MASK", "MASK")
    RETURN_NAMES = ("image", "covered_mask", "gap_mask", "seam_mask")
    FUNCTION = "compose"
    CATEGORY = "image/canvas"

    @classmethod
    def IS_CHANGED(cls, width, height, background, canvas_data, seam_width=32, **kwargs):
        h = hashlib.sha256()
        h.update(f"{width}|{height}|{background}|{canvas_data}|{seam_width}".encode())
        for layer in parse_layers(canvas_data):
            if layer.get("src") == "input":
                continue
            path = _resolve_path(layer)
            if path and os.path.isfile(path):
                h.update(str(os.path.getmtime(path)).encode())
        return h.hexdigest()

    def compose(self, width, height, background, canvas_data, seam_width=32, **kwargs):
        try:
            bg = ImageColor.getrgb((background or "").strip() or "#808080")[:3]
        except ValueError:
            bg = (128, 128, 128)

        # Optional image inputs -> PIL, plus small previews so the editor can show them.
        inputs, previews = {}, []
        for slot in range(1, NUM_INPUTS + 1):
            tensor = kwargs.get(f"image_{slot}")
            if tensor is None:
                continue
            pil = _tensor_to_pil(tensor)
            inputs[slot] = pil
            digest = hashlib.sha1(pil.tobytes()).hexdigest()[:10]
            name = f"canvas_composer_in{slot}_{digest}.png"
            path = os.path.join(folder_paths.get_temp_directory(), name)
            if not os.path.isfile(path):
                pil.save(path, compress_level=1)
            previews.append(
                {"slot": slot, "filename": name, "subfolder": "", "type": "temp", "w": pil.width, "h": pil.height}
            )

        def loader(layer):
            if layer.get("src") == "input":
                try:
                    slot = int(layer.get("slot", 0))
                except (TypeError, ValueError):
                    slot = 0
                img = inputs.get(slot)
                if img is None:
                    print(f"[CanvasComposer] input image_{slot} is not connected, layer skipped")
                return img
            path = _resolve_path(layer)
            if path is None or not os.path.isfile(path):
                print(f"[CanvasComposer] missing image, skipped: {layer.get('file')}")
                return None
            with Image.open(path) as im:
                return ImageOps.exif_transpose(im).convert("RGBA")

        image, covered, gap, seam = compose(width, height, bg, parse_layers(canvas_data), loader, seam_width)

        def to_image(a):
            return torch.from_numpy(np.ascontiguousarray(a, dtype=np.float32)).unsqueeze(0)

        result = (to_image(image), to_image(covered), to_image(gap), to_image(seam))
        return {"ui": {"canvas_inputs": previews}, "result": result}


NODE_CLASS_MAPPINGS = {"JOnsukCanvasComposer": JOnsukCanvasComposer}
NODE_DISPLAY_NAME_MAPPINGS = {"JOnsukCanvasComposer": "Canvas Composer"}
