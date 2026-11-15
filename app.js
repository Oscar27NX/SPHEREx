const state = {
  config: null,
  sky: null,
  decoded: null,
  clientCache: new Map(),
  ra: 133.7867,
  dec: -7.2442,
  fov: 300,
  windowYears: 10.0,
  releaseId: "auto",
  mode: "blink",
  detector: "all",
  fftFilter: "raw",
  fftDemo: false,
  playing: true,
  speedMs: 220,
  zoom: 1.0,
  panX: 0,
  panY: 0,
  invert: false,
  showGaia: false,
  showWise: false,
  showFlags: false,
  showAladin: false,
  epochOps: [],
  winStart: 2016.0,
  winEnd: 2026.0,
  cursorEpochPos: 0,
  selectedSource: null,
  spectrumPixel: null,
  aladinInstance: null,
  aladinSurvey: "P/allWISE/color"
};

let blinkTimer = null;
let dragState = null;
let suppressClick = false;
let requestSerial = 0;
let skyController = null;
let refreshTimer = null;
let aladinLoading = null;
let timelineScale = null;
const decodedCache = new WeakMap();
const stretchCache = new Map();

function parseUrlParams() {
  const merged = new URLSearchParams(window.location.search);
  const hash = window.location.hash.replace(/^#/, "");
  if (hash) {
    const hashParams = new URLSearchParams(hash);
    for (const [k, v] of hashParams.entries()) {
      if (!merged.has(k)) merged.set(k, v);
    }
  }
  const hasRaDec = merged.has("ra") && merged.has("dec");
  if (hasRaDec) {
    const parsedRa = Number.parseFloat(merged.get("ra"));
    const parsedDec = Number.parseFloat(merged.get("dec"));
    if (Number.isFinite(parsedRa)) state.ra = ((parsedRa % 360) + 360) % 360;
    if (Number.isFinite(parsedDec)) state.dec = Math.max(-89.9, Math.min(89.9, parsedDec));
  }
  if (merged.has("fov")) {
    const f = Number.parseFloat(merged.get("fov"));
    if (Number.isFinite(f)) state.fov = Math.max(60, Math.min(1800, f));
  }
  if (merged.has("window")) {
    const w = Number.parseFloat(merged.get("window"));
    if (Number.isFinite(w)) state.windowYears = Math.max(0.5, Math.min(15, w));
  }
  if (merged.has("zoom")) {
    const z = Number.parseFloat(merged.get("zoom"));
    if (Number.isFinite(z)) state.zoom = Math.max(1, Math.min(8, z));
  }
  if (merged.has("det")) state.detector = merged.get("det");
  if (merged.has("mode")) state.mode = merged.get("mode");
  if (merged.has("fft")) state.fftFilter = merged.get("fft");
  state.fftDemo = merged.get("demo") === "fft";
  if (merged.has("release")) {
    const release = merged.get("release");
    state.releaseId = release === "auto" ? release : release.toLowerCase().replace("spherex-", "spherex_");
  }
  state.showGaia = merged.get("gaia") === "1";
  state.showWise = merged.get("wise") === "1";
  state.showFlags = merged.get("flags") === "1";
  if (merged.get("invert") === "1") state.invert = true;
  if (!["all", "fft2d", "rgb", "D1", "D2", "D3", "D4", "D5", "D6"].includes(state.detector)) state.detector = "all";
  if (!["blink", "coadd", "diff"].includes(state.mode)) state.mode = "blink";
  if (!["raw", "low", "mid", "high"].includes(state.fftFilter)) state.fftFilter = "raw";
  if (merged.get("embed") === "1") document.body.classList.add("embed-mode");
  return hasRaDec;
}

function syncUrlHash() {
  const params = new URLSearchParams();
  params.set("ra", state.ra.toFixed(5));
  params.set("dec", state.dec.toFixed(5));
  params.set("fov", String(Math.round(state.fov)));
  params.set("window", state.windowYears.toFixed(1));
  params.set("zoom", state.zoom.toFixed(2));
  params.set("det", state.detector);
  params.set("mode", state.mode);
  params.set("fft", state.fftFilter);
  if (state.fftDemo) params.set("demo", "fft");
  params.set("release", state.releaseId);
  params.set("gaia", state.showGaia ? "1" : "0");
  params.set("wise", state.showWise ? "1" : "0");
  params.set("flags", state.showFlags ? "1" : "0");
  params.set("invert", state.invert ? "1" : "0");
  if (document.body.classList.contains("embed-mode")) params.set("embed", "1");
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

function decodeBase64Typed(b64, TypedArrayCtor) {
  const raw = window.atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return new TypedArrayCtor(bytes.buffer);
}

function decodeSkyPayload(sky) {
  return {
    frames: decodeBase64Typed(sky.frames_b64, Float32Array),
    wavelengths: decodeBase64Typed(sky.wavelength_maps_b64, Float32Array),
    bandwidths: decodeBase64Typed(sky.bandwidth_maps_b64, Float32Array),
    flags: decodeBase64Typed(sky.flags_b64, Uint32Array),
    grid: sky.grid_size,
    nEpochs: sky.epochs.length,
    nDet: sky.detectors.length
  };
}

function skyCacheKey(ra, dec, fov, win, releaseId) {
  return `${ra.toFixed(6)}|${dec.toFixed(6)}|${fov.toFixed(3)}|${win.toFixed(3)}|${releaseId}`;
}

function applySkyData(sky) {
  const sameView = state.sky && skyCacheKey(state.ra, state.dec, state.fov, state.windowYears, state.releaseId)
    === skyCacheKey(sky.ra, sky.dec, sky.fov, sky.window, sky.release.id);
  const sameEpochs = state.sky && state.ra === sky.ra && state.dec === sky.dec
    && JSON.stringify(state.sky.epochs) === JSON.stringify(sky.epochs);
  state.sky = sky;
  if (!decodedCache.has(sky)) decodedCache.set(sky, decodeSkyPayload(sky));
  state.decoded = decodedCache.get(sky);
  stretchCache.clear();
  state.ra = sky.ra;
  state.dec = sky.dec;
  state.fov = sky.fov;
  state.windowYears = sky.window;
  state.releaseId = sky.release.id;
  if (!sameEpochs) {
    state.epochOps = sky.epochs.map(() => "+");
    state.winStart = sky.epochs[0]?.year ?? 0;
    state.winEnd = sky.epochs.at(-1)?.year ?? 0;
    state.cursorEpochPos = 0;
    state.selectedSource = null;
    state.spectrumPixel = null;
  }
  if (!sameView) {
    state.panX = 0; state.panY = 0;
    state.selectedSource = null; state.spectrumPixel = null;
  }

  document.getElementById("input-ra").value = sky.ra.toFixed(4);
  document.getElementById("input-dec").value = sky.dec.toFixed(4);
  document.getElementById("stat-fov").textContent = `FOV ${Math.round(sky.fov)}″`;

  document.getElementById("input-fov").value = sky.fov;
  const catalogErrors = Object.keys(sky.provenance?.catalog_errors || {});
  const imageErrors = sky.provenance?.cutout_errors?.length || 0;
  setDataStatus(sky.message + (sky.refreshing ? " · Checking archive updates…" : "")
    + (sky.refresh_error ? ` · Refresh failed: ${sky.refresh_error}` : "")
    + (catalogErrors.length ? ` · Catalog unavailable: ${catalogErrors.join(", ")}` : "")
    + (imageErrors ? ` · ${imageErrors} cutouts unavailable` : ""));
  syncControlUi();
  renderEpochLegend();
  renderCurrentFrame();
  renderSkyOverlay();
  renderSpectralCharts();
  renderTimelineBrush();
  syncAladinView();
  syncUrlHash();
  applyVisualTransform();
}

function syncControlUi() {
  document.querySelectorAll(".mode-btn[data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === state.mode);
  });
  document.querySelectorAll("#detector-buttons .chip").forEach((b) => {
    b.classList.toggle("active", b.dataset.det === state.detector);
  });
  document.querySelectorAll("#fft-buttons .chip[data-fft]").forEach((b) => {
    b.classList.toggle("active", b.dataset.fft === state.fftFilter);
  });
  document.querySelectorAll("#fov-buttons .chip").forEach((b) => {
    b.classList.toggle("active", Number.parseFloat(b.dataset.fov) === Math.round(state.fov));
  });
  document.getElementById("tog-gaia").classList.toggle("active", state.showGaia);
  document.getElementById("tog-wise").classList.toggle("active", state.showWise);
  document.getElementById("tog-flags").classList.toggle("active", state.showFlags);
  document.getElementById("tog-invert").classList.toggle("active", state.invert);
  document.getElementById("tog-aladin").classList.toggle("active", state.showAladin);
  document.getElementById("release-select").value = state.releaseId;
}

function setDataStatus(message) {
  document.getElementById("data-status").textContent = message;
}

function showRetrieval(sky = null, pending = false) {
  const box = document.getElementById("retrieval-progress");
  const busy = pending || sky?.data_status === "loading" || sky?.refreshing;
  box.classList.toggle("hidden", !busy);
  document.getElementById("viewport-stage").setAttribute("aria-busy", String(Boolean(busy)));
  if (!busy) return;
  const progress = sky?.progress;
  const bar = document.getElementById("retrieval-bar");
  if (progress?.total) { bar.max = progress.total; bar.value = progress.completed; }
  else bar.removeAttribute("value");
  const phases = { queued: "Waiting for the archive worker", discovery: "Searching IRSA observations", cutouts: "Retrieving images", catalogs: "Retrieving catalog overlays" };
  document.getElementById("retrieval-label").textContent = (phases[progress?.phase] || "Contacting the archive")
    + (progress?.total ? ` · ${progress.completed}/${progress.total} images checked` : "")
    + (progress?.elapsed_seconds ? ` · ${progress.elapsed_seconds}s elapsed` : "")
    + ". You can switch to a cached preset while waiting.";
}

function rememberSky(sky) {
  if (sky.preview || (sky.data_status !== "ready" && sky.data_status !== "empty")) return;
  if (state.clientCache.size >= 32) state.clientCache.delete(state.clientCache.keys().next().value);
  state.clientCache.set(skyCacheKey(sky.ra, sky.dec, sky.fov, sky.window, sky.release.id), { sky, at: Date.now() });
}

function cachedSkyPreview(ra, dec, fov, win, releaseId) {
  const candidates = Array.from(state.clientCache.values(), entry => entry.sky)
    .filter(s => s.epochs?.length && Math.abs(s.ra - ra) < 1e-6 && Math.abs(s.dec - dec) < 1e-6 && s.window >= win)
    .sort((a, b) => Number(a.fov < fov) - Number(b.fov < fov) || Math.abs(a.fov - fov) - Math.abs(b.fov - fov));
  const cutoff = Date.now() / 86400000 + 40587 - win * 365.25;
  for (const source of candidates) {
    const indices = source.epochs.flatMap((ep, i) => ep.mjd >= cutoff &&
      (releaseId === 'auto' || ep.source === releaseId || ep.source === `${releaseId}_deep`) ? [i] : []);
    if (!indices.length) continue;
    if (!decodedCache.has(source)) decodedCache.set(source, decodeSkyPayload(source));
    const old = decodedCache.get(source), grid = old.grid, size = grid * grid;
    const decoded = { grid, nDet: old.nDet, nEpochs: indices.length };
    const positions = Array.from({ length: grid }, (_, i) => Math.floor((i + .5 - grid / 2) * fov / source.fov + grid / 2));
    for (const [key, planes, Type] of [['frames', old.nDet, Float32Array], ['flags', 1, Uint32Array],
    ['wavelengths', 1, Float32Array], ['bandwidths', 1, Float32Array]]) {
      const values = new Type(indices.length * planes * size);
      values.fill(key === 'flags' ? 1 << 9 : NaN);
      for (let e = 0; e < indices.length; e++) for (let d = 0; d < planes; d++) for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) {
        const sx = positions[x], sy = positions[y];
        if (sx >= 0 && sx < grid && sy >= 0 && sy < grid) values[(e * planes + d) * size + y * grid + x] = old[key][(indices[e] * planes + d) * size + sy * grid + sx];
      }
      decoded[key] = values;
    }
    const epochs = indices.map((i, index) => ({ ...source.epochs[i], index }));
    const included = new Set(epochs.flatMap(ep => ep.detectors.map(d => `${ep.mjd}|${d - 1}`)));
    const sky = {
      ...source, ra, dec, fov, window: win, release: { id: releaseId }, epochs, preview: true, refreshing: true,
      pixel_scale_arcsec: fov / grid, frames_b64: '', flags_b64: '', wavelength_maps_b64: '', bandwidth_maps_b64: '',
      message: 'Cached preview; refining requested field. Uncovered pixels are blank.',
      measurements: (source.measurements || []).filter(m => included.has(`${m.mjd}|${m.detector}`)),
      sources: source.sources.map(s => ({ ...s, px: (s.px - grid / 2) * source.fov / fov + grid / 2, py: (s.py - grid / 2) * source.fov / fov + grid / 2 }))
    };
    sky.sources = sky.sources.filter(s => s.px >= 0 && s.px < grid && s.py >= 0 && s.py < grid);
    decodedCache.set(sky, decoded);
    return sky;
  }
  return null;
}

