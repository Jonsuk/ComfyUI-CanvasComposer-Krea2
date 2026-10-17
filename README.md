# Canvas Composer for ComfyUI

A standalone canvas node. Add images, arrange them on one canvas, cut, blend and tidy them,
then send the result to a KSampler (img2img) or an image-edit model to merge everything into
one picture. It fixes *where* each image sits, so the composition is yours and not left to
the model.

Built and tested with Krea 2, but the node only outputs a normal `IMAGE` and masks, so it works
with any model.


## Features

- Drag, scale (corner handles or mouse wheel), rotate, flip, opacity, layer order
- **Feather** (soft edges) and **gradient fade** per side
- **Blend modes:** normal, multiply, screen, overlay, soft light, darken, lighten, add
- **Colour:** brightness, contrast, saturation per layer
- **Crop** (drag the side handles) and **Remove** (circle something to cut it out of a layer; brush and restore brush too). Cuts are non-destructive and undoable
- Snap guides, align menu, lock layers, grid and rulers, zoom and pan, undo/redo
- Canvas size presets
- Optional `image_1` to `image_4` inputs, so other nodes can feed the canvas
- Outputs: `image`, `covered_mask`, `gap_mask`, `seam_mask`

## Install

**ComfyUI Manager:** open Manager > *Install via Git URL* and paste

```
https://github.com/Jonsuk/ComfyUI-CanvasComposer-Krea2
```

Restart ComfyUI afterwards.

**Manual:** download the zip (or clone the repository) so the folder lands in `ComfyUI/custom_nodes/`:

```
ComfyUI/custom_nodes/ComfyUI-CanvasComposer-Krea2/__init__.py
ComfyUI/custom_nodes/ComfyUI-CanvasComposer-Krea2/canvas_core.py
ComfyUI/custom_nodes/ComfyUI-CanvasComposer-Krea2/canvas_node.py
ComfyUI/custom_nodes/ComfyUI-CanvasComposer-Krea2/web/canvas_composer.js
```

Restart ComfyUI and hard-refresh the browser (Ctrl+Shift+R). The node is under
**image > canvas > Canvas Composer**. No extra Python packages are needed.

If you used a development copy of this node before, delete the old folder first. Two copies
will both try to load.

## Quick start

1. Add **Canvas Composer**, set the width and height (or pick a preset).
2. Click **+ Add image**, or drop / paste images onto the canvas.
3. Arrange them. Overlap the edges a little and use **Feather** or **Fade** so there is
   something to blend.
4. Connect `image` to **VAE Encode** (with your model's VAE), then to the KSampler's
   `latent_image`. Use a denoise below 1.0.
5. For edit models, also connect `image` to the edit text-encode node as the reference image.

## Outputs

| Output | What it is |
|---|---|
| `image` | the flattened canvas |
| `covered_mask` | 1 where images are, 0 elsewhere |
| `gap_mask` | the opposite: empty areas, including anything you cut out |
| `seam_mask` | a soft band along the borders between images and gaps (`seam_width` sets its width, 0 = off) |

## Controls

| Action | How |
|---|---|
| Move | drag a layer |
| Scale | drag a corner handle, or mouse wheel |
| Zoom the view | Ctrl + wheel |
| Pan the view | middle-drag, or Space + drag. Double-click empty space to reset |
| Bypass snapping | hold Alt while dragging |
| Nudge | arrow keys (Shift = 10 px) |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Duplicate / delete | Ctrl+D / Del |
| Rename a layer | double-click its name in the list |

## Image inputs

Connect images to `image_1`..`image_4`, press **+ Inputs**, and run the workflow once so the
previews appear. After that you can arrange them like any other layer.

## Notes and limits

- Uploaded images are stored in `ComfyUI/input/canvas_composer/`. Delete files there to free space.
- Previews of feather, fade, colour and blend use your browser's canvas. The final output is
  computed in Python and is the reference; small differences from the preview are possible.
- `seam_mask` is computed at reduced resolution and softened on purpose.
- Frame batches are not supported: only the first frame of each input is used.

## Example workflow

`Canvas_Composer_Krea2_example.json` blends three scenes with Krea 2 and an edit-model text
encode (`TextEncodeQwenImageEditPlus`). The canvas goes to the encoder as the main reference, and
two optional reference images (for example characters) go in as `image2` and `image3`.

To use it: pick your own models in the loader nodes, add your images in the canvas, choose your
reference images in the two Load Image nodes (or delete them), and describe each area
(left / centre / right) in the prompt. Tips are in the notes inside the workflow. It uses core
ComfyUI nodes plus this one. Upscaling, LoRAs and other extras were removed to keep it simple.

## Links

Source and issues: https://github.com/Jonsuk/ComfyUI-CanvasComposer-Krea2

## Credits and licence

Written with AI assistance (Claude, by Anthropic) and tested by the author. MIT licence, see `LICENSE`.
