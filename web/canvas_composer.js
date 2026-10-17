import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Canvas Composer v2 - editor widget.
// Every effect drawn here has a matching implementation in canvas_core.py. Keep them in sync.

const NODE_CLASSES = new Set(["JOnsukCanvasComposer"]);
const SUBFOLDER = "canvas_composer";
const NUM_INPUTS = 4;
const MAX_HISTORY = 60;
const CHROME_FALLBACK = 380; // estimated height of toolbars/panels/list before they are measured
const MIN_VIEWPORT_H = 260;

const BLEND = [
  ["normal", "Normal", "source-over"],
  ["multiply", "Multiply", "multiply"],
  ["screen", "Screen", "screen"],
  ["overlay", "Overlay", "overlay"],
  ["soft_light", "Soft light", "soft-light"],
  ["darken", "Darken", "darken"],
  ["lighten", "Lighten", "lighten"],
  ["add", "Add", "lighter"],
];
const SIZE_PRESETS = [
  [1344, 768], [768, 1344], [1216, 832], [832, 1216], [1024, 1024],
  [1152, 896], [896, 1152], [1536, 640], [1280, 720], [1920, 1088],
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const uid = () => Math.random().toString(36).slice(2, 10);
const round4 = (v) => Math.round(v * 10000) / 10000;

function el(tag, styles = {}, props = {}) {
  const e = document.createElement(tag);
  Object.assign(e.style, styles);
  Object.assign(e, props);
  return e;
}

function imageURL(layer) {
  const params = new URLSearchParams({
    filename: layer.file,
    type: "input",
    subfolder: layer.subfolder || SUBFOLDER,
  });
  return api.apiURL("/view?" + params.toString());
}

async function uploadImage(file) {
  const body = new FormData();
  body.append("image", file);
  body.append("type", "input");
  body.append("subfolder", SUBFOLDER);
  body.append("overwrite", "false");
  const resp = await api.fetchApi("/upload/image", { method: "POST", body });
  if (resp.status !== 200) throw new Error(`Upload failed: ${resp.status} ${resp.statusText}`);
  return await resp.json(); // { name, subfolder, type }
}

function hideWidget(w) {
  w.hidden = true;
  w.computeSize = () => [0, -4];
  if (w.element) w.element.style.display = "none";
}

function safeColor(value) {
  const probe = new Option().style;
  probe.color = value || "";
  return probe.color ? value : "#808080";
}

function normalizeLayer(L, W, H) {
  L.id = L.id || uid();
  L.src = L.src === "input" ? "input" : "file";
  L.subfolder = L.subfolder || SUBFOLDER;
  L.slot = num(L.slot, 0);
  L.w = num(L.w, 512) > 0 ? num(L.w, 512) : 512;
  L.h = num(L.h, 512) > 0 ? num(L.h, 512) : 512;
  L.x = num(L.x, W / 2);
  L.y = num(L.y, H / 2);
  L.scale = clamp(num(L.scale, 1), 0.001, 50);
  L.rot = num(L.rot, 0);
  L.opacity = clamp(num(L.opacity, 1), 0, 1);
  L.flip = !!L.flip;
  L.visible = L.visible !== false;
  L.locked = !!L.locked;
  L.blend = BLEND.some((b) => b[0] === L.blend) ? L.blend : "normal";
  L.feather = Math.max(0, num(L.feather, 0));
  const fade = L.fade && typeof L.fade === "object" ? L.fade : {};
  L.fade = { l: Math.max(0, num(fade.l)), r: Math.max(0, num(fade.r)), t: Math.max(0, num(fade.t)), b: Math.max(0, num(fade.b)) };
  const crop = L.crop && typeof L.crop === "object" ? L.crop : {};
  L.crop = { l: Math.max(0, num(crop.l)), t: Math.max(0, num(crop.t)), r: Math.max(0, num(crop.r)), b: Math.max(0, num(crop.b)) };
  const color = L.color && typeof L.color === "object" ? L.color : {};
  L.color = { b: num(color.b), c: num(color.c), s: num(color.s) };
  L.cuts = Array.isArray(L.cuts) ? L.cuts : [];
  L.label = L.label || L.file || `Input ${L.slot}`;
  return L;
}

const cropSize = (L) => ({
  cw: Math.max(1, L.w - L.crop.l - L.crop.r),
  ch: Math.max(1, L.h - L.crop.t - L.crop.b),
});
const halfSize = (L) => {
  const { cw, ch } = cropSize(L);
  return { hw: (cw * L.scale) / 2, hh: (ch * L.scale) / 2 };
};
function bboxAt(L, x, y) {
  const { hw, hh } = halfSize(L);
  const r = (L.rot * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const ex = Math.abs(hw * c) + Math.abs(hh * s);
  const ey = Math.abs(hw * s) + Math.abs(hh * c);
  return { l: x - ex, r: x + ex, t: y - ey, b: y + ey, cx: x, cy: y };
}
function toLocal(L, p) {
  const r = (L.rot * Math.PI) / 180;
  const dx = p.x - L.x;
  const dy = p.y - L.y;
  return { x: dx * Math.cos(r) + dy * Math.sin(r), y: -dx * Math.sin(r) + dy * Math.cos(r) };
}
// project coords -> normalised source-image coords (0..1), undoing rotation, flip and crop
function srcFromProject(L, p) {
  const l = toLocal(L, p);
  let x = l.x / L.scale;
  const y = l.y / L.scale;
  if (L.flip) x = -x;
  const { cw, ch } = cropSize(L);
  return [(L.crop.l + cw / 2 + x) / L.w, (L.crop.t + ch / 2 + y) / L.h];
}
const colorFilter = (c) => {
  const parts = [];
  if (c.b) parts.push(`brightness(${Math.max(0, 1 + c.b / 100)})`);
  if (c.c) parts.push(`contrast(${Math.max(0, 1 + c.c / 100)})`);
  if (c.s) parts.push(`saturate(${Math.max(0, 1 + c.s / 100)})`);
  return parts.join(" ");
};

function setupNode(node) {
  const byName = (n) => node.widgets.find((w) => w.name === n);
  const dataW = byName("canvas_data");
  const wW = byName("width");
  const hW = byName("height");
  const bgW = byName("background");
  if (!dataW || !wW || !hW || !bgW) return;
  hideWidget(dataW);

  const W = () => Number(wW.value) || 1024;
  const H = () => Number(hW.value) || 1024;

  const state = {
    layers: [],
    sel: -1,
    tool: null, // null | "crop" | "remove"
    removeMode: "lasso", // lasso | brush | restore
    brushSize: 40,
    mark: null,
    drag: null,
    guides: [],
    inputs: {},
    rcache: new Map(),
    snap: true,
    grid: false,
    space: false,
  };
  const view = { zoom: 1, panX: 0, panY: 0 };
  const hist = { stack: [], idx: -1 };
  const imgCache = new Map();
  const controls = [];
  let vw = 0;
  let vh = 0;

  const sel = () => state.layers[state.sel] || null;
  const json = () => JSON.stringify(state.layers, (k, v) => (k[0] === "_" ? undefined : v));

  // ------------------------------------------------------------------ UI skeleton
  const root = el("div", {
    display: "flex", flexDirection: "column", gap: "4px", width: "100%", height: "100%",
    boxSizing: "border-box", fontSize: "11px", userSelect: "none", color: "var(--input-text, #ddd)",
  });
  const btnCss = {
    padding: "2px 7px", cursor: "pointer", fontSize: "11px", background: "var(--comfy-input-bg, #222)",
    color: "var(--input-text, #ddd)", border: "1px solid var(--border-color, #444)", borderRadius: "4px",
  };
  const selCss = { ...btnCss, padding: "1px 3px" };
  const rowCss = { display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" };

  const toggles = {};
  const mkBtn = (label, title, onClick, toggleKey) => {
    const b = el("button", btnCss, { textContent: label, title, type: "button" });
    b.addEventListener("click", (e) => { e.preventDefault(); onClick(e); });
    if (toggleKey) toggles[toggleKey] = b;
    return b;
  };
  const mkSelect = (options, title, onChange) => {
    const s = el("select", selCss, { title });
    for (const [value, label] of options) s.append(el("option", {}, { value, textContent: label }));
    s.addEventListener("change", () => onChange(s.value, s));
    return s;
  };
  const mkCheck = (label, title, checked, onChange) => {
    const wrap = el("label", { display: "flex", alignItems: "center", gap: "3px", cursor: "pointer" }, { title });
    const box = el("input", {}, { type: "checkbox", checked });
    box.addEventListener("change", () => onChange(box.checked));
    wrap.append(box, document.createTextNode(label));
    return wrap;
  };

  const fileInput = el("input", { display: "none" }, { type: "file", accept: "image/*", multiple: true });
  fileInput.addEventListener("change", async () => {
    await addFiles(fileInput.files);
    fileInput.value = "";
  });

  const rowA = el("div", rowCss);
  rowA.append(
    mkBtn("+ Add image", "Upload and add image(s). You can also drop or paste images onto the canvas.", () => fileInput.click()),
    mkBtn("+ Inputs", "Add the image_1..image_4 node inputs as layers (run the workflow once to preview them)", addInputLayers),
    mkBtn("Duplicate", "Duplicate selected layer (Ctrl+D)", duplicateSelected),
    mkBtn("Delete", "Delete selected layer (Del)", deleteSelected),
    mkBtn("Up", "Bring forward", () => moveLayer(1)),
    mkBtn("Down", "Send backward", () => moveLayer(-1)),
    mkBtn("Undo", "Undo (Ctrl+Z)", undo),
    mkBtn("Redo", "Redo (Ctrl+Y)", redo),
    fileInput
  );

  const alignSel = mkSelect(
    [["", "Align..."], ["left", "Left edge"], ["center", "Centre"], ["right", "Right edge"], ["top", "Top edge"], ["middle", "Middle"], ["bottom", "Bottom edge"]],
    "Align the selected layer to the canvas",
    (v, s) => { if (v) alignSelected(v); s.value = ""; }
  );
  const rowB = el("div", rowCss);
  rowB.append(
    mkBtn("Flip", "Mirror horizontally", flipSelected),
    mkBtn("Fit", "Scale to fit inside the canvas", () => fitSelected(false)),
    mkBtn("Fill", "Scale to cover the whole canvas", () => fitSelected(true)),
    alignSel,
    mkBtn("Crop", "Crop the selected layer by dragging its side handles", () => setTool("crop"), "crop"),
    mkBtn("Remove", "Circle something to cut it out of the layer", () => setTool("remove"), "remove"),
    mkBtn("Lock", "Lock the selected layer so it can't be moved by accident", toggleLock, "lock")
  );

  const presetSel = mkSelect(
    [["", "Canvas size..."], ...SIZE_PRESETS.map(([w, h]) => [`${w}x${h}`, `${w} x ${h}`]), ["first", "Aspect of first layer (~1MP)"]],
    "Set the canvas size",
    (v, s) => { if (v) applyPreset(v); s.value = ""; }
  );
  const rowC = el("div", rowCss);
  rowC.append(
    presetSel,
    mkCheck("Snap", "Snap to canvas edges, centre and other layers (hold Alt to bypass)", true, (v) => { state.snap = v; }),
    mkCheck("Grid", "Show grid and rulers", false, (v) => { state.grid = v; draw(); }),
    mkBtn("Reset view", "Reset zoom and pan (also: double-click empty space)", resetView)
  );

  const toolOpts = el("div", { ...rowCss, display: "none" });

  const viewport = el("div", {
    position: "relative", flex: "1 1 auto", minHeight: MIN_VIEWPORT_H + "px", overflow: "hidden",
    border: "1px solid var(--border-color, #444)", borderRadius: "4px", background: "#161616",
  });
  const cv = el("canvas", { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", outline: "none", touchAction: "none" }, { tabIndex: 0 });
  viewport.append(cv);
  const ctx = cv.getContext("2d");

  // properties panel with tabs
  const panel = el("div", { border: "1px solid var(--border-color, #444)", borderRadius: "4px", padding: "3px 5px", boxSizing: "border-box" });
  const tabBar = el("div", { display: "flex", gap: "4px", marginBottom: "3px" });
  const tabBodies = {};
  const tabBtns = {};
  const BODY_H = 78;
  function addTab(id, label) {
    const b = el("button", { ...btnCss, padding: "1px 9px" }, { textContent: label, type: "button" });
    b.addEventListener("click", () => showTab(id));
    const body = el("div", { height: BODY_H + "px", overflowY: "auto", display: "none", flexDirection: "column", gap: "2px" });
    tabBar.append(b);
    tabBodies[id] = body;
    tabBtns[id] = b;
    return body;
  }
  function showTab(id) {
    for (const k of Object.keys(tabBodies)) {
      tabBodies[k].style.display = k === id ? "flex" : "none";
      tabBtns[k].style.background = k === id ? "var(--comfy-menu-bg, #353535)" : btnCss.background;
    }
  }
  function mkSlider(parent, label, min, max, step, get, set, unit = "") {
    const row = el("div", { display: "flex", alignItems: "center", gap: "6px" });
    const lab = el("span", { width: "62px", flex: "none" }, { textContent: label });
    const input = el("input", { flex: "1", minWidth: "0" }, { type: "range", min, max, step, value: 0 });
    const val = el("span", { width: "46px", textAlign: "right", flex: "none", opacity: "0.8" });
    input.addEventListener("input", () => {
      const L = sel();
      if (!L) return;
      set(L, Number(input.value));
      val.textContent = input.value + unit;
      draw();
      writeWidget();
    });
    input.addEventListener("change", () => commit());
    row.append(lab, input, val);
    parent.append(row);
    controls.push({ input, val, get, unit });
  }
  const layerTab = addTab("layer", "Layer");
  const edgesTab = addTab("edges", "Edges");
  const colorTab = addTab("color", "Colour");
  mkSlider(layerTab, "Opacity", 0, 100, 1, (L) => Math.round(L.opacity * 100), (L, v) => { L.opacity = v / 100; }, "%");
  mkSlider(layerTab, "Rotate", -180, 180, 1, (L) => Math.round(L.rot), (L, v) => { L.rot = v; }, "\u00B0");
  const blendRow = el("div", { display: "flex", alignItems: "center", gap: "6px" });
  const blendSel = mkSelect(BLEND.map(([k, label]) => [k, label]), "Blend mode", (v) => {
    const L = sel();
    if (!L) return;
    L.blend = v;
    draw();
    commit();
  });
  blendRow.append(el("span", { width: "62px", flex: "none" }, { textContent: "Blend" }), blendSel);
  layerTab.append(blendRow);
  mkSlider(edgesTab, "Feather", 0, 300, 1, (L) => L.feather, (L, v) => { L.feather = v; }, "px");
  mkSlider(edgesTab, "Fade left", 0, 800, 1, (L) => L.fade.l, (L, v) => { L.fade.l = v; }, "px");
  mkSlider(edgesTab, "Fade right", 0, 800, 1, (L) => L.fade.r, (L, v) => { L.fade.r = v; }, "px");
  mkSlider(edgesTab, "Fade top", 0, 800, 1, (L) => L.fade.t, (L, v) => { L.fade.t = v; }, "px");
  mkSlider(edgesTab, "Fade bottom", 0, 800, 1, (L) => L.fade.b, (L, v) => { L.fade.b = v; }, "px");
  mkSlider(colorTab, "Brightness", -100, 100, 1, (L) => L.color.b, (L, v) => { L.color.b = v; });
  mkSlider(colorTab, "Contrast", -100, 100, 1, (L) => L.color.c, (L, v) => { L.color.c = v; });
  mkSlider(colorTab, "Saturation", -100, 100, 1, (L) => L.color.s, (L, v) => { L.color.s = v; });
  colorTab.append(mkBtn("Reset colour", "Reset brightness, contrast and saturation", () => {
    const L = sel();
    if (!L) return;
    L.color = { b: 0, c: 0, s: 0 };
    syncControls();
    draw();
    commit();
  }));
  panel.append(tabBar, layerTab, edgesTab, colorTab);

  const listEl = el("div", {
    height: "112px", overflowY: "auto", border: "1px solid var(--border-color, #444)", borderRadius: "4px", boxSizing: "border-box",
  });
  const readout = el("div", { opacity: "0.75", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minHeight: "14px" });

  root.append(rowA, rowB, rowC, toolOpts, viewport, panel, listEl, readout);

  const chromeH = () => {
    const measured = [rowA, rowB, rowC, toolOpts, panel, listEl, readout].reduce((s, e) => s + (e.offsetHeight || 0), 0) + 28;
    return Math.max(CHROME_FALLBACK, measured);
  };

  // ------------------------------------------------------------------ persistence + history
  function writeWidget() {
    dataW.value = json();
    dataW.callback?.(dataW.value);
    app.graph?.setDirtyCanvas?.(true, true);
  }
  function commit() {
    const snap = json();
    if (snap !== hist.stack[hist.idx]) {
      hist.stack.splice(hist.idx + 1);
      hist.stack.push(snap);
      if (hist.stack.length > MAX_HISTORY) hist.stack.shift();
      hist.idx = hist.stack.length - 1;
    }
    writeWidget();
    refreshList();
    syncControls();
    updateReadout();
  }
  function restore(snapshot) {
    const selId = sel()?.id;
    try {
      const parsed = JSON.parse(snapshot);
      state.layers = (Array.isArray(parsed) ? parsed : []).map((L) => normalizeLayer(L, W(), H()));
    } catch {
      state.layers = [];
    }
    state.rcache.clear();
    state.sel = state.layers.findIndex((L) => L.id === selId);
    writeWidget();
    refreshList();
    syncControls();
    updateReadout();
    draw();
  }
  function undo() {
    if (hist.idx > 0) restore(hist.stack[--hist.idx]);
  }
  function redo() {
    if (hist.idx < hist.stack.length - 1) restore(hist.stack[++hist.idx]);
  }
  function resetHistory() {
    hist.stack = [json()];
    hist.idx = 0;
  }
  function sanitizeNumbers() {
    for (const [name, fallback] of [["width", 1024], ["height", 1024], ["seam_width", 32]]) {
      const w = byName(name);
      if (w && !(typeof w.value === "number" && Number.isFinite(w.value))) {
        const n = Number(w.value);
        w.value = w.value !== "" && w.value !== null && Number.isFinite(n) ? n : fallback;
      }
    }
  }
  function loadFromWidget() {
    sanitizeNumbers();
    try {
      const parsed = JSON.parse(dataW.value || "[]");
      state.layers = (Array.isArray(parsed) ? parsed : []).map((L) => normalizeLayer(L, W(), H()));
    } catch {
      state.layers = [];
    }
    state.sel = -1;
    state.rcache.clear();
    resetHistory();
    refreshList();
    syncControls();
    updateReadout();
    draw();
  }

  // ------------------------------------------------------------------ images
  function getRec(L) {
    let url;
    let key;
    if (L.src === "input") {
      const inp = state.inputs[L.slot];
      if (!inp) return { ok: false, wait: true };
      url = inp.url;
      key = `in:${L.slot}:${inp.key}`;
    } else {
      url = imageURL(L);
      key = `${L.subfolder}/${L.file}`;
    }
    let rec = imgCache.get(key);
    if (!rec) {
      const img = new Image();
      rec = { img, ok: false, err: false, ver: 1 };
      img.onload = () => { rec.ok = true; rec.ver++; draw(); };
      img.onerror = () => { rec.err = true; draw(); };
      img.src = url;
      imgCache.set(key, rec);
    }
    return rec;
  }

  // Render the layer's own pixels (crop, colour, cuts, flip, feather/fade) once; cached.
  function getLayerCanvas(L, rec, pf) {
    const { cw, ch } = cropSize(L);
    const sig = [L.scale, L.crop.l, L.crop.t, L.crop.r, L.crop.b, L.flip, L.cuts.length, L.feather, L.fade.l, L.fade.r, L.fade.t, L.fade.b, L.color.b, L.color.c, L.color.s, pf, L.w, L.h, rec.ver].join("|");
    const hit = state.rcache.get(L.id);
    if (hit && hit.sig === sig) return hit.canvas;

    const sw = cw * L.scale;
    const sh = ch * L.scale;
    const k = Math.min(pf, 4096 / Math.max(sw, sh));
    const pw = Math.max(1, Math.round(sw * k));
    const ph = Math.max(1, Math.round(sh * k));
    const mk = () => { const c = document.createElement("canvas"); c.width = pw; c.height = ph; return c; };

    let out = mk();
    let g = out.getContext("2d");
    const f = colorFilter(L.color);
    if (f) g.filter = f;
    g.drawImage(rec.img, L.crop.l, L.crop.t, cw, ch, 0, 0, pw, ph);
    g.filter = "none";

    if (L.cuts.length) {
      const m = mk();
      drawCuts(m.getContext("2d"), L, pw, ph, cw, ch);
      g.globalCompositeOperation = "destination-out";
      g.drawImage(m, 0, 0);
      g.globalCompositeOperation = "source-over";
    }
    if (L.flip) {
      const flipped = mk();
      const fg = flipped.getContext("2d");
      fg.translate(pw, 0);
      fg.scale(-1, 1);
      fg.drawImage(out, 0, 0);
      out = flipped;
      g = fg;
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    const fe = Math.min(L.feather, Math.min(sw, sh) - 2);
    const hasFade = L.fade.l > 0 || L.fade.r > 0 || L.fade.t > 0 || L.fade.b > 0;
    if (fe >= 1 || hasFade) {
      const m = mk();
      const mg = m.getContext("2d");
      mg.fillStyle = "#fff";
      if (fe >= 1) {
        const inset = (fe / 2) * k;
        mg.filter = `blur(${(fe / 4) * k}px)`;
        mg.fillRect(inset, inset, pw - 2 * inset, ph - 2 * inset);
        mg.filter = "none";
      } else {
        mg.fillRect(0, 0, pw, ph);
      }
      mg.globalCompositeOperation = "destination-in";
      const ramp = (x0, y0, x1, y1) => {
        const gr = mg.createLinearGradient(x0, y0, x1, y1);
        gr.addColorStop(0, "rgba(0,0,0,0)");
        gr.addColorStop(1, "rgba(0,0,0,1)");
        mg.fillStyle = gr;
        mg.fillRect(0, 0, pw, ph);
      };
      if (L.fade.l > 0) ramp(0, 0, L.fade.l * k, 0);
      if (L.fade.r > 0) ramp(pw, 0, pw - L.fade.r * k, 0);
      if (L.fade.t > 0) ramp(0, 0, 0, L.fade.t * k);
      if (L.fade.b > 0) ramp(0, ph, 0, ph - L.fade.b * k);
      const og = out.getContext("2d");
      og.globalCompositeOperation = "destination-in";
      og.drawImage(m, 0, 0);
      og.globalCompositeOperation = "source-over";
    }
    state.rcache.set(L.id, { sig, canvas: out });
    return out;
  }

  function drawCuts(g, L, pw, ph, cw, ch) {
    const kx = pw / cw;
    const ky = ph / ch;
    const P = (p) => [(p[0] * L.w - L.crop.l) * kx, (p[1] * L.h - L.crop.t) * ky];
    g.fillStyle = "#fff";
    g.strokeStyle = "#fff";
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const c of L.cuts) {
      if (!c || !Array.isArray(c.pts) || !c.pts.length) continue;
      g.globalCompositeOperation = c.op === "restore" ? "destination-out" : "source-over";
      const pts = c.pts.map(P);
      if (c.kind === "poly") {
        if (pts.length < 3) continue;
        g.beginPath();
        pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.fill();
      } else {
        g.lineWidth = Math.max(1, (c.size || 0.02) * Math.max(L.w, L.h) * kx);
        g.beginPath();
        if (pts.length === 1) {
          g.arc(pts[0][0], pts[0][1], g.lineWidth / 2, 0, Math.PI * 2);
          g.fill();
        } else {
          pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.stroke();
        }
      }
    }
    g.globalCompositeOperation = "source-over";
  }

  // ------------------------------------------------------------------ view math
  function metrics() {
    const margin = state.grid ? 20 : 12;
    const fit = Math.max(0.01, Math.min((vw - 2 * margin) / W(), (vh - 2 * margin) / H()));
    const ps = fit * view.zoom;
    return { ps, ox: (vw - W() * ps) / 2 + view.panX, oy: (vh - H() * ps) / 2 + view.panY, fit };
  }
  function toProject(e) {
    const r = cv.getBoundingClientRect();
    const sx = r.width ? vw / r.width : 1;
    const sy = r.height ? vh / r.height : 1;
    const px = (e.clientX - r.left) * sx;
    const py = (e.clientY - r.top) * sy;
    const m = metrics();
    return { x: (px - m.ox) / m.ps, y: (py - m.oy) / m.ps, px, py };
  }
  function resetView() {
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    draw();
    updateReadout();
  }

  // ------------------------------------------------------------------ drawing
  function draw() {
    if (!vw || !vh) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(vw * dpr));
    const bh = Math.max(1, Math.round(vh * dpr));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;

    const { ps, ox, oy } = metrics();
    const Wp = W();
    const Hp = H();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, bw, bh);
    ctx.fillStyle = "#161616";
    ctx.fillRect(0, 0, bw, bh);

    ctx.setTransform(dpr * ps, 0, 0, dpr * ps, dpr * ox, dpr * oy);
    ctx.fillStyle = safeColor(bgW.value);
    ctx.fillRect(0, 0, Wp, Hp);

    const pfRaw = dpr * ps;
    const pf = Math.pow(1.25, Math.round(Math.log(pfRaw) / Math.log(1.25)));

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, Wp, Hp);
    ctx.clip();
    for (const L of state.layers) {
      if (!L.visible) continue;
      const rec = getRec(L);
      if (rec.ok) {
        if (rec.img.naturalWidth && (L.w !== rec.img.naturalWidth || L.h !== rec.img.naturalHeight) && L.src === "file") {
          L.w = rec.img.naturalWidth;
          L.h = rec.img.naturalHeight;
        }
        const lc = getLayerCanvas(L, rec, pf);
        const { hw, hh } = halfSize(L);
        ctx.save();
        ctx.globalAlpha = L.opacity;
        ctx.globalCompositeOperation = BLEND.find((b) => b[0] === L.blend)?.[2] || "source-over";
        ctx.translate(L.x, L.y);
        ctx.rotate((L.rot * Math.PI) / 180);
        ctx.drawImage(lc, -hw, -hh, hw * 2, hh * 2);
        ctx.restore();
      } else {
        const { hw, hh } = halfSize(L);
        ctx.save();
        ctx.translate(L.x, L.y);
        ctx.rotate((L.rot * Math.PI) / 180);
        ctx.strokeStyle = rec.err ? "#e55" : "#888";
        ctx.lineWidth = 2 / ps;
        ctx.setLineDash([8 / ps, 6 / ps]);
        ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
        ctx.setLineDash([]);
        ctx.fillStyle = "#aaa";
        ctx.font = `${12 / ps}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(rec.wait ? "Run the workflow once to preview" : rec.err ? "Image missing" : "Loading...", 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();

    if (state.grid) drawGrid(ps);

    // snap guides
    if (state.guides.length) {
      ctx.save();
      ctx.strokeStyle = "#ff3df0";
      ctx.lineWidth = 1 / ps;
      for (const gd of state.guides) {
        ctx.beginPath();
        if (gd.axis === "x") { ctx.moveTo(gd.v, 0); ctx.lineTo(gd.v, Hp); } else { ctx.moveTo(0, gd.v); ctx.lineTo(Wp, gd.v); }
        ctx.stroke();
      }
      ctx.restore();
    }

    // selection box + handles
    const S = sel();
    if (S && S.visible) {
      const { hw, hh } = halfSize(S);
      const hs = 6 / ps;
      ctx.save();
      ctx.translate(S.x, S.y);
      ctx.rotate((S.rot * Math.PI) / 180);
      ctx.lineWidth = 2 / ps;
      ctx.strokeStyle = S.locked ? "#e0a030" : state.tool === "crop" ? "#40d080" : "#4a9eff";
      ctx.setLineDash([]);
      ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
      if (!S.locked) {
        ctx.fillStyle = "#fff";
        if (state.tool === "crop") {
          for (const [cx, cy, sw2, sh2] of [[0, -hh, 2.6, 1.1], [0, hh, 2.6, 1.1], [-hw, 0, 1.1, 2.6], [hw, 0, 1.1, 2.6]]) {
            ctx.fillRect(cx - hs * sw2, cy - hs * sh2, hs * sw2 * 2, hs * sh2 * 2);
            ctx.strokeRect(cx - hs * sw2, cy - hs * sh2, hs * sw2 * 2, hs * sh2 * 2);
          }
        } else if (!state.tool) {
          for (const [cx, cy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
            ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2);
            ctx.strokeRect(cx - hs, cy - hs, hs * 2, hs * 2);
          }
        }
      }
      ctx.restore();
    }

    // Remove tool: live red marking
    if (state.mark && state.mark.pts.length) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const pts = state.mark.pts;
      if (state.mark.mode === "lasso") {
        ctx.fillStyle = "rgba(255,0,0,0.35)";
        ctx.strokeStyle = "#ff2020";
        ctx.lineWidth = 2 / ps;
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.strokeStyle = state.mark.mode === "restore" ? "rgba(40,200,120,0.55)" : "rgba(255,0,0,0.5)";
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = state.brushSize;
        ctx.beginPath();
        if (pts.length === 1) {
          ctx.arc(pts[0].x, pts[0].y, state.brushSize / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // canvas outline
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1 / ps;
    ctx.strokeRect(0, 0, Wp, Hp);
    ctx.restore();

    if (state.grid) drawRulers(dpr, ps, ox, oy);
  }

  const STEPS = [8, 16, 32, 64, 128, 256, 512, 1024, 2048];
  function drawGrid(ps) {
    const step = STEPS.find((s) => s * ps >= 28) || 4096;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.13)";
    ctx.lineWidth = 1 / ps;
    ctx.beginPath();
    for (let x = step; x < W(); x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H()); }
    for (let y = step; y < H(); y += step) { ctx.moveTo(0, y); ctx.lineTo(W(), y); }
    ctx.stroke();
    ctx.restore();
  }
  function drawRulers(dpr, ps, ox, oy) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "rgba(24,24,24,0.9)";
    ctx.fillRect(0, 0, vw, 16);
    ctx.fillRect(0, 0, 16, vh);
    ctx.fillStyle = "#aaa";
    ctx.strokeStyle = "#777";
    ctx.lineWidth = 1;
    ctx.font = "9px sans-serif";
    const step = STEPS.find((s) => s * ps >= 60) || 4096;
    for (let v = Math.floor(-ox / ps / step) * step; v * ps + ox < vw; v += step) {
      const x = ox + v * ps;
      if (x < 16) continue;
      ctx.beginPath(); ctx.moveTo(x, 9); ctx.lineTo(x, 16); ctx.stroke();
      ctx.fillText(String(v), x + 2, 9);
    }
    for (let v = Math.floor(-oy / ps / step) * step; v * ps + oy < vh; v += step) {
      const y = oy + v * ps;
      if (y < 16) continue;
      ctx.beginPath(); ctx.moveTo(9, y); ctx.lineTo(16, y); ctx.stroke();
      ctx.fillText(String(v), 1, y - 2);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ hit testing
  function hitLayer(p) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const L = state.layers[i];
      if (!L.visible || L.locked) continue;
      const l = toLocal(L, p);
      const { hw, hh } = halfSize(L);
      if (Math.abs(l.x) <= hw && Math.abs(l.y) <= hh) return i;
    }
    return -1;
  }
  const near = (a, b, r) => Math.abs(a[0] - b[0]) < r && Math.abs(a[1] - b[1]) < r;
  function hitCorner(L, p, ps) {
    const l = toLocal(L, p);
    const { hw, hh } = halfSize(L);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].some((c) => near([l.x, l.y], c, 11 / ps));
  }
  function hitSide(L, p, ps) {
    const l = toLocal(L, p);
    const { hw, hh } = halfSize(L);
    const r = 12 / ps;
    if (near([l.x, l.y], [0, -hh], r) || (Math.abs(l.y + hh) < r && Math.abs(l.x) < hw * 0.5)) return "t";
    if (near([l.x, l.y], [0, hh], r) || (Math.abs(l.y - hh) < r && Math.abs(l.x) < hw * 0.5)) return "b";
    if (near([l.x, l.y], [-hw, 0], r) || (Math.abs(l.x + hw) < r && Math.abs(l.y) < hh * 0.5)) return "l";
    if (near([l.x, l.y], [hw, 0], r) || (Math.abs(l.x - hw) < r && Math.abs(l.y) < hh * 0.5)) return "r";
    return null;
  }

  // ------------------------------------------------------------------ snapping
  function snapPosition(L, nx, ny, ps) {
    state.guides = [];
    if (!state.snap) return [nx, ny];
    const thr = 8 / ps;
    const b = bboxAt(L, nx, ny);
    const xs = [0, W() / 2, W()];
    const ys = [0, H() / 2, H()];
    for (const O of state.layers) {
      if (O === L || !O.visible) continue;
      const ob = bboxAt(O, O.x, O.y);
      xs.push(ob.l, ob.cx, ob.r);
      ys.push(ob.t, ob.cy, ob.b);
    }
    const best = (vals, targets) => {
      let bd = null;
      let bt = null;
      for (const v of vals) for (const t of targets) {
        const d = t - v;
        if (Math.abs(d) < thr && (bd === null || Math.abs(d) < Math.abs(bd))) { bd = d; bt = t; }
      }
      return [bd, bt];
    };
    const [dx, tx] = best([b.l, b.cx, b.r], xs);
    const [dy, ty] = best([b.t, b.cy, b.b], ys);
    if (dx !== null) { nx += dx; state.guides.push({ axis: "x", v: tx }); }
    if (dy !== null) { ny += dy; state.guides.push({ axis: "y", v: ty }); }
    return [nx, ny];
  }

  // ------------------------------------------------------------------ selection + list
  function select(i) {
    state.sel = i;
    refreshList();
    syncControls();
    updateReadout();
    draw();
  }
  function syncControls() {
    const L = sel();
    for (const c of controls) {
      c.input.disabled = !L;
      const v = L ? c.get(L) : 0;
      c.input.value = v;
      c.val.textContent = v + c.unit;
    }
    blendSel.disabled = !L;
    blendSel.value = L ? L.blend : "normal";
    if (toggles.lock) {
      toggles.lock.textContent = L && L.locked ? "Unlock" : "Lock";
      toggles.lock.style.background = L && L.locked ? "#6b4a10" : btnCss.background;
    }
    for (const k of ["crop", "remove"]) if (toggles[k]) toggles[k].style.background = state.tool === k ? "#1f6b45" : btnCss.background;
  }
  function updateReadout(extra = "") {
    const L = sel();
    let t = `${W()}\u00D7${H()}  \u2022  zoom ${Math.round(view.zoom * 100)}%`;
    if (L) {
      const { cw, ch } = cropSize(L);
      t = `${L.label}  \u2022  x ${Math.round(L.x)}  y ${Math.round(L.y)}  \u2022  ${Math.round(cw * L.scale)}\u00D7${Math.round(ch * L.scale)}  \u2022  ${Math.round(L.scale * 100)}%  \u2022  ${Math.round(L.rot)}\u00B0   |   ` + t;
    }
    readout.textContent = extra ? extra + "   |   " + t : t;
  }
  function refreshList() {
    listEl.replaceChildren();
    if (!state.layers.length) {
      listEl.append(el("div", { padding: "6px", opacity: "0.6" }, { textContent: "Drop images here, paste, or click + Add image" }));
      return;
    }
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const L = state.layers[i];
      const row = el("div", {
        display: "flex", alignItems: "center", gap: "6px", padding: "2px 6px", height: "30px", boxSizing: "border-box", cursor: "pointer",
        background: i === state.sel ? "rgba(74,158,255,0.25)" : "transparent", opacity: L.visible ? "1" : "0.5",
      });
      const eye = el("span", { cursor: "pointer", width: "12px" }, { textContent: L.visible ? "\u25CF" : "\u25CB", title: "Show / hide" });
      eye.addEventListener("click", (e) => { e.stopPropagation(); L.visible = !L.visible; commit(); draw(); });
      const lock = el("span", { cursor: "pointer", width: "14px", opacity: L.locked ? "1" : "0.25" }, { textContent: "\u{1F512}", title: "Lock / unlock" });
      lock.addEventListener("click", (e) => { e.stopPropagation(); L.locked = !L.locked; commit(); draw(); });
      const thumbUrl = L.src === "input" ? state.inputs[L.slot]?.url : imageURL(L);
      const thumb = el("div", { width: "28px", height: "24px", flex: "none", background: "#111", borderRadius: "2px", overflow: "hidden" });
      if (thumbUrl) thumb.append(el("img", { width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }, { src: thumbUrl, draggable: false }));
      const name = el("span", { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, { textContent: L.label, title: "Double-click to rename" });
      name.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const input = el("input", { flex: "1", minWidth: "0", fontSize: "11px" }, { type: "text", value: L.label });
        const finish = (ok) => { if (ok && input.value.trim()) { L.label = input.value.trim(); commit(); } else refreshList(); };
        input.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") finish(true); if (ev.key === "Escape") finish(false); });
        input.addEventListener("blur", () => finish(true));
        name.replaceWith(input);
        input.focus();
        input.select();
      });
      row.append(eye, lock, thumb, name);
      row.addEventListener("click", () => select(i));
      listEl.append(row);
    }
  }

  // ------------------------------------------------------------------ layer operations
  async function addFiles(files) {
    for (const f of Array.from(files || [])) {
      if (!f.type || !f.type.startsWith("image/")) continue;
      try {
        const res = await uploadImage(f);
        const bmp = await createImageBitmap(f);
        state.layers.push(normalizeLayer({
          file: res.name, subfolder: res.subfolder || SUBFOLDER, label: f.name, w: bmp.width, h: bmp.height,
          x: W() / 2, y: H() / 2, scale: Math.min(1, W() / bmp.width, H() / bmp.height),
        }, W(), H()));
        bmp.close?.();
        state.sel = state.layers.length - 1;
      } catch (err) {
        console.error("[CanvasComposer]", err);
        alert("Canvas Composer: could not add " + f.name + "\n" + err.message);
      }
    }
    commit();
    draw();
  }
  function addInputLayers() {
    const connected = [];
    for (let i = 1; i <= NUM_INPUTS; i++) {
      const slot = node.inputs?.find((s) => s.name === `image_${i}`);
      if (slot && slot.link != null) connected.push(i);
    }
    if (!connected.length) {
      updateReadout("Connect an image to image_1..image_4 first");
      return;
    }
    let added = 0;
    for (const slot of connected) {
      if (state.layers.some((L) => L.src === "input" && L.slot === slot)) continue;
      const inp = state.inputs[slot];
      const w = inp?.w || 512;
      const h = inp?.h || 512;
      state.layers.push(normalizeLayer({
        src: "input", slot, label: `Input ${slot}`, w, h, pending: !inp,
        x: W() / 2, y: H() / 2, scale: Math.min(1, W() / w, H() / h),
      }, W(), H()));
      state.sel = state.layers.length - 1;
      added++;
    }
    if (added) { commit(); draw(); } else updateReadout("Input layers already added");
  }
  function deleteSelected() {
    if (state.sel < 0) return;
    state.layers.splice(state.sel, 1);
    state.rcache.clear();
    state.sel = Math.min(state.sel, state.layers.length - 1);
    commit();
    draw();
  }
  function duplicateSelected() {
    const L = sel();
    if (!L) return;
    const c = JSON.parse(JSON.stringify(L, (k, v) => (k[0] === "_" ? undefined : v)));
    c.id = uid();
    c.x += 24;
    c.y += 24;
    c.label = `${L.label} copy`;
    state.layers.push(normalizeLayer(c, W(), H()));
    state.sel = state.layers.length - 1;
    commit();
    draw();
  }
  function moveLayer(dir) {
    const i = state.sel;
    const j = i + dir;
    if (i < 0 || j < 0 || j >= state.layers.length) return;
    [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
    state.sel = j;
    commit();
    draw();
  }
  function flipSelected() {
    const L = sel();
    if (!L || L.locked) return;
    L.flip = !L.flip;
    commit();
    draw();
  }
  function toggleLock() {
    const L = sel();
    if (!L) return;
    L.locked = !L.locked;
    commit();
    draw();
  }
  function fitSelected(cover) {
    const L = sel();
    if (!L || L.locked) return;
    const { cw, ch } = cropSize(L);
    const r = (L.rot * Math.PI) / 180;
    const bw = Math.abs(cw * Math.cos(r)) + Math.abs(ch * Math.sin(r));
    const bh = Math.abs(cw * Math.sin(r)) + Math.abs(ch * Math.cos(r));
    L.scale = clamp(cover ? Math.max(W() / bw, H() / bh) : Math.min(W() / bw, H() / bh), 0.001, 50);
    L.x = W() / 2;
    L.y = H() / 2;
    commit();
    draw();
  }
  function alignSelected(kind) {
    const L = sel();
    if (!L || L.locked) return;
    const b = bboxAt(L, L.x, L.y);
    if (kind === "left") L.x -= b.l;
    else if (kind === "center") L.x += W() / 2 - b.cx;
    else if (kind === "right") L.x += W() - b.r;
    else if (kind === "top") L.y -= b.t;
    else if (kind === "middle") L.y += H() / 2 - b.cy;
    else if (kind === "bottom") L.y += H() - b.b;
    commit();
    draw();
  }
  function setCanvasSize(w, h) {
    wW.value = w;
    hW.value = h;
    wW.callback?.(w);
    hW.callback?.(h);
    relayoutNode();
    draw();
    updateReadout();
  }
  function applyPreset(v) {
    if (v === "first") {
      const first = state.layers[0];
      if (!first) { updateReadout("Add a layer first"); return; }
      const { cw, ch } = cropSize(first);
      const ar = cw / ch;
      const w = Math.max(64, Math.round(Math.sqrt(1e6 * ar) / 16) * 16);
      const h = Math.max(64, Math.round(Math.sqrt(1e6 / ar) / 16) * 16);
      setCanvasSize(w, h);
    } else {
      const [w, h] = v.split("x").map(Number);
      setCanvasSize(w, h);
    }
  }
  function relayoutNode() {
    // keep the node's width, size its height so the viewport roughly matches the canvas aspect
    const wantVH = clamp(((node.size?.[0] || 560) - 24) * (H() / W()), MIN_VIEWPORT_H, 620);
    const sz = node.computeSize?.() || [0, 0];
    const target = Math.max(sz[1] - MIN_VIEWPORT_H + wantVH, sz[1]);
    node.setSize?.([Math.max(node.size?.[0] || 560, sz[0] || 0), target]);
  }

  // ------------------------------------------------------------------ tools
  function renderToolOpts() {
    toolOpts.replaceChildren();
    if (!state.tool) { toolOpts.style.display = "none"; return; }
    toolOpts.style.display = "flex";
    const done = mkBtn("Done", "Finish (Esc)", () => setTool(null));
    if (state.tool === "remove") {
      const modeBtns = {};
      const mkMode = (id, label, title) => {
        const b = mkBtn(label, title, () => { state.removeMode = id; renderToolOpts(); });
        b.style.background = state.removeMode === id ? "#7a1f1f" : btnCss.background;
        modeBtns[id] = b;
        return b;
      };
      toolOpts.append(
        el("span", { color: "#ff6b6b", fontWeight: "600" }, { textContent: "Remove:" }),
        mkMode("lasso", "Lasso", "Circle the area to cut out (default)"),
        mkMode("brush", "Brush", "Paint over the area to cut out"),
        mkMode("restore", "Restore", "Paint to bring cut-out pixels back")
      );
      if (state.removeMode !== "lasso") {
        const size = el("input", { width: "90px" }, { type: "range", min: 4, max: 300, step: 1, value: state.brushSize, title: "Brush size" });
        size.addEventListener("input", () => { state.brushSize = Number(size.value); });
        toolOpts.append(size);
      }
      toolOpts.append(mkBtn("Clear cuts", "Remove every cut-out from this layer", clearCuts), done);
    } else {
      toolOpts.append(
        el("span", { color: "#40d080", fontWeight: "600" }, { textContent: "Crop: drag a side handle inwards" }),
        mkBtn("Reset crop", "Restore the full image", resetCrop),
        done
      );
    }
  }
  function setTool(t) {
    if (t && !sel()) {
      for (let i = state.layers.length - 1; i >= 0; i--) if (state.layers[i].visible && !state.layers[i].locked) { state.sel = i; break; }
      if (!sel()) { updateReadout("Select a layer first"); return; }
    }
    state.tool = state.tool === t ? null : t;
    state.mark = null;
    state.drag = null;
    renderToolOpts();
    syncControls();
    refreshList();
    updateReadout(state.tool === "remove" ? "Remove: circle the area to cut out (Esc to finish)" : state.tool === "crop" ? "Crop: drag side handles (Esc to finish)" : "");
    draw();
    cv.focus?.({ preventScroll: true });
  }
  function clearCuts() {
    const L = sel();
    if (!L || !L.cuts.length) return;
    L.cuts = [];
    state.rcache.delete(L.id);
    commit();
    draw();
  }
  function resetCrop() {
    const L = sel();
    if (!L) return;
    const { cw, ch } = cropSize(L);
    // offset from the cropped rect's centre to the full image's centre, so visible pixels stay put
    const offX = (L.w / 2 - (L.crop.l + cw / 2)) * L.scale * (L.flip ? -1 : 1);
    const offY = (L.h / 2 - (L.crop.t + ch / 2)) * L.scale;
    const r = (L.rot * Math.PI) / 180;
    L.x += offX * Math.cos(r) - offY * Math.sin(r);
    L.y += offX * Math.sin(r) + offY * Math.cos(r);
    L.crop = { l: 0, t: 0, r: 0, b: 0 };
    commit();
    draw();
  }
  function finishMark() {
    const m = state.mark;
    state.mark = null;
    const L = m && state.layers.find((l) => l.id === m.id);
    if (!L) { draw(); return; }
    const pts = m.pts.map((p) => srcFromProject(L, p).map(round4));
    if (m.mode === "lasso") {
      if (pts.length < 3) { draw(); return; }
      L.cuts.push({ op: "remove", kind: "poly", pts });
    } else {
      L.cuts.push({
        op: m.mode === "restore" ? "restore" : "remove", kind: "stroke",
        size: round4(state.brushSize / L.scale / Math.max(L.w, L.h)), pts,
      });
    }
    commit();
    draw();
  }

  // ------------------------------------------------------------------ pointer interaction
  cv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    cv.focus?.({ preventScroll: true });
    cv.setPointerCapture?.(e.pointerId);
    const p = toProject(e);
    const { ps } = metrics();

    if (e.button === 1 || state.space) {
      state.drag = { mode: "pan", sx: e.clientX, sy: e.clientY, px: view.panX, py: view.panY };
      return;
    }
    const S = sel();

    if (state.tool === "remove") {
      if (S && !S.locked) state.mark = { mode: state.removeMode, id: S.id, pts: [{ x: p.x, y: p.y }] };
      draw();
      return;
    }
    if (state.tool === "crop") {
      if (S && !S.locked) {
        const side = hitSide(S, p, ps);
        if (side) { state.drag = { mode: "crop", side }; return; }
      }
      const idx = hitLayer(p);
      if (idx >= 0) select(idx);
      return;
    }
    if (S && !S.locked && hitCorner(S, p, ps)) {
      state.drag = { mode: "scale", startDist: Math.hypot(p.x - S.x, p.y - S.y) || 1, startScale: S.scale };
      return;
    }
    const idx = hitLayer(p);
    select(idx);
    if (idx >= 0) state.drag = { mode: "move", dx: p.x - state.layers[idx].x, dy: p.y - state.layers[idx].y, moved: false };
  });

  cv.addEventListener("pointermove", (e) => {
    const p = toProject(e);
    const { ps } = metrics();
    const L = sel();
    if (state.mark) {
      const last = state.mark.pts[state.mark.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 1.5 / ps) state.mark.pts.push({ x: p.x, y: p.y });
      draw();
      return;
    }
    const d = state.drag;
    if (d) {
      if (d.mode === "pan") {
        view.panX = d.px + (e.clientX - d.sx);
        view.panY = d.py + (e.clientY - d.sy);
      } else if (L) {
        if (d.mode === "move") {
          const [nx, ny] = e.altKey ? [p.x - d.dx, p.y - d.dy] : snapPosition(L, p.x - d.dx, p.y - d.dy, ps);
          if (!e.altKey && !state.snap) state.guides = [];
          L.x = nx;
          L.y = ny;
          d.moved = true;
        } else if (d.mode === "scale") {
          const dist = Math.hypot(p.x - L.x, p.y - L.y);
          L.scale = clamp((d.startScale * dist) / d.startDist, 0.005, 50);
        } else if (d.mode === "crop") {
          dragCrop(L, d.side, p);
        }
      }
      updateReadout();
      draw();
      return;
    }
    // hover cursor
    let cursor = "default";
    if (state.tool === "remove") cursor = "crosshair";
    else if (L && !L.locked && state.tool === "crop") {
      const side = hitSide(L, p, ps);
      cursor = side === "l" || side === "r" ? "ew-resize" : side ? "ns-resize" : "default";
    } else if (L && !L.locked && !state.tool && hitCorner(L, p, ps)) cursor = "nwse-resize";
    else if (!state.tool && hitLayer(p) >= 0) cursor = "move";
    cv.style.cursor = cursor;
  });

  function dragCrop(L, side, p) {
    const l = toLocal(L, p);
    const { hw, hh } = halfSize(L);
    // distance the dragged edge must travel inwards (local px); negative = outwards
    const inward = side === "l" ? l.x + hw : side === "r" ? hw - l.x : side === "t" ? l.y + hh : hh - l.y;
    const srcSide = L.flip && (side === "l" || side === "r") ? (side === "l" ? "r" : "l") : side;
    const total = srcSide === "l" || srcSide === "r" ? L.w : L.h;
    const other = srcSide === "l" ? L.crop.r : srcSide === "r" ? L.crop.l : srcSide === "t" ? L.crop.b : L.crop.t;
    const old = L.crop[srcSide];
    const next = clamp(old + inward / L.scale, 0, Math.max(0, total - other - 8));
    const applied = (next - old) * L.scale; // local px actually moved
    if (!applied) return;
    L.crop[srcSide] = next;
    // shift the centre so the visible pixels stay put on the canvas
    const lx = side === "l" ? applied / 2 : side === "r" ? -applied / 2 : 0;
    const ly = side === "t" ? applied / 2 : side === "b" ? -applied / 2 : 0;
    const r = (L.rot * Math.PI) / 180;
    L.x += lx * Math.cos(r) - ly * Math.sin(r);
    L.y += lx * Math.sin(r) + ly * Math.cos(r);
  }

  const endDrag = (e) => {
    try { cv.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (state.mark) { finishMark(); return; }
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    state.guides = [];
    if (d.mode !== "pan") commit();
    draw();
  };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);

  cv.addEventListener("dblclick", (e) => {
    if (state.tool) return;
    if (hitLayer(toProject(e)) < 0) resetView();
  });

  let wheelTimer = null;
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const f = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    if (e.ctrlKey || e.metaKey || !sel() || sel().locked || state.tool) {
      // zoom the view around the cursor
      const p = toProject(e);
      const m = metrics();
      const z2 = clamp(view.zoom * f, 0.2, 16);
      const ps2 = m.fit * z2;
      view.panX = p.px - p.x * ps2 - (vw - W() * ps2) / 2;
      view.panY = p.py - p.y * ps2 - (vh - H() * ps2) / 2;
      view.zoom = z2;
      updateReadout();
      draw();
      return;
    }
    const L = sel();
    L.scale = clamp(L.scale * f, 0.005, 50);
    draw();
    updateReadout();
    writeWidget();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(commit, 400);
  }, { passive: false });

  cv.addEventListener("keydown", (e) => {
    const L = sel();
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (e.key === " ") state.space = true;
    else if (mod && e.key.toLowerCase() === "z") (e.shiftKey ? redo : undo)();
    else if (mod && e.key.toLowerCase() === "y") redo();
    else if (mod && e.key.toLowerCase() === "d") duplicateSelected();
    else if (e.key === "Escape" || e.key === "Enter") { if (state.tool) setTool(null); else handled = false; }
    else if (!L || L.locked) handled = false;
    else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
    else if (e.key.startsWith("Arrow")) {
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft") L.x -= step;
      else if (e.key === "ArrowRight") L.x += step;
      else if (e.key === "ArrowUp") L.y -= step;
      else L.y += step;
      draw();
      updateReadout();
      writeWidget();
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(commit, 400);
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  });
  cv.addEventListener("keyup", (e) => { if (e.key === " ") state.space = false; });

  cv.addEventListener("paste", (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length) {
      e.preventDefault();
      e.stopPropagation();
      addFiles(files);
    }
  });
  root.addEventListener("dragover", (e) => e.preventDefault());
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    addFiles(e.dataTransfer?.files);
  });

  // ------------------------------------------------------------------ node hooks
  const widget = node.addDOMWidget("canvas_ui", "canvas_composer", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => chromeH() + MIN_VIEWPORT_H,
  });
  widget.computeSize = (w) => [w, chromeH() + MIN_VIEWPORT_H];

  // v1 workflows stored 5 widget values: width, height, background, canvas_data and the editor
  // widget (empty). Keep the editor right after canvas_data so index 4 still lines up and
  // newer widgets (seam_width) come after it and fall back to their defaults.
  {
    const iUi = node.widgets.indexOf(widget);
    const iData = node.widgets.indexOf(dataW);
    if (iUi > iData + 1) {
      node.widgets.splice(iUi, 1);
      node.widgets.splice(iData + 1, 0, widget);
    }
  }

  for (const w of [wW, hW]) {
    const orig = w.callback;
    w.callback = function () {
      orig?.apply(this, arguments);
      relayoutNode();
      draw();
      updateReadout();
    };
  }
  {
    const orig = bgW.callback;
    bgW.callback = function () { orig?.apply(this, arguments); draw(); };
  }

  let ro = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      vw = Math.max(0, Math.round(r.width));
      vh = Math.max(0, Math.round(r.height));
      draw();
    });
    ro.observe(viewport);
  }

  const origExecuted = node.onExecuted;
  node.onExecuted = function (msg) {
    origExecuted?.apply(this, arguments);
    const list = msg?.canvas_inputs;
    if (!Array.isArray(list)) return;
    const inputs = {};
    for (const it of list) {
      const q = new URLSearchParams({ filename: it.filename, type: it.type || "temp", subfolder: it.subfolder || "" });
      inputs[it.slot] = { url: api.apiURL("/view?" + q.toString()), key: it.filename, w: it.w, h: it.h };
    }
    state.inputs = inputs;
    let changed = false;
    for (const L of state.layers) {
      const inp = L.src === "input" ? inputs[L.slot] : null;
      if (!inp) continue;
      if (L.pending) {
        L.w = inp.w;
        L.h = inp.h;
        L.scale = Math.min(1, W() / inp.w, H() / inp.h);
        delete L.pending;
        changed = true;
      } else {
        L.w = inp.w;
        L.h = inp.h;
      }
    }
    state.rcache.clear();
    if (changed) commit(); else refreshList();
    draw();
  };

  const origConfigure = node.onConfigure;
  node.onConfigure = function () {
    origConfigure?.apply(this, arguments);
    loadFromWidget();
  };
  const origRemoved = node.onRemoved;
  node.onRemoved = function () {
    ro?.disconnect();
    origRemoved?.apply(this, arguments);
  };

  showTab("layer");
  renderToolOpts();
  node.setSize?.([Math.max(580, node.size?.[0] || 0), Math.max(node.size?.[1] || 0, node.computeSize?.()[1] || 0) + 160]);
  loadFromWidget();

  // expose for debugging in the browser console
  node._canvasComposer = { state, view, commit, undo, redo, draw };
}

app.registerExtension({
  name: "JOnsuk.CanvasComposer",
  nodeCreated(node) {
    if (NODE_CLASSES.has(node.comfyClass)) setupNode(node);
  },
});