async function querySky(ra, dec, fov = state.fov, win = state.windowYears, releaseId = state.releaseId) {
  const serial = ++requestSerial;
  clearTimeout(refreshTimer);
  skyController?.abort();
  skyController = new AbortController();
  if (![ra, dec, fov, win].every(Number.isFinite) || dec < -90 || dec > 90 || fov < 60 || fov > 1800) {
    setDataStatus("Enter valid coordinates and a FOV between 60 and 1800 arcseconds.");
    return;
  }
  ra = ((ra % 360) + 360) % 360;
  const key = skyCacheKey(ra, dec, fov, win, releaseId);
  const cached = state.clientCache.get(key);
  const preview = cached ? null : cachedSkyPreview(ra, dec, fov, win, releaseId);
  if (cached || preview) applySkyData(cached?.sky || preview);
  else setDataStatus("Loading live IRSA cutouts…");
  showRetrieval(null, true);
  let timedOut = false;
  const controller = skyController;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    const params = new URLSearchParams({ ra, dec, fov, window: win, release: releaseId });
    const resp = await fetch(`/api/sky?${params}`, { signal: skyController.signal });
    const sky = await resp.json();
    if (!resp.ok) throw new Error("Archive unavailable");
    if (serial !== requestSerial) return;
    showRetrieval(sky);
    rememberSky(sky);
    if (sky.epochs?.length || (!cached && !preview) || sky.data_status === "empty") applySkyData(sky);
    else setDataStatus("Refreshing cached observations. The archive is temporarily unavailable.");
    if (sky.data_status === "loading" || sky.refreshing) {
      refreshTimer = setTimeout(() => {
        if (serial === requestSerial) querySky(ra, dec, fov, win, releaseId);
      }, 2000);
    } else if (["ready", "empty", "error"].includes(sky.data_status)) {
      refreshTimer = setTimeout(() => {
        if (serial === requestSerial) querySky(ra, dec, fov, win, releaseId);
      }, 60000);
    }
  } catch (error) {
    if ((error.name !== "AbortError" || timedOut) && serial === requestSerial) {
      showRetrieval();
      setDataStatus("Unable to contact the archive. Your current view is preserved; retrying shortly.");
      refreshTimer = setTimeout(() => {
        if (serial === requestSerial) querySky(ra, dec, fov, win, releaseId);
      }, 10000);
    }
  } finally { clearTimeout(timeout); }
}

function getActiveEpochs() {
  if (!state.sky) return [];
  const active = [];
  for (let i = 0; i < state.sky.epochs.length; i += 1) {
    const ep = state.sky.epochs[i];
    const inWin = ep.year >= state.winStart - 0.01 && ep.year <= state.winEnd + 0.01;
    const op = state.epochOps[i] || "+";
    const available = !state.detector.startsWith("D") || ep.detectors.includes(Number(state.detector.slice(1)));
    if (inWin && available && op !== ".") active.push({ idx: i, ep, op });
  }
  return active;
}

function asinhStretch(val, minB = -0.25, maxB = 8.5, beta = 1.6) {
  const scaled = (val - minB) / Math.max(1e-4, maxB - minB);
  const clamped = Math.max(0, scaled);
  const mapped = Math.asinh(clamped * beta) / Math.asinh(beta);
  const norm = Math.max(0, Math.min(1, mapped));
  return state.invert ? 1 - norm : norm;
}

function samplePlane(epochIdx, detSpec, outBuf) {
  const { frames, grid, nDet } = state.decoded;
  const count = grid * grid;
  const detectors = detSpec === "all" || detSpec === "fft2d"
    ? Array.from({ length: nDet }, (_, d) => d) : [Number(detSpec.slice(1)) - 1];
  for (let p = 0; p < count; p++) {
    let sum = 0, hits = 0;
    for (const d of detectors) {
      const value = frames[(epochIdx * nDet + d) * count + p];
      if (Number.isFinite(value)) { sum += value; hits++; }
    }
    outBuf[p] = hits ? sum / hits : NaN;
  }
  if (detSpec === "fft2d") {
    const original = outBuf.slice();
    for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) {
      let sum = 0, hits = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
        const value = original[ny * grid + nx];
        if (Number.isFinite(value)) { sum += value; hits++; }
      }
      outBuf[y * grid + x] = Number.isFinite(original[y * grid + x]) && hits ? sum / hits : NaN;
    }
  }
}

function accumulateComposite(active, detSpec, outBuf) {
  const tmp = new Float32Array(outBuf.length);
  const positive = new Float64Array(outBuf.length), negative = new Float64Array(outBuf.length);
  const plusCount = new Uint16Array(outBuf.length), minusCount = new Uint16Array(outBuf.length);
  const explicitMinus = active.some(a => a.op === "-");
  active.forEach((entry, index) => {
    samplePlane(entry.idx, detSpec, tmp);
    const minus = entry.op === "-" || (state.mode === "diff" && !explicitMinus && index < Math.floor(active.length / 2));
    for (let p = 0; p < outBuf.length; p++) if (Number.isFinite(tmp[p])) {
      if (minus) { negative[p] += tmp[p]; minusCount[p]++; }
      else { positive[p] += tmp[p]; plusCount[p]++; }
    }
  });
  for (let p = 0; p < outBuf.length; p++) {
    if (state.mode === "diff") {
      const { wavelengths, bandwidths } = state.decoded;
      const first = active[0].idx * outBuf.length + p;
      const compatible = active.every(a => {
        const offset = a.idx * outBuf.length + p;
        const tolerance = Math.min(bandwidths[first], bandwidths[offset]) * .25;
        return Number.isFinite(wavelengths[offset]) && tolerance > 0
          && Math.abs(wavelengths[offset] - wavelengths[first]) <= tolerance;
      });
      outBuf[p] = compatible && plusCount[p] && minusCount[p] ? positive[p] / plusCount[p] - negative[p] / minusCount[p] : NaN;
    }
    else outBuf[p] = plusCount[p] + minusCount[p] ? (positive[p] - negative[p]) / (plusCount[p] + minusCount[p]) : NaN;
  }
}

function stretchLimits(buffers, difference) {
  const values = buffers.flatMap(b => Array.from(b).filter(Number.isFinite)).sort((a, b) => a - b);
  if (!values.length) return [0, 1];
  const lo = values[Math.floor((values.length - 1) * .01)];
  const hi = values[Math.floor((values.length - 1) * .99)];
  if (difference) { const span = Math.max(Math.abs(lo), Math.abs(hi), 1e-6); return [-span, span]; }
  return [lo, Math.max(lo + 1e-6, hi)];
}

function nearestRgbEpochs(active, mjd) {
  if (!Number.isFinite(mjd)) return [null, null, null];
  return [5, 3, 1].map(detector => {
    let closest = null;
    for (const entry of active) {
      if (!entry.ep.detectors.includes(detector) || !Number.isFinite(entry.ep.mjd)) continue;
      const distance = Math.abs(entry.ep.mjd - mjd);
      const previous = closest ? Math.abs(closest.ep.mjd - mjd) : Infinity;
      if (distance < previous || (distance === previous && entry.ep.mjd < closest.ep.mjd)) closest = entry;
    }
    return closest;
  });
}

function renderCurrentFrame() {
  if (!state.sky || !state.decoded) return;
  const active = getActiveEpochs();
  const readout = document.getElementById("active-epoch-readout");
  readout.title = "";
  const emptyView = document.getElementById("empty-view");
  emptyView.classList.add("hidden");
  const showEmpty = message => {
    readout.textContent = message;
    emptyView.textContent = message;
    emptyView.classList.remove("hidden");
  };
  const canvas = document.getElementById("sky-canvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  updateTimelineCursor();
  if (!active.length) {
    showEmpty(state.sky.data_status === "error" ? "The archive is temporarily unavailable. Try a cached preset or retry shortly."
      : state.sky.data_status === "loading" ? "Retrieving observations. You can try a cached preset while this field loads."
        : "No observations for this selection. Try Available arrays, widen the time brush, or choose another release or target.");
    renderSkyOverlay(); return;
  }
  if (state.mode === "diff" && (!state.detector.startsWith("D") || active.length < 2)) {
    showEmpty("Choose one detector and at least two epochs to compare wavelengths");
    renderSkyOverlay();
    return;
  }
  const grid = state.decoded.grid;
  const slot = state.mode === "blink" ? active[state.cursorEpochPos % active.length] : null;
  const rgbEpochs = state.detector === "rgb" && slot ? nearestRgbEpochs(active, slot.ep.mjd) : null;
  const completeRgb = rgbEpochs?.every(Boolean);
  let specs = state.detector === "rgb" ? ["D5", "D3", "D1"] : [state.detector];
  const missing = specs.filter(spec => spec.startsWith("D") && !active.some(a => a.ep.detectors.includes(Number(spec.slice(1)))));
  if (state.detector === "rgb" && missing.length) specs = ["all"];
  const buffers = specs.map(() => new Float32Array(grid * grid));
  if (state.mode === "blink") {
    specs.forEach((spec, i) => samplePlane(completeRgb ? rgbEpochs[i].idx : slot.idx, spec, buffers[i]));
    readout.textContent = `${slot.ep.label} · ${slot.ep.source}`;
    if (completeRgb) {
      const dates = rgbEpochs.map(a => a.ep.mjd);
      const span = Math.max(...dates) - Math.min(...dates);
      const labels = rgbEpochs.map((a, i) => `${["R(D5)", "G(D3)", "B(D1)"][i]} ${a.ep.label.split(" ")[0]}`);
      readout.textContent = `RGB nearest dates · ${labels.join(" / ")} · ${span.toFixed(1)} d span; non-simultaneous`;
      readout.title = `Cursor: ${slot.ep.label}\n` + rgbEpochs.map((a, i) => `${labels[i]} · ${a.ep.source} · MJD ${a.ep.mjd.toFixed(5)}`).join("\n")
        + "\nFalse-color visualization of real observations; channel stretches are independent. Not simultaneous photometry or a motion measurement.";
    }
    highlightEpochChip(slot.idx);
  } else {
    specs.forEach((spec, i) => accumulateComposite(active, spec, buffers[i]));
    readout.textContent = state.mode === "diff" ? "Difference preview · wavelength mismatch pixels masked"
      : `Mean of ${active.length} observations · mixed wavelengths`;
    highlightEpochChip(-1);
  }
  if (missing.length && state.detector === "rgb") readout.textContent += ` · RGB needs ${missing.join(", ")} in this time window; showing available data in grayscale. Widen the brush or choose another release.`;
  const limits = specs.map((spec, i) => {
    const key = `${spec}|${state.mode}|${active.map(a => `${a.idx}:${a.op}`).join(",")}`;
    if (stretchCache.has(key)) return stretchCache.get(key);
    const all = [];
    if (state.mode === "blink") for (const epoch of active) {
      const plane = new Float32Array(grid * grid); samplePlane(epoch.idx, spec, plane); all.push(plane);
    }
    const limits = stretchLimits(all.length ? all : [buffers[i]], state.mode === "diff");
    if (stretchCache.size >= 64) stretchCache.delete(stretchCache.keys().next().value);
    stretchCache.set(key, limits);
    return limits;
  });
  if (!buffers.some(b => b.some(Number.isFinite))) showEmpty("No valid pixels with matching wavelength coverage. Try Blink or Mean with Available arrays.");
  const image = ctx.createImageData(grid, grid);
  for (let p = 0; p < grid * grid; p++) {
    let valid = true;
    for (let channel = 0; channel < 3; channel++) {
      const b = buffers.length === 1 ? 0 : channel;
      const value = buffers[b][p];
      if (!Number.isFinite(value)) valid = false;
      image.data[p * 4 + channel] = Number.isFinite(value) ? Math.round(asinhStretch(value, ...limits[b]) * 255) : 0;
    }
    image.data[p * 4 + 3] = valid ? 255 : 0;
  }
  if (buffers.length === 3) {
    let fallback = 0;
    for (let p = 0; p < grid * grid; p++) if (!image.data[p * 4 + 3]) {
      const available = buffers.map((b, i) => Number.isFinite(b[p]) ? asinhStretch(b[p], ...limits[i]) : null).filter(v => v !== null);
      if (available.length) {
        const gray = Math.round(255 * available.reduce((a, b) => a + b, 0) / available.length);
        image.data.set([gray, gray, gray, 255], p * 4); fallback++;
      }
    }
    if (fallback) readout.textContent += `; ${fallback} pixels lack RGB coverage (grayscale)`;
  }
  ctx.putImageData(image, 0, 0);
  renderSkyOverlay();
}

function renderEpochLegend() {
  const container = document.getElementById("epoch-legend");
  container.innerHTML = "";
  if (!state.sky) return;
  state.sky.epochs.forEach((ep, idx) => {
    const chip = document.createElement("button");
    chip.className = "epoch-chip";
    chip.dataset.idx = String(idx);
    const inWin = ep.year >= state.winStart - 0.01 && ep.year <= state.winEnd + 0.01;
    chip.classList.add(inWin ? "in-window" : "out-window");
    const op = state.epochOps[idx] || "+";
    const opClass = op === "+" ? "op-plus" : op === "-" ? "op-minus" : "op-skip";
    chip.innerHTML = `<span class="epoch-op ${opClass}">${op}</span><span>${ep.label}</span>`;
    chip.addEventListener("click", () => {
      const order = ["+", "-", "."];
      const next = order[(order.indexOf(state.epochOps[idx]) + 1) % order.length];
      state.epochOps[idx] = next;
      renderEpochLegend();
      renderCurrentFrame();
    });
    container.appendChild(chip);
  });
}

function highlightEpochChip(activeIdx) {
  const chips = document.querySelectorAll(".epoch-chip");
  chips.forEach((chip) => {
    chip.classList.toggle("is-current", Number(chip.dataset.idx) === activeIdx);
  });
}

function updateTimelineCursor() {
  const active = getActiveEpochs();
  const epoch = state.mode === "blink" && active.length ? active[state.cursorEpochPos % active.length].ep : null;
  const cursor = d3.select("#timeline-svg .timeline-cursor");
  cursor.attr("visibility", epoch && timelineScale ? "visible" : "hidden");
  if (epoch && timelineScale) cursor.attr("x1", timelineScale(epoch.year)).attr("x2", timelineScale(epoch.year));
}

function displayedEpochs() {
  const active = getActiveEpochs();
  if (state.mode === "blink") {
    if (!active.length) return [];
    const slot = active[state.cursorEpochPos % active.length];
    if (state.detector === "rgb") {
      const channels = nearestRgbEpochs(active, slot.ep.mjd);
      if (channels.every(Boolean)) return [...new Map(channels.map(a => [a.idx, a])).values()];
    }
    return [slot];
  }
  if (state.detector === "rgb" && [1, 3, 5].every(d => active.some(a => a.ep.detectors.includes(d)))) {
    return active.filter(a => a.ep.detectors.some(d => [1, 3, 5].includes(d)));
  }
  return active;
}

const displayFlagMask = [0, 1, 2, 6, 7, 9, 10, 11, 15, 17, 19, 20, 22, 24, 27, 28].reduce((mask, bit) => mask | (1 << bit), 0);
function displayedFlagsAt(pixel, epochs = displayedEpochs()) {
  return epochs.reduce((bits, a) => bits | state.decoded.flags[a.idx * state.decoded.grid ** 2 + pixel], 0) & displayFlagMask;
}

function skyToPixel(ra, dec) {
  const rad = Math.PI / 180, d = dec * rad, d0 = state.dec * rad, dra = (ra - state.ra) * rad;
  const denominator = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(dra);
  if (denominator <= 0) return { px: NaN, py: NaN };
  const scale = state.sky.pixel_scale_arcsec / 3600 * rad, center = state.decoded.grid / 2;
  return {
    px: center - Math.cos(d) * Math.sin(dra) / denominator / scale,
    py: center - (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(dra)) / denominator / scale
  };
}

function catalogPosition(source, year) {
  const rad = Math.PI / 180, ra = source.ra * rad, dec = source.dec * rad;
  const propagated = Boolean(source.gaia && Number.isFinite(year) && Number.isFinite(source.reference_epoch)
    && Number.isFinite(source.gaia.pmra) && Number.isFinite(source.gaia.pmdec));
  let lon = source.ra, lat = source.dec;
  if (propagated) {
    const scale = (year - source.reference_epoch) * rad / 3600000;
    const east = source.gaia.pmra * scale, north = source.gaia.pmdec * scale;
    const x = Math.cos(dec) * Math.cos(ra) - east * Math.sin(ra) - north * Math.sin(dec) * Math.cos(ra);
    const y = Math.cos(dec) * Math.sin(ra) + east * Math.cos(ra) - north * Math.sin(dec) * Math.sin(ra);
    const z = Math.sin(dec) + north * Math.cos(dec);
    lon = Math.atan2(y, x) / rad; lat = Math.atan2(z, Math.hypot(x, y)) / rad;
  }
  return { ...source, ...skyToPixel(lon, lat), reference: skyToPixel(source.ra, source.dec), propagated };
}

function overlaySources() {
  const epochs = displayedEpochs();
  const mjds = epochs.map(a => a.ep.mjd);
  const year = mjds.length ? 2000 + ((Math.min(...mjds) + Math.max(...mjds)) / 2 - 51544.5) / 365.25 : null;
  return {
    year, sources: (state.sky.sources || [])
      .filter(s => (state.showGaia && s.gaia) || (state.showWise && s.wise))
      .map(s => catalogPosition(s, year))
      .filter(s => s.px >= 0 && s.py >= 0 && s.px < state.decoded.grid && s.py < state.decoded.grid)
  };
}

function renderSkyOverlay() {
  if (!state.sky) return;
  const svg = d3.select("#sky-overlay-svg");
  svg.selectAll("*").remove();

  const { sources, year } = overlaySources();
  const labels = [];
  const singleFrame = displayedEpochs().length === 1;
  if (state.showGaia) labels.push(`Gaia circles: PM estimate at ${singleFrame ? "frame" : "time-span midpoint"} ${year?.toFixed(2) || "reference epoch"}; missing PM stays at reference`);
  if (state.showWise) labels.push("WISE diamonds: catalog positions (not motion-corrected)");
  if (state.showFlags) labels.push(singleFrame ? "Squares: frame quality flags" : "Squares: union of contributing quality flags");
  const selected = sources.find(s => s.id === state.selectedSource?.id);
  if (selected) labels.push(`${selected.kind}: ${selected.name}${selected.propagated ? " · approximate PM-only position" : " · reference position"}`);
  document.getElementById("overlay-status").textContent = labels.join(" · ");

  if (state.showWise) {
    const wiseLayer = svg.append("g").attr("class", "wise-layer");
    wiseLayer.selectAll("path")
      .data(sources.filter((s) => s.wise))
      .join("path")
      .attr("data-source-id", d => d.id)
      .attr("d", "M 0 -.65 L .65 0 L 0 .65 L -.65 0 Z")
      .attr("transform", (d) => `translate(${d.px},${d.py})`)
      .attr("fill", "none")
      .attr("stroke", "#f59e0b")
      .attr("stroke-width", 0.12)
      .attr("opacity", 0.85);
  }

  if (state.showGaia) {
    const gaiaSources = sources.filter((s) => s.gaia);
    const gaiaLayer = svg.append("g").attr("class", "gaia-layer");

    gaiaLayer.selectAll("circle")
      .data(gaiaSources)
      .join("circle")
      .attr("data-source-id", d => d.id)
      .attr("cx", (d) => d.px)
      .attr("cy", (d) => d.py)
      .attr("r", 0.5)
      .attr("fill", "none")
      .attr("stroke", "#34d399")
      .attr("stroke-width", 0.12);

    // connect the catalog reference position to the proper-motion estimate at the displayed date.
    gaiaLayer.selectAll("line")
      .data(gaiaSources.filter(d => d.propagated && Math.hypot(d.px - d.reference.px, d.py - d.reference.py) > .2))
      .join("line")
      .attr("x1", (d) => d.reference.px)
      .attr("y1", (d) => d.reference.py)
      .attr("x2", (d) => d.px)
      .attr("y2", (d) => d.py)
      .attr("stroke", "#34d399")
      .attr("stroke-width", 0.25)
      .attr("opacity", 0.9);
  }

  if (state.showFlags && state.decoded.flags.length) {
    const epochs = displayedEpochs();
    const flagsToShow = [];
    const grid = state.decoded.grid;
    for (let p = 0; p < grid * grid; p++) {
      const bits = displayedFlagsAt(p, epochs);
      if (bits) flagsToShow.push({ x: p % grid + .5, y: Math.floor(p / grid) + .5, bits });
    }
    const flagLayer = svg.append("g").attr("class", "flags-layer");

    flagLayer.selectAll("rect")
      .data(flagsToShow)
      .join("rect")
      .attr("x", (d) => d.x - .5)
      .attr("y", (d) => d.y - .5)
      .attr("width", 1)
      .attr("height", 1)
      .attr("fill", "none")
      .attr("stroke", "#f59e0b")
      .attr("stroke-width", 0.08)
      .append("title").text(d => `Archive pixel flags: 0x${d.bits.toString(16)}`);
  }

  if (selected) {
    svg.append("circle")
      .attr("cx", selected.px)
      .attr("cy", selected.py)
      .attr("r", 2.4)
      .attr("fill", "none")
      .attr("stroke", "#38bdf8")
      .attr("stroke-width", 0.36);
  }
}

function fieldMeasurements() {
  const { grid, frames, wavelengths, nDet } = state.decoded;
  const size = grid * grid;
  return state.sky.epochs.flatMap((ep, i) => {
    const detector = ep.detectors[0] - 1;
    let sum = 0, wave = 0, count = 0;
    for (let p = 0; p < size; p++) {
      const v = frames[(i * nDet + detector) * size + p], w = wavelengths[i * size + p];
      if (Number.isFinite(v) && Number.isFinite(w)) { sum += v; wave += w; count++; }
    }
    return count ? [{ brightness: sum / count, wavelength_um: wave / count, detector, mjd: ep.mjd }] : [];
  }).sort((a, b) => a.wavelength_um - b.wavelength_um);
}

function spectralAnalysis(samples) {
  const n = samples.length;
  if (n < 4) return {};
  const delta = samples[1].wavelength_um - samples[0].wavelength_um;
  if (!(delta > 0) || samples.some((s, i) => !Number.isFinite(s.brightness) || !Number.isFinite(s.wavelength_um) || Math.abs(s.wavelength_um - samples[0].wavelength_um - i * delta) > delta * 1e-5)) return {};
  const coefficients = Array.from({ length: n }, (_, k) => samples.reduce((c, s, j) => [
    c[0] + s.brightness * Math.cos(2 * Math.PI * k * j / n), c[1] - s.brightness * Math.sin(2 * Math.PI * k * j / n)], [0, 0]));
  const limit = Math.floor(n / 2), bands = {};
  for (const name of ["low", "mid", "high"]) bands[name] = samples.map((_, j) => coefficients.reduce((sum, c, k) => {
    const mode = Math.min(k, n - k), fraction = mode / limit;
    const include = name === "low" ? fraction <= 1 / 3 : name === "mid" ? fraction > 1 / 3 && fraction <= 2 / 3 : fraction > 2 / 3;
    return sum + (include ? (c[0] * Math.cos(2 * Math.PI * k * j / n) - c[1] * Math.sin(2 * Math.PI * k * j / n)) / n : 0);
  }, 0));
  return {
    fft_amplitude: coefficients.slice(0, limit + 1).map(c => Math.hypot(...c)),
    fft_period_um: Array.from({ length: limit + 1 }, (_, k) => k ? n * delta / k : null), fft_bands: bands
  };
}

function demoSpectralSamples() {
  return Array.from({ length: 48 }, (_, i) => ({
    wavelength_um: .9 + i * .08, detector: 0, demo: true,
    brightness: 3 + Math.cos(2 * Math.PI * 3 * i / 48) + .5 * Math.cos(2 * Math.PI * 12 * i / 48) + .25 * Math.cos(2 * Math.PI * 20 * i / 48)
  }));
}

function renderSpectralCharts() {
  if (!state.sky) return;
  let measurements = state.sky.measurements || [];
  if (state.spectrumPixel) {
    const { grid, frames, wavelengths, nDet } = state.decoded;
    const pixel = state.spectrumPixel.y * grid + state.spectrumPixel.x;
    measurements = state.sky.epochs.flatMap((epoch, index) => {
      const detector = epoch.detectors[0] - 1;
      const brightness = frames[(index * nDet + detector) * grid * grid + pixel];
      const wavelength = wavelengths[index * grid * grid + pixel];
      return Number.isFinite(brightness) && Number.isFinite(wavelength)
        ? [{ brightness, wavelength_um: wavelength, detector, mjd: epoch.mjd }] : [];
    }).sort((a, b) => a.wavelength_um - b.wavelength_um);
  }
  let fieldFallback = false;
  if (!measurements.length) {
    fieldFallback = true;
    measurements = fieldMeasurements();
  }
  document.getElementById("sed-title").textContent = `${fieldFallback ? "Field mean (pixel unavailable)" : state.spectrumPixel ? "Selected-pixel" : "Center-pixel"} brightness · MJy/sr`;
  document.getElementById("sed-subtitle").textContent = `${measurements.length} observations \u00b7 different dates`;
  if (state.fftDemo) {
    measurements = demoSpectralSamples();
    document.getElementById("sed-title").textContent = "FFT DEMO · synthetic signal · arbitrary units";
    document.getElementById("sed-subtitle").textContent = `Not sky measurements · ${state.fftFilter} modes`;
  }
  document.getElementById("btn-fft-demo").classList.toggle("active", state.fftDemo);
  document.getElementById("btn-fft-demo").setAttribute("aria-pressed", String(state.fftDemo));
  const spectrum = fieldFallback && !state.fftDemo ? {} : spectralAnalysis(measurements);
  const filtered = spectrum.fft_bands?.[state.fftFilter];
  renderSedSvg(filtered ? measurements.map((m, i) => ({ ...m, brightness: filtered[i] })) : measurements);
  renderFftSvg({ ...spectrum, measurements });
}

function renderSedSvg(measurements) {
  const element = document.getElementById("sed-svg");
  const width = element.clientWidth || 440, height = element.clientHeight || 120;
  const svg = d3.select(element); svg.selectAll("*").remove();
  const margin = { top: 10, right: 12, bottom: 24, left: 42 };
  const w = width - margin.left - margin.right, h = height - margin.top - margin.bottom;
  const group = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  const x = d3.scaleLinear().domain([.75, 5]).range([0, w]);
  const values = measurements.map(m => m.brightness);
  const min = Math.min(0, d3.min(values) ?? 0), max = Math.max(min + 1, d3.max(values) ?? 1);
  const y = d3.scaleLinear().domain([min, max]).nice().range([h, 0]);
  group.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(6).tickFormat(v => `${v} \u00b5m`));
  group.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4));
  group.selectAll("circle").data(measurements).join("circle")
    .attr("cx", m => x(m.wavelength_um)).attr("cy", m => y(m.brightness)).attr("r", 3)
    .attr("fill", m => state.sky.detectors[m.detector].color)
    .append("title").text(m => m.demo ? `Synthetic: ${m.wavelength_um.toFixed(4)} µm · ${m.brightness.toPrecision(5)} arbitrary units`
      : `${m.wavelength_um.toFixed(4)} \u00b5m \u00b7 ${m.brightness.toPrecision(5)} MJy/sr \u00b7 MJD ${m.mjd.toFixed(3)}`);
  if (!measurements.length) group.append("text").attr("x", 4).attr("y", 16).attr("fill", "#94a3b8").text("No valid measurements at this pixel (masked or missing)");
}

function formatSpectralPeriod(period) {
  return period === null ? "DC" : `${d3.format(".3~g")(period)} \u00b5m`;
}

function renderFftSvg(source) {
  const element = document.getElementById("fft-svg");
  const svg = d3.select(element); svg.selectAll("*").remove();
  const amplitudes = source.fft_amplitude || [];
  document.getElementById("fft-subtitle").textContent = amplitudes.length ? `${state.fftDemo ? "Synthetic demo · " : ""}|FFT| · period in wavelength space` : "Uniform wavelength sampling required";
  if (!amplitudes.length) state.fftFilter = "raw";
  document.querySelectorAll("#fft-buttons .chip[data-fft]").forEach(button => {
    button.disabled = button.dataset.fft !== "raw" && !amplitudes.length;
    button.classList.toggle("active", button.dataset.fft === state.fftFilter);
    button.title = button.disabled ? "Requires at least four evenly spaced measured wavelengths" : "Filter the sampled spectrum";
  });
  if (!amplitudes.length) {
    svg.append("text").attr("x", 12).attr("y", 28).attr("fill", "#94a3b8").text("No FFT for sparse, unequal-wavelength samples.");
    const counts = Array.from({ length: 6 }, (_, d) => (source.measurements || []).filter(m => m.detector === d).length);
    const width = (element.clientWidth || 300) - 24;
    svg.selectAll("rect.coverage").data(counts).join("rect").attr("class", "coverage")
      .attr("x", (_, i) => 12 + i * width / 6).attr("y", 65).attr("width", width / 6 - 5)
      .attr("height", v => v * 5).attr("fill", (_, i) => state.sky.detectors[i].color);
    svg.selectAll("text.coverage").data(counts).join("text").attr("class", "coverage")
      .attr("x", (_, i) => 12 + i * width / 6).attr("y", 55).attr("fill", "#94a3b8").text((v, i) => `D${i + 1}: ${v}`);
    document.getElementById("fft-subtitle").textContent = "Observed coverage; FFT requires uniform samples";
    return;
  }
  const w = (element.clientWidth || 300) - 52, h = (element.clientHeight || 120) - 36;
  const group = svg.append("g").attr("transform", "translate(40,8)");
  const x = d3.scaleBand().domain(d3.range(amplitudes.length)).range([0, w]).padding(.15);
  const y = d3.scaleLinear().domain([0, d3.max(amplitudes) || 1]).range([h, 0]);
  group.selectAll("rect").data(amplitudes).join("rect").attr("x", (_, i) => x(i)).attr("y", y)
    .attr("width", x.bandwidth()).attr("height", v => h - y(v)).attr("fill", "#38bdf8");
  const ticks = [0, ...d3.range(1, amplitudes.length).filter(i => i % Math.max(1, Math.floor(amplitudes.length / 4)) === 0)];
  group.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`)
    .call(d3.axisBottom(x).tickValues(ticks).tickFormat(i => formatSpectralPeriod(source.fft_period_um[i])));
  group.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(3));
}

function renderTimelineBrush() {
  if (!state.sky) return;
  const svgEl = document.getElementById("timeline-svg");
  const w = svgEl.clientWidth || 300;
  const h = svgEl.clientHeight || 120;
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const margin = { top: 14, right: 12, bottom: 22, left: 12 };
  const iw = Math.max(40, w - margin.left - margin.right);
  const ih = Math.max(30, h - margin.top - margin.bottom);

  const epochs = state.sky.epochs;
  timelineScale = null;
  if (!epochs.length) {
    document.getElementById("time-subtitle").textContent = "No observed epochs";
    svg.append("text").attr("x", 12).attr("y", 28).attr("fill", "#94a3b8").text("Dates appear when observations are available.");
    return;
  }
  const minY = epochs[0].year - 0.04;
  const maxY = epochs[epochs.length - 1].year + 0.04;
  const x = d3.scaleLinear().domain([minY, maxY]).range([0, iw]);
  timelineScale = x;

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.selectAll("circle.ep-dot")
    .data(epochs)
    .join("circle")
    .attr("class", "ep-dot")
    .attr("cx", (d) => x(d.year))
    .attr("cy", ih * 0.5)
    .attr("r", 4.5)
    .attr("visibility", "hidden");

  g.selectAll("circle.ep-dot").append("title").text(d => `${d.label} (${d.source})`);

  const brush = d3.brushX()
    .extent([[0, 4], [iw, ih - 2]])
    .on("brush end", (event) => {
      if (!event.selection) return;
      const [x0, x1] = event.selection;
      const y0 = x.invert(x0);
      const y1 = x.invert(x1);
      state.winStart = Math.min(y0, y1);
      state.winEnd = Math.max(y0, y1);
      const span = Math.max(0.1, state.winEnd - state.winStart);
      document.getElementById("time-subtitle").textContent = `${span.toFixed(1)} yr (${state.winStart.toFixed(1)}–${state.winEnd.toFixed(1)})`;
      renderEpochLegend();
      renderCurrentFrame();
    });

  const brushG = g.append("g").attr("class", "brush").call(brush);
  brushG.call(brush.move, [x(state.winStart), x(state.winEnd)]);

  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(x).ticks(4).tickFormat(d3.format(".1f")));
  g.append("line").attr("class", "timeline-cursor").attr("y1", 4).attr("y2", ih - 2)
    .attr("stroke", "#38bdf8").attr("stroke-width", 1.5).style("pointer-events", "none");
  updateTimelineCursor();
}

function applyVisualTransform() {
  const frame = document.getElementById("zoom-frame");
  frame.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  document.getElementById("stat-zoom").textContent = `Zoom ${state.zoom.toFixed(1)}x`;
  syncUrlHash();
}

function triggerLoopFlash() {
  const ring = document.getElementById("loop-reset-ring");
  ring.classList.add("flash");
  window.setTimeout(() => ring.classList.remove("flash"), 140);
}

function restartBlinkLoop() {
  if (blinkTimer) window.clearInterval(blinkTimer);
  blinkTimer = window.setInterval(() => {
    if (!state.playing || state.mode !== "blink") return;
    const active = getActiveEpochs();
    if (active.length <= 1) return;
    state.cursorEpochPos = (state.cursorEpochPos + 1) % active.length;
    if (state.cursorEpochPos === 0) triggerLoopFlash();
    renderCurrentFrame();
  }, state.speedMs);
}

function aladinSurveySource(id) {
  return id === "P/allWISE/color"
    ? "https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1"
    : id;
}

function syncAladinView() {
  if (!state.showAladin) return;
  const pane = document.getElementById("aladin-pane");
  pane.classList.remove("hidden");
  const statusEl = document.getElementById("aladin-status");

  if (!window.A) {
    statusEl.textContent = "Loading Aladin survey viewer…";
    if (!aladinLoading) {
      aladinLoading = import("./vendor/aladin-3.8.2.js").then(module => {
        window.A = module.default;
        syncAladinView();
      }).catch(error => {
        aladinLoading = null;
        statusEl.textContent = "The survey viewer could not load. Toggle Aladin to retry; cached SPHEREx images remain available.";
      });
    }

    return;
  }

  window.A.init.then(() => {
    const fovDeg = state.fov / 3600.0;
    if (!state.aladinInstance) {
      state.aladinInstance = window.A.aladin("#aladin-lite-div", {
        survey: aladinSurveySource(state.aladinSurvey), target: `${state.ra} ${state.dec}`,
        fov: state.aladinFov || fovDeg, log: false
      });
      state.aladinInstance.on("zoomChanged", value => {
        const width = Array.isArray(value) ? value[0] : value;
        if (Number.isFinite(width) && width > 0) state.aladinFov = width;
      });
    } else {
      state.aladinInstance.gotoRaDec(state.ra, state.dec);
    }
    statusEl.textContent = `Survey imagery; catalog markers are in the main view. Synced to RA ${state.ra.toFixed(4)}°, Dec ${state.dec.toFixed(4)}°`;
  }).catch(() => {
    statusEl.textContent = "The survey viewer is unavailable. Cached SPHEREx images remain available.";
  });
}

function pixelToSky(px, py) {
  const radians = Math.PI / 180;
  const scale = state.sky.pixel_scale_arcsec / 3600 * radians;
  const xi = (32 - px) * scale, eta = (32 - py) * scale;
  const dec0 = state.dec * radians;
  const denominator = Math.cos(dec0) - eta * Math.sin(dec0);
  const ra = state.ra + Math.atan2(xi, denominator) / radians;
  const dec = Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.hypot(denominator, xi)) / radians;
  return { ra: ((ra % 360) + 360) % 360, dec };
}

function canvasPointToPixel(ev) {
  const canvas = document.getElementById("sky-canvas");
  const rect = canvas.getBoundingClientRect();
  const px = ((ev.clientX - rect.left) / rect.width) * 64.0;
  const py = ((ev.clientY - rect.top) / rect.height) * 64.0;
  return { px, py };
}

function bindEvents() {
  document.getElementById("btn-go-coords").addEventListener("click", () => {
    const ra = Number.parseFloat(document.getElementById("input-ra").value);
    const dec = Number.parseFloat(document.getElementById("input-dec").value);
    if (Number.isFinite(ra) && Number.isFinite(dec)) querySky(ra, dec);
  });

  document.getElementById("preset-select").addEventListener("change", (ev) => {
    const idx = Number.parseInt(ev.target.value, 10);
    const preset = state.config.preset_targets[idx];
    if (preset) querySky(preset.ra, preset.dec, preset.fov || state.fov);
  });

  document.getElementById("btn-random").addEventListener("click", () => {
    const randRa = Math.random() * 360.0;
    const randDec = (Math.random() * 160.0) - 80.0;
    querySky(randRa, randDec, state.fov);
  });

  document.getElementById("release-select").addEventListener("change", (ev) => {
    querySky(state.ra, state.dec, state.fov, state.windowYears, ev.target.value);
  });

  document.getElementById("btn-reload-releases").addEventListener("click", async () => {
    try {
      const resp = await fetch("/api/releases/reload", { method: "POST" });
      if (!resp.ok) throw new Error("Release discovery unavailable");
      const data = await resp.json();
      if (data.releases) populateReleases(data.releases);
      setDataStatus("Release list updated. Choose a release to load observations.");
    } catch {
      setDataStatus("Release updates are temporarily unavailable. Your current view and release list are preserved.");
    }
  });

  document.getElementById("btn-copy-url").addEventListener("click", async () => {
    syncUrlHash();
    const shareUrl = window.location.href;
    try {
      await navigator.clipboard.writeText(shareUrl);
      document.getElementById("btn-copy-url").textContent = "Copied!";
      window.setTimeout(() => { document.getElementById("btn-copy-url").textContent = "Share URL"; }, 1200);
    } catch {
      window.prompt("Embeddable SPHEREx URL:", shareUrl);
    }
  });

  document.querySelectorAll(".mode-btn[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn[data-mode]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.mode = btn.dataset.mode;
      renderCurrentFrame();
      syncUrlHash();
    });
  });

  document.getElementById("btn-play-pause").addEventListener("click", (ev) => {
    state.playing = !state.playing;
    ev.target.textContent = state.playing ? "Pause" : "Play";
  });

  document.getElementById("btn-speed").addEventListener("click", (ev) => {
    const steps = [120, 220, 420];
    state.speedMs = steps[(steps.indexOf(state.speedMs) + 1) % steps.length];
    ev.target.textContent = `${state.speedMs} ms`;
    restartBlinkLoop();
  });

  document.querySelectorAll("#detector-buttons .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#detector-buttons .chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.detector = btn.dataset.det;
      renderCurrentFrame();
      renderSpectralCharts();
      syncUrlHash();
    });
  });

  document.getElementById("btn-fft-demo").addEventListener("click", () => {
    state.fftDemo = !state.fftDemo;
    state.fftFilter = "raw";
    renderSpectralCharts();
    syncUrlHash();
  });
  document.querySelectorAll("#fft-buttons .chip[data-fft]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#fft-buttons .chip[data-fft]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.fftFilter = btn.dataset.fft;
      renderSpectralCharts();
      syncUrlHash();
    });
  });

  document.getElementById("input-fov").addEventListener("change", event => {
    querySky(state.ra, state.dec, Number(event.target.value));
  });

  document.querySelectorAll("#fov-buttons .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#fov-buttons .chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      querySky(state.ra, state.dec, Number.parseFloat(btn.dataset.fov));
    });
  });

  document.getElementById("tog-gaia").addEventListener("click", (ev) => {
    state.showGaia = !state.showGaia;
    ev.target.classList.toggle("active", state.showGaia);
    renderSkyOverlay();
    syncUrlHash();
  });

  document.getElementById("tog-wise").addEventListener("click", (ev) => {
    state.showWise = !state.showWise;
    ev.target.classList.toggle("active", state.showWise);
    renderSkyOverlay();
    syncUrlHash();
  });

  document.getElementById("tog-flags").addEventListener("click", (ev) => {
    state.showFlags = !state.showFlags;
    ev.target.classList.toggle("active", state.showFlags);
    renderSkyOverlay();
    syncUrlHash();
  });

  document.getElementById("tog-invert").addEventListener("click", (ev) => {
    state.invert = !state.invert;
    ev.target.classList.toggle("active", state.invert);
    renderCurrentFrame();
    syncUrlHash();
  });

  document.getElementById("tog-aladin").addEventListener("click", (ev) => {
    state.showAladin = !state.showAladin;
    ev.target.classList.toggle("active", state.showAladin);
    document.getElementById("aladin-pane").classList.toggle("hidden", !state.showAladin);
    if (state.showAladin) syncAladinView();
  });

  document.getElementById("aladin-survey-select").addEventListener("change", (ev) => {
    state.aladinSurvey = ev.target.value;
    if (state.aladinInstance) state.aladinInstance.setImageSurvey(aladinSurveySource(state.aladinSurvey));
  });

  const stage = document.getElementById("viewport-stage");
  stage.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.15 : 0.87;
    state.zoom = Math.max(1.0, Math.min(8.0, state.zoom * factor));
    if (state.zoom <= 1.02) {
      state.zoom = 1.0;
      state.panX = 0;
      state.panY = 0;
    }
    applyVisualTransform();
  }, { passive: false });

  stage.addEventListener("dblclick", () => {
    state.zoom = 1.0;
    state.panX = 0;
    state.panY = 0;
    applyVisualTransform();
  });

  stage.addEventListener("mousedown", (ev) => {
    dragState = { x: ev.clientX, y: ev.clientY, px: state.panX, py: state.panY, moved: false };
  });

  window.addEventListener("mousemove", (ev) => {
    if (!dragState) return;
    const dx = ev.clientX - dragState.x;
    const dy = ev.clientY - dragState.y;
    if (Math.hypot(dx, dy) > 4) dragState.moved = true;
    if (dragState.moved && state.zoom > 1.0) {
      state.panX = dragState.px + dx;
      state.panY = dragState.py + dy;
      applyVisualTransform();
    }
  });

  window.addEventListener("mouseup", () => {
    suppressClick = Boolean(dragState?.moved);
    dragState = null;
  });

  stage.addEventListener("mousemove", (ev) => {
    if (!state.sky) return;
    const { px, py } = canvasPointToPixel(ev);
    if (px < 0 || px >= 64 || py < 0 || py >= 64) return;
    const { ra: cursorRa, dec: cursorDec } = pixelToSky(px, py);

    const pixel = Math.floor(py) * state.decoded.grid + Math.floor(px);
    const flags = displayedFlagsAt(pixel);
    const tip = document.getElementById("flag-tooltip");
    if (flags && state.showFlags) {
      const stageRect = stage.getBoundingClientRect();
      const names = (state.config.flags_bitmask || []).filter(f => flags & (1 << f.bit)).map(f => f.label);
      tip.textContent = `Quality flags: ${names.join(", ") || "flagged pixel"} (0x${flags.toString(16)})`;
      tip.style.left = `${ev.clientX - stageRect.left + 12}px`;
      tip.style.top = `${ev.clientY - stageRect.top - 12}px`;
      tip.classList.remove("hidden");
    } else {
      tip.classList.add("hidden");
    }

    document.getElementById("hover-readout").textContent =
      `RA ${cursorRa.toFixed(4)}° Dec ${cursorDec.toFixed(4)}° · px (${px.toFixed(1)}, ${py.toFixed(1)})`;
  });

  stage.addEventListener("click", (ev) => {
    if (suppressClick) { suppressClick = false; return; }
    if (!state.sky) return;
    const { px, py } = canvasPointToPixel(ev);
    if (px < 0 || px >= 64 || py < 0 || py >= 64) return;
    if (ev.shiftKey) {
      const target = pixelToSky(px, py);
      querySky(target.ra, target.dec);
      return;
    }

    let best = null;
    let bestD2 = 36;
    for (const src of overlaySources().sources) {
      const d2 = (src.px - px) ** 2 + (src.py - py) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = src;
      }
    }
    state.selectedSource = best;
    state.spectrumPixel = { x: Math.floor(px), y: Math.floor(py) };
    renderSkyOverlay();
    renderSpectralCharts();
  });

  window.addEventListener("resize", () => {
    if (state.sky) {
      renderSpectralCharts();
      renderTimelineBrush();
    }
  });
}

function populateReleases(releases) {
  const select = document.getElementById("release-select");
  select.innerHTML = "";
  releases.forEach((rel) => {
    const opt = document.createElement("option");
    opt.value = rel.id;
    opt.textContent = rel.label || rel.id;
    select.appendChild(opt);
  });
  select.value = state.releaseId;
}

function populatePresets(presets) {
  const select = document.getElementById("preset-select");
  select.innerHTML = "";
  presets.forEach((p, idx) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = p.name;
    select.appendChild(opt);
  });
}

async function prefetchPresetsBatch(presets) {
  if (!presets || presets.length === 0) return;
  const queries = presets.map((p) => ({
    ra: p.ra,
    dec: p.dec,
    fov: p.fov || 300,
    window: state.windowYears,
    release: state.releaseId
  }));
  try {
    const resp = await fetch("/api/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries })
    });
    const data = await resp.json();
    (data.results || []).forEach((sky) => {
      rememberSky(sky);
    });
  } catch {
    return;
  }
}

async function init() {
  const hasUrlCoords = parseUrlParams();
  bindEvents();

  const stateResp = await fetch("/api/state");
  const boot = await stateResp.json();
  if (!stateResp.ok) throw new Error("Could not initialize sky viewer");
  state.config = boot.config;
  populateReleases(boot.config.releases);
  populatePresets(boot.config.preset_targets);
  if (!hasUrlCoords) {
    state.ra = boot.config.preset_targets[0].ra;
    state.dec = boot.config.preset_targets[0].dec;
  }
  await querySky(state.ra, state.dec, state.fov, state.windowYears, state.releaseId);

  applyVisualTransform();
  restartBlinkLoop();
  prefetchPresetsBatch(boot.config.preset_targets);
}

init().catch(() => setDataStatus("Unable to load the viewer. Check that the local server is running, then reload this page."));
