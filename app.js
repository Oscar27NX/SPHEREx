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
  aladinSurvey: "P/allWISE/color",
  staticDemo: false
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

function parseCoordinate(value, isRa = false) {
  if (typeof value === "number") return value;
  const raw = String(value ?? "").trim();
  if (!raw) return NaN;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?°?$/i.test(raw)) return Number(raw.replace(/°$/, ""));
  const m = raw.match(/^([+-])?\s*(\d+(?:\.\d+)?)\s*([hd°:\s])\s*(\d+(?:\.\d+)?)\s*(?:[m'′:\s]\s*(\d+(?:\.\d+)?))?\s*[s"″]?$/i);
  if (!m) return NaN;
  const deg = Number(m[2]), min = Number(m[4]), sec = Number(m[5] || 0);
  if (min >= 60 || sec >= 60) return NaN;
  const sign = m[1] === "-" ? -1 : 1;
  const scale = isRa && !/[d°]/i.test(m[3]) ? 15 : 1;
  return sign * (deg + min / 60 + sec / 3600) * scale;
}

function resolveKnownCoords(ra, dec, tol = 2e-4) {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return [ra, dec];
  const candidates = [];
  if (state.sky?.epochs?.length && state.sky.data_status !== "error") candidates.push(state.sky);
  if (state.config?.preset_targets) candidates.push(...state.config.preset_targets);
  if (state.config?.cached_targets) candidates.push(...state.config.cached_targets);
  for (const entry of state.clientCache.values()) {
    if (entry?.sky?.epochs?.length && entry.sky.data_status !== "error") candidates.push(entry.sky);
  }
  let best = null, bestD2 = tol * tol;
  for (const c of candidates) {
    if (!Number.isFinite(c?.ra) || !Number.isFinite(c?.dec)) continue;
    const dra = Math.abs((((c.ra - ra + 180) % 360) + 360) % 360 - 180);
    const ddec = Math.abs(c.dec - dec);
    if (dra < tol && ddec < tol) {
      const d2 = dra * dra + ddec * ddec;
      if (!best || d2 < bestD2) {
        best = [c.ra >= 0 && c.ra < 360 ? c.ra : ((c.ra % 360) + 360) % 360, c.dec];
        bestD2 = d2;
      }
    }
  }
  return best || [ra, dec];
}

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
    const parsedRa = parseCoordinate(merged.get("ra"), true);
    const parsedDec = parseCoordinate(merged.get("dec"), false);
    if (Number.isFinite(parsedRa)) state.ra = ((parsedRa % 360) + 360) % 360;
    if (Number.isFinite(parsedDec)) state.dec = Math.max(-89.9, Math.min(89.9, parsedDec));
    [state.ra, state.dec] = resolveKnownCoords(state.ra, state.dec);
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
  const grid = sky.grid_size, nEpochs = sky.epochs.length, nDet = sky.detectors.length;
  let frames;
  if (sky.frames_1d_b64 && !sky.frames_b64) {
    const planes = decodeBase64Typed(sky.frames_1d_b64, Float32Array);
    const size = grid * grid;
    frames = new Float32Array(nEpochs * nDet * size);
    frames.fill(NaN);
    for (let e = 0; e < nEpochs; e += 1) {
      const d = (sky.epochs[e]?.detectors?.[0] || 1) - 1;
      frames.set(planes.subarray(e * size, (e + 1) * size), (e * nDet + d) * size);
    }
  } else {
    frames = decodeBase64Typed(sky.frames_b64, Float32Array);
  }
  return {
    frames,
    wavelengths: decodeBase64Typed(sky.wavelength_maps_b64, Float32Array),
    bandwidths: decodeBase64Typed(sky.bandwidth_maps_b64, Float32Array),
    flags: decodeBase64Typed(sky.flags_b64, Uint32Array),
    grid,
    nEpochs,
    nDet
  };
}

function skyCacheKey(ra, dec, fov, win, releaseId, sampling = "preview") {
  return `${ra.toFixed(6)}|${dec.toFixed(6)}|${fov.toFixed(3)}|${win.toFixed(3)}|${releaseId}${sampling === "rgb" ? "|rgb" : ""}`;
}

function updateEpochSelection(previousSky, sky, sameView) {
  const identity = ep => `${ep.source}|${ep.mjd}|${ep.detectors.join(",")}`;
  const preserve = sameView && previousSky?.epochs.length && sky.epochs.length;
  const previousActive = getActiveEpochs();
  const cursorMjd = previousActive[state.cursorEpochPos % previousActive.length]?.ep.mjd;
  const operations = new Map((previousSky?.epochs || []).map((ep, i) => [identity(ep), state.epochOps[i] || "+"]));
  state.epochOps = sky.epochs.map(ep => preserve ? operations.get(identity(ep)) || "+" : "+");
  const margin = epochWindowMargin();
  if (!preserve || state.winStart <= previousSky.epochs[0].year + margin) state.winStart = sky.epochs[0]?.year ?? 0;
  if (!preserve || state.winEnd >= previousSky.epochs.at(-1).year - margin) state.winEnd = sky.epochs.at(-1)?.year ?? 0;
  state.cursorEpochPos = 0;
  if (preserve && Number.isFinite(cursorMjd)) {
    const active = sky.epochs.filter((ep, i) => ep.year >= state.winStart - margin && ep.year <= state.winEnd + margin
      && state.epochOps[i] !== "." && (!state.detector.startsWith("D") || ep.detectors.includes(Number(state.detector.slice(1)))));
    active.forEach((ep, i) => {
      if (Math.abs(ep.mjd - cursorMjd) < Math.abs(active[state.cursorEpochPos].mjd - cursorMjd)) state.cursorEpochPos = i;
    });
  }
}

function applySkyData(sky) {
  const sameView = state.sky && skyCacheKey(state.ra, state.dec, state.fov, state.windowYears, state.releaseId)
    === skyCacheKey(sky.ra, sky.dec, sky.fov, sky.window, sky.release.id);
  const sameEpochs = state.sky && state.ra === sky.ra && state.dec === sky.dec
    && JSON.stringify(state.sky.epochs) === JSON.stringify(sky.epochs);
  if (!sameEpochs) updateEpochSelection(state.sky, sky, sameView);
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
  document.getElementById("retrieval-label").textContent = (state.detector === "rgb" ? "Loading more RGB observations · " : "")
    + (phases[progress?.phase] || "Contacting the archive")
    + (progress?.total ? ` · ${progress.completed}/${progress.total} images checked` : "")
    + (progress?.elapsed_seconds ? ` · ${progress.elapsed_seconds}s elapsed` : "")
    + ". You can switch to a cached preset while waiting.";
}

function rememberSky(sky) {
  if (sky.preview || (sky.data_status !== "ready" && sky.data_status !== "empty")) return;
  if (state.clientCache.size >= 32) state.clientCache.delete(state.clientCache.keys().next().value);
  state.clientCache.set(skyCacheKey(sky.ra, sky.dec, sky.fov, sky.window, sky.release.id, sky.sampling), { sky, at: Date.now() });
}

function cachedSkyPreview(ra, dec, fov, win, releaseId, sampling = "preview") {
  const candidates = Array.from(state.clientCache.values(), entry => entry.sky)
    .filter(s => s.epochs?.length && Math.abs((((s.ra - ra + 180) % 360) + 360) % 360 - 180) < 2e-4 && Math.abs(s.dec - dec) < 2e-4 && s.window >= win)
    .sort((a, b) => (sampling === "rgb" ? Number(a.sampling !== "rgb") - Number(b.sampling !== "rgb") : 0)
      || Number(a.fov < fov) - Number(b.fov < fov) || Math.abs(a.fov - fov) - Math.abs(b.fov - fov)
      || b.epochs.length - a.epochs.length);
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
    sky.sources = sky.sources.filter(s => {
      if (s.px >= 0 && s.px < grid && s.py >= 0 && s.py < grid) return true;
      if (!s.gaia || !Number.isFinite(s.pmra_mas_yr) || !Number.isFinite(s.pmdec_mas_yr)) return false;
      const dt = 2026.5 - (s.reference_epoch || 2016.0);
      const scale = fov / grid;
      const ppx = s.px - (s.pmra_mas_yr * dt / 1000) / scale;
      const ppy = s.py - (s.pmdec_mas_yr * dt / 1000) / scale;
      return ppx >= 0 && ppx < grid && ppy >= 0 && ppy < grid;
    });
    decodedCache.set(sky, decoded);
    return sky;
  }
  return null;
}

function findPresetIndex(ra, dec) {
  const presets = state.config?.preset_targets || [];
  let bestIdx = -1, bestD2 = Infinity;
  for (let i = 0; i < presets.length; i += 1) {
    const p = presets[i];
    const tol = Math.max(p.fov || 300, 600) / 7200;
    const refs = [[p.ra, p.dec]];
    if (Number.isFinite(p.catalog_ra) && Number.isFinite(p.catalog_dec)) {
      refs.push([p.catalog_ra, p.catalog_dec]);
    }
    for (const [refRa, refDec] of refs) {
      const dra = Math.abs((((refRa - ra + 180) % 360) + 360) % 360 - 180);
      const ddec = Math.abs(refDec - dec);
      if (dra <= tol && ddec <= tol) {
        const d2 = dra * dra + ddec * ddec;
        if (d2 < bestD2) { bestIdx = i; bestD2 = d2; }
      }
    }
  }
  return bestIdx;
}

async function fetchStaticSky(ra, dec, fov, win, releaseId, sampling, signal) {
  const idx = findPresetIndex(ra, dec);
  if (idx < 0) {
    return {
      release: { id: releaseId }, ra, dec, fov, window: win, grid_size: 64, pixel_scale_arcsec: fov / 64,
      detectors: state.config?.detectors || [], epochs: [], sources: [], flag_events: [],
      frames_b64: "", flags_b64: "", wavelength_maps_b64: "", bandwidth_maps_b64: "", measurements: [],
      spectral_fft: null, data_status: "empty", refreshing: false, requested_sampling: sampling,
      message: "Static demo mode: choose one of the 5 pre-cached NASA targets, or run server.py locally for live IRSA queries."
    };
  }
  const preset = state.config.preset_targets[idx];
  const fovs = sampling === "rgb" ? [150, 300, 600] : [150, 300, 600, 1200];
  const baseFov = fovs.find(f => f >= fov) || fovs[fovs.length - 1];
  const baseKey = skyCacheKey(preset.ra, preset.dec, baseFov, 10, "auto", sampling);
  let baseSky = state.clientCache.get(baseKey)?.sky;
  if (!baseSky) {
    const resp = await fetch(`data/sky-${idx}-${baseFov}-${sampling}.json`, { signal });
    if (!resp.ok) throw new Error("Static preset unavailable");
    baseSky = await resp.json();
    rememberSky(baseSky);
  }
  if (Math.round(fov) === baseFov && Math.abs(win - 10) < 1e-3 && releaseId === "auto") {
    const exact = { ...baseSky, preview: false, refreshing: false, requested_sampling: sampling };
    if (decodedCache.has(baseSky)) decodedCache.set(exact, decodedCache.get(baseSky));
    return exact;
  }
  const derived = cachedSkyPreview(preset.ra, preset.dec, fov, win, releaseId, sampling);
  if (!derived) {
    const fallback = { ...baseSky, preview: false, refreshing: false, requested_sampling: sampling };
    if (decodedCache.has(baseSky)) decodedCache.set(fallback, decodedCache.get(baseSky));
    return fallback;
  }
  const finalSky = {
    ...derived,
    preview: false,
    refreshing: false,
    sampling: baseSky.sampling || sampling,
    requested_sampling: sampling,
    data_status: derived.epochs.length ? "ready" : "empty",
    message: derived.epochs.length
      ? `${derived.epochs.length} observed cutouts · MJy/sr`
      : "No SPHEREx images in this field and time window"
  };
  decodedCache.set(finalSky, decodedCache.get(derived));
  return finalSky;
}

async function querySky(ra, dec, fov = state.fov, win = state.windowYears, releaseId = state.releaseId, fromRandom = false) {
  const serial = ++requestSerial;
  clearTimeout(refreshTimer);
  skyController?.abort();
  skyController = new AbortController();
  if (![ra, dec, fov, win].every(Number.isFinite) || dec < -90 || dec > 90 || fov < 60 || fov > 1800) {
    setDataStatus("Enter valid coordinates and a FOV between 60 and 1800 arcseconds.");
    return;
  }
  if (fromRandom && state.staticDemo) {
    const pool = state.config?.preset_targets || [];
    const others = pool.filter(t => Math.abs(t.ra - state.ra) > 1e-3 || Math.abs(t.dec - state.dec) > 1e-3);
    const picks = others.length ? others : pool;
    if (picks.length) {
      const chosen = picks[Math.floor(Math.random() * picks.length)];
      ra = chosen.ra;
      dec = chosen.dec;
      fov = chosen.fov || fov;
      fromRandom = false;
    }
  }
  ra = ((ra % 360) + 360) % 360;
  [ra, dec] = resolveKnownCoords(ra, dec);
  const sampling = state.detector === "rgb" ? "rgb" : "preview";
  const key = skyCacheKey(ra, dec, fov, win, releaseId, sampling);
  const cached = state.clientCache.get(key);
  const preview = cached ? null : (sampling === "rgb" ? cachedSkyPreview(ra, dec, fov, win, releaseId, sampling) : null)
    || state.clientCache.get(skyCacheKey(ra, dec, fov, win, releaseId))?.sky
    || cachedSkyPreview(ra, dec, fov, win, releaseId);
  if (cached || preview) applySkyData(cached?.sky || preview);
  else setDataStatus("Loading live IRSA cutouts…");
  showRetrieval(null, true);
  let timedOut = false;
  const controller = skyController;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    const params = new URLSearchParams({ ra, dec, fov, window: win, release: releaseId, sampling });
    let sky;
    if (state.staticDemo) {
      sky = await fetchStaticSky(ra, dec, fov, win, releaseId, sampling, skyController.signal);
    } else {
      const resp = await fetch(`/api/sky?${params}`, { signal: skyController.signal });
      if (!resp.ok) {
        if (resp.status === 404) {
          state.staticDemo = true;
          sky = await fetchStaticSky(ra, dec, fov, win, releaseId, sampling, skyController.signal);
        } else {
          throw new Error("Archive unavailable");
        }
      } else {
        sky = await resp.json();
      }
    }
    if (serial !== requestSerial) return;
    if (sky.data_status === "error" && fromRandom) {
      const pool = (state.config?.cached_targets?.length ? state.config.cached_targets : state.config?.preset_targets) || [];
      const others = pool.filter(t => Math.abs(t.ra - state.ra) > 1e-3 || Math.abs(t.dec - state.dec) > 1e-3);
      const picks = others.length ? others : pool;
      if (picks.length) {
        const chosen = picks[Math.floor(Math.random() * picks.length)];
        return querySky(chosen.ra, chosen.dec, fov, win, releaseId, false);
      }
    }
    showRetrieval(sky);
    rememberSky(sky);
    const richerPreview = sky.preview && state.sky?.sampling === "rgb" && state.sky.epochs.length > sky.epochs.length
      && skyCacheKey(state.sky.ra, state.sky.dec, state.sky.fov, state.sky.window, state.sky.release.id)
      === skyCacheKey(sky.ra, sky.dec, sky.fov, sky.window, sky.release.id);
    if (!richerPreview) {
      if (sky.epochs?.length || (!cached && !preview) || sky.data_status === "empty") applySkyData(sky);
      else setDataStatus("Refreshing cached observations. The archive is temporarily unavailable.");
    }
    if (!state.staticDemo && (sky.data_status === "loading" || sky.refreshing)) {
      refreshTimer = setTimeout(() => {
        if (serial === requestSerial) querySky(ra, dec, fov, win, releaseId, fromRandom);
      }, sky.epochs?.length ? 2000 : 500);
    } else if (!state.staticDemo && ["ready", "empty", "error"].includes(sky.data_status)) {
      refreshTimer = setTimeout(() => {
        if (serial === requestSerial) querySky(ra, dec, fov, win, releaseId, false);
      }, 60000);
    }
  } catch (error) {
    if ((error.name !== "AbortError" || timedOut) && serial === requestSerial) {
      showRetrieval();
      setDataStatus("Unable to contact the archive. Your current view is preserved; retrying shortly.");
      refreshTimer = setTimeout(() => {
        if (serial === requestSerial) querySky(ra, dec, fov, win, releaseId, false);
      }, 10000);
    }
  } finally { clearTimeout(timeout); }
}

function epochWindowMargin() {
  return 0.01;
}

function getActiveEpochs() {
  if (!state.sky) return [];
  const margin = epochWindowMargin();
  const active = [];
  for (let i = 0; i < state.sky.epochs.length; i += 1) {
    const ep = state.sky.epochs[i];
    const inWin = ep.year >= state.winStart - margin && ep.year <= state.winEnd + margin;
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

function smoothSpatialPlane(buf, grid) {
  const original = buf.slice();
  for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) {
    let sum = 0, hits = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
      const value = original[ny * grid + nx];
      if (Number.isFinite(value)) { sum += value; hits++; }
    }
    buf[y * grid + x] = Number.isFinite(original[y * grid + x]) && hits ? sum / hits : NaN;
  }
}

function detectorBandIndex(wavelengthUm) {
  if (!Number.isFinite(wavelengthUm)) return -1;
  if (wavelengthUm >= 0.70 && wavelengthUm <= 1.095) return 0;
  if (wavelengthUm > 1.095 && wavelengthUm <= 1.625) return 1;
  if (wavelengthUm > 1.625 && wavelengthUm <= 2.415) return 2;
  if (wavelengthUm > 2.415 && wavelengthUm <= 3.825) return 3;
  if (wavelengthUm > 3.825 && wavelengthUm <= 4.415) return 4;
  if (wavelengthUm > 4.415 && wavelengthUm <= 5.05) return 5;
  return -1;
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
  if (detSpec === "fft2d") smoothSpatialPlane(outBuf, grid);
}

function accumulateComposite(active, detSpec, outBuf) {
  if (state.mode === "diff" && (detSpec === "all" || detSpec === "fft2d") && active.some(a => a.ep?.detectors?.length)) {
    const bandBuf = new Float32Array(outBuf.length);
    const sum = new Float64Array(outBuf.length);
    const hits = new Uint16Array(outBuf.length);
    for (let d = 1; d <= 6; d += 1) {
      const detActive = active.filter(a => a.ep.detectors.includes(d));
      if (detActive.length < 2) continue;
      accumulateComposite(detActive, `D${d}`, bandBuf);
      for (let p = 0; p < outBuf.length; p += 1) {
        if (Number.isFinite(bandBuf[p])) { sum[p] += bandBuf[p]; hits[p] += 1; }
      }
    }
    for (let p = 0; p < outBuf.length; p += 1) outBuf[p] = hits[p] ? sum[p] / hits[p] : NaN;
    if (detSpec === "fft2d") smoothSpatialPlane(outBuf, state.decoded.grid);
    return;
  }
  const entries = detSpec.startsWith("D") && active.some(a => a.ep?.detectors?.length)
    ? active.filter(a => a.ep.detectors.includes(Number(detSpec.slice(1)))) : active;
  if (!entries.length) { outBuf.fill(NaN); return; }
  const tmp = new Float32Array(outBuf.length);
  const positive = new Float64Array(outBuf.length), negative = new Float64Array(outBuf.length);
  const plusCount = new Uint16Array(outBuf.length), minusCount = new Uint16Array(outBuf.length);
  const firstBand = state.mode === "diff" ? new Int8Array(outBuf.length).fill(-1) : null;
  const compat = state.mode === "diff" ? new Uint8Array(outBuf.length).fill(1) : null;
  const wavelengths = state.decoded?.wavelengths;
  const explicitMinus = entries.some(a => a.op === "-");
  entries.forEach((entry, index) => {
    samplePlane(entry.idx, detSpec, tmp);
    const minus = entry.op === "-" || (state.mode === "diff" && !explicitMinus && index < Math.floor(entries.length / 2));
    for (let p = 0; p < outBuf.length; p++) if (Number.isFinite(tmp[p])) {
      if (state.mode === "diff") {
        // compare epochs across the same detector color band rather than exact sub-channel wavelengths.
        const w = wavelengths?.[entry.idx * outBuf.length + p];
        const band = entry.ep?.detectors?.length === 1 && Number.isFinite(w)
          ? entry.ep.detectors[0] - 1
          : detectorBandIndex(w);
        if (band < 0) compat[p] = 0;
        else if (firstBand[p] === -1) firstBand[p] = band;
        else if (band !== firstBand[p]) compat[p] = 0;
      }
      if (minus) { negative[p] += tmp[p]; minusCount[p]++; }
      else { positive[p] += tmp[p]; plusCount[p]++; }
    }
  });
  for (let p = 0; p < outBuf.length; p++) {
    if (state.mode === "diff") {
      outBuf[p] = compat[p] && plusCount[p] && minusCount[p] ? positive[p] / plusCount[p] - negative[p] / minusCount[p] : NaN;
    }
    else outBuf[p] = plusCount[p] + minusCount[p] ? (positive[p] - negative[p]) / (plusCount[p] + minusCount[p]) : NaN;
  }
}

function stretchLimits(buffers, difference) {
  const values = new Float64Array(buffers.reduce((count, buffer) => count + buffer.length, 0));
  let count = 0;
  for (const buffer of buffers) for (const value of buffer) if (Number.isFinite(value)) values[count++] = value;
  if (!count) return [0, 1];
  const finite = values.subarray(0, count);
  finite.sort();
  const lo = finite[Math.floor((count - 1) * .01)];
  const hi = finite[Math.floor((count - 1) * .99)];
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

function rgbPlaybackPositions(active) {
  const positions = [];
  let previous = null;
  active.forEach((entry, position) => {
    const channels = nearestRgbEpochs(active, entry.ep.mjd);
    const key = channels.every(Boolean) ? `rgb:${channels.map(a => a.idx).join(",")}` : `gray:${entry.idx}`;
    if (key !== previous) positions.push(position);
    previous = key;
  });
  return positions;
}

function nextPlaybackPosition(active, current, detector = state.detector) {
  if (!active.length) return 0;
  current %= active.length;
  if (detector !== "rgb") return (current + 1) % active.length;
  const positions = rgbPlaybackPositions(active);
  if (positions.length <= 1) return current;
  return positions.find(position => position > current) ?? positions[0];
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
  if (state.mode === "diff" && active.length < 2) {
    showEmpty("Select at least two epochs to compare same-band observations");
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
      const positions = rgbPlaybackPositions(active);
      const current = state.cursorEpochPos % active.length;
      const frame = positions.filter(position => position <= current).length;
      readout.textContent = `RGB ${frame}/${positions.length} · ${labels.join(" / ")} · ${span.toFixed(1)} d span; non-simultaneous`
        + (positions.length === 1 ? ". Only one RGB combination; widen the time brush to compare." : "");
      readout.title = `Cursor: ${slot.ep.label}\n` + rgbEpochs.map((a, i) => `${labels[i]} · ${a.ep.source} · MJD ${a.ep.mjd.toFixed(5)}`).join("\n")
        + "\nPlayback skips unchanged channel selections; date intervals are not uniform. No temporal smoothing or interpolation."
        + "\nFalse-color visualization of real observations; channel stretches are independent. Not simultaneous photometry or a motion measurement.";
    }
    highlightEpochChip(slot.idx);
  } else {
    specs.forEach((spec, i) => accumulateComposite(active, spec, buffers[i]));
    readout.textContent = state.mode === "diff" ? "Difference preview · same-band epoch subtraction"
      : `Mean of ${active.length} observations · mixed wavelengths`;
    highlightEpochChip(-1);
  }
  if (missing.length && state.detector === "rgb") readout.textContent += ` · RGB needs ${missing.join(", ")} in this time window; showing available data in grayscale. Widen the brush or choose another release.`;
  const limits = specs.map((spec, i) => {
    const key = `${spec}|${state.mode}|${active.map(a => `${a.idx}:${a.op}`).join(",")}`;
    if (stretchCache.has(key)) return stretchCache.get(key);
    const all = [];
    if (state.mode === "blink") for (const epoch of active) {
      if (spec.startsWith("D") && !epoch.ep.detectors.includes(Number(spec.slice(1)))) continue;
      const plane = new Float32Array(grid * grid); samplePlane(epoch.idx, spec, plane); all.push(plane);
    }
    const limits = stretchLimits(all.length ? all : [buffers[i]], state.mode === "diff");
    if (stretchCache.size >= 64) stretchCache.delete(stretchCache.keys().next().value);
    stretchCache.set(key, limits);
    return limits;
  });
  if (!buffers.some(b => b.some(Number.isFinite))) showEmpty("No valid pixels with same-band multi-epoch coverage. Try Blink, Mean, or widen the time brush.");
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
  const margin = epochWindowMargin();
  state.sky.epochs.forEach((ep, idx) => {
    const chip = document.createElement("button");
    chip.className = "epoch-chip";
    chip.dataset.idx = String(idx);
    const inWin = ep.year >= state.winStart - margin && ep.year <= state.winEnd + margin;
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
      renderSpectralCharts();
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
  if (state.mode === "diff" && active.length < 2) return [];
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

const displayFlagMask = [0, 1, 2, 6, 7, 9, 10, 11, 14, 15, 17, 19, 20, 22, 23, 24, 25, 26, 27, 28].reduce((mask, bit) => mask | (1 << bit), 0);
const badPixelMask = [1, 2, 6, 7, 9, 10, 11, 15].reduce((mask, bit) => mask | (1 << bit), 0);
const smoothedArtifactMask = displayFlagMask & ~badPixelMask;

function displayedFlagsAt(pixel, epochs = displayedEpochs()) {
  const { grid, flags, frames, nDet } = state.decoded;
  const size = grid * grid;
  let bits = epochs.reduce((acc, a) => acc | flags[a.idx * size + pixel], 0) & displayFlagMask;
  if ((state.detector === "fft2d" || state.mode === "fft2d") && frames && grid > 1) {
    const x = pixel % grid, y = Math.floor(pixel / grid);
    const detCount = nDet || 6;
    for (const a of epochs) {
      let centerValid = false;
      for (let d = 0; d < detCount; d++) {
        if (Number.isFinite(frames[(a.idx * detCount + d) * size + pixel])) { centerValid = true; break; }
      }
      if (!centerValid) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
        const np = ny * grid + nx;
        let neighborValid = false;
        for (let d = 0; d < detCount; d++) {
          if (Number.isFinite(frames[(a.idx * detCount + d) * size + np])) { neighborValid = true; break; }
        }
        if (neighborValid) bits |= flags[a.idx * size + np] & smoothedArtifactMask;
      }
    }
  }
  return bits;
}

function flagSummaryAt(pixel, epochs = displayedEpochs()) {
  const bits = displayedFlagsAt(pixel, epochs);
  if (!bits) return null;
  const defs = (state.config?.flags_bitmask || []).filter(f => bits & (1 << f.bit));
  const rank = { high: 3, warn: 2, info: 1 };
  const top = defs.slice().sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0))[0];
  const size = state.decoded.grid * state.decoded.grid;
  const rgbLabels = { 5: "R(D5)", 3: "G(D3)", 1: "B(D1)" };
  const channels = [];
  for (const a of epochs) {
    const raw = state.decoded.flags[a.idx * size + pixel] & displayFlagMask;
    if (raw) {
      const det = a.ep.detectors?.[0];
      const tag = state.detector === "rgb" && rgbLabels[det] ? rgbLabels[det] : det ? `D${det}` : "";
      if (tag && !channels.includes(tag)) channels.push(tag);
    }
  }
  return {
    bits,
    color: top?.color || "#f59e0b",
    labels: defs.map(d => d.label),
    channels
  };
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
  const offsetArcsec = propagated
    ? Math.hypot(source.gaia.pmra, source.gaia.pmdec) * Math.abs(year - source.reference_epoch) / 1000
    : 0;
  return { ...source, ...skyToPixel(lon, lat), reference: skyToPixel(source.ra, source.dec), propagated, offsetArcsec };
}

function overlaySources() {
  const epochs = displayedEpochs();
  const mjds = epochs.map(a => a.ep.mjd).filter(Number.isFinite);
  const fallbackYear = Number.isFinite(state.winStart) && Number.isFinite(state.winEnd) && state.winEnd > 0
    ? 0.5 * (state.winStart + state.winEnd) : null;
  const year = mjds.length ? 2000 + ((Math.min(...mjds) + Math.max(...mjds)) / 2 - 51544.5) / 365.25 : fallbackYear;
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

  const { sources } = overlaySources();
  const labels = [];
  const epochs = displayedEpochs();

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
      .attr("stroke", (d) => {
        const w1 = d.wise?.w1mpro, w2 = d.wise?.w2mpro;
        return Number.isFinite(w1) && Number.isFinite(w2) && (w1 - w2) >= 0.5 ? "#fb923c" : "#f59e0b";
      })
      .attr("stroke-width", 0.12)
      .attr("opacity", 0.85)
      .append("title").text(d => {
        const w1 = d.wise?.w1mpro, w2 = d.wise?.w2mpro;
        const w1Text = Number.isFinite(w1) ? `W1=${w1.toFixed(2)}` : "W1=n/a";
        const w2Text = Number.isFinite(w2) ? `W2=${w2.toFixed(2)}` : "W2=n/a";
        const colorText = Number.isFinite(w1) && Number.isFinite(w2) ? ` · W1-W2=${(w1 - w2).toFixed(2)} mag` : "";
        return `AllWISE ${d.name} · ${w1Text} · ${w2Text}${colorText}`;
      });
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
      .attr("stroke-width", 0.12)
      .append("title").text(d => {
        const gMag = d.gaia?.phot_g_mean_mag;
        const gText = Number.isFinite(gMag) ? `G=${gMag.toFixed(2)}` : "G=n/a";
        const pmText = d.propagated ? `PM=(${d.gaia.pmra.toFixed(1)}, ${d.gaia.pmdec.toFixed(1)}) mas/yr · Δ=${d.offsetArcsec.toFixed(2)}″` : "reference position";
        return `Gaia DR3 ${d.name} · ${gText} · ${pmText}`;
      });

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
    const flagsToShow = [];
    const grid = state.decoded.grid;
    for (let p = 0; p < grid * grid; p++) {
      const summary = flagSummaryAt(p, epochs);
      if (summary) flagsToShow.push({ x: p % grid + .5, y: Math.floor(p / grid) + .5, ...summary });
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
      .attr("stroke", (d) => d.color)
      .attr("stroke-width", 0.08)
      .append("title").text(d => {
        const names = d.labels.length ? d.labels.join(", ") : `0x${d.bits.toString(16)}`;
        const ch = d.channels.length ? ` · ${d.channels.join("/")}` : "";
        return `Archive pixel flags: ${names} (0x${d.bits.toString(16)})${ch}`;
      });
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

function fieldMeasurements(entries = null) {
  const { grid, frames, wavelengths, nDet } = state.decoded;
  const size = grid * grid;
  const list = entries || state.sky.epochs.map((ep, idx) => ({ idx, ep }));
  return list.flatMap(({ idx, ep }) => {
    const detector = ep.detectors[0] - 1;
    let sum = 0, wave = 0, count = 0;
    for (let p = 0; p < size; p++) {
      const v = frames[(idx * nDet + detector) * size + p], w = wavelengths[idx * size + p];
      if (Number.isFinite(v) && Number.isFinite(w)) { sum += v; wave += w; count++; }
    }
    return count ? [{ brightness: sum / count, wavelength_um: wave / count, detector, mjd: ep.mjd }] : [];
  }).sort((a, b) => a.wavelength_um - b.wavelength_um);
}

function apertureMeasurements(pixel, entries = null) {
  const { grid, frames, wavelengths, nDet } = state.decoded;
  const size = grid * grid;
  const list = entries || state.sky.epochs.map((ep, idx) => ({ idx, ep }));
  const radii = [0, 1.5, 3, 5, 8, 12];
  return list.flatMap(({ idx, ep }) => {
    const detector = ep.detectors[0] - 1;
    const frameBase = (idx * nDet + detector) * size;
    const waveBase = idx * size;
    for (const r of radii) {
      let sumB = 0, sumW = 0, count = 0;
      const span = Math.ceil(r);
      for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
        if (Math.hypot(dx, dy) > r + 1e-6) continue;
        const nx = pixel.x + dx, ny = pixel.y + dy;
        if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
        const p = ny * grid + nx;
        const b = frames[frameBase + p], w = wavelengths[waveBase + p];
        if (Number.isFinite(b) && Number.isFinite(w) && w > 0) { sumB += b; sumW += w; count++; }
      }
      if (count) return [{ brightness: sumB / count, wavelength_um: sumW / count, detector, mjd: ep.mjd, aperture_px: r }];
    }
    return [];
  }).sort((a, b) => a.wavelength_um - b.wavelength_um);
}

function lvfCutoutMeasurements(entries = null, pixel = null, bins = 16) {
  if (!state.decoded?.wavelengths?.length || !state.decoded?.frames?.length) return [];
  const { grid, frames, wavelengths, nDet } = state.decoded;
  const size = grid * grid;
  const list = entries || state.sky.epochs.map((ep, idx) => ({ idx, ep }));
  const cx = pixel ? pixel.x : grid / 2, cy = pixel ? pixel.y : grid / 2;
  const pairs = [];
  for (const { idx, ep } of list) {
    const detector = ep.detectors[0] - 1;
    if (detector < 0) continue;
    const frameBase = (idx * nDet + detector) * size;
    const waveBase = idx * size;
    for (let p = 0; p < size; p++) {
      const b = frames[frameBase + p], w = wavelengths[waveBase + p];
      if (!Number.isFinite(b) || !Number.isFinite(w) || w <= 0) continue;
      const dist = Math.hypot((p % grid) - cx, Math.floor(p / grid) - cy);
      pairs.push({ wavelength_um: w, brightness: b, detector, mjd: ep.mjd, dist });
    }
  }
  if (pairs.length < 4) return [];
  const local = pairs.filter(p => p.dist <= 16);
  const pool = local.length >= 16 ? local : pairs;
  pool.sort((a, b) => a.wavelength_um - b.wavelength_um);
  const wMin = pool[0].wavelength_um, wMax = pool[pool.length - 1].wavelength_um;
  if (!(wMax > wMin)) return [];
  const out = [];
  for (let i = 0; i < bins; i++) {
    const lo = wMin + (wMax - wMin) * (i / bins);
    const hi = wMin + (wMax - wMin) * ((i + 1) / bins);
    const slice = pool.filter(p => p.wavelength_um >= lo && (i === bins - 1 ? p.wavelength_um <= hi : p.wavelength_um < hi));
    if (slice.length) {
      const meanB = slice.reduce((s, p) => s + p.brightness, 0) / slice.length;
      const meanW = slice.reduce((s, p) => s + p.wavelength_um, 0) / slice.length;
      out.push({ wavelength_um: meanW, brightness: meanB, detector: slice[0].detector, mjd: slice[0].mjd });
    }
  }
  return out;
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

function resampleSpectralSeries(samples, gridCount = 32) {
  const valid = (samples || [])
    .filter(s => Number.isFinite(s.wavelength_um) && Number.isFinite(s.brightness) && s.wavelength_um > 0)
    .slice()
    .sort((a, b) => a.wavelength_um - b.wavelength_um);
  if (valid.length < 2) return [];
  const merged = [];
  for (const item of valid) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(item.wavelength_um - prev.wavelength_um) < 1e-4) {
      prev.wavelength_um = 0.5 * (prev.wavelength_um + item.wavelength_um);
      prev.brightness = 0.5 * (prev.brightness + item.brightness);
    } else {
      merged.push({ wavelength_um: item.wavelength_um, brightness: item.brightness });
    }
  }
  if (merged.length < 2) return [];
  const wMin = merged[0].wavelength_um, wMax = merged[merged.length - 1].wavelength_um;
  if (!(wMax > wMin)) return [];
  const step = (wMax - wMin) / (gridCount - 1);
  return Array.from({ length: gridCount }, (_, i) => {
    const w = wMin + i * step;
    let idx = 0;
    while (idx < merged.length - 2 && merged[idx + 1].wavelength_um < w) idx++;
    const a = merged[idx], b = merged[idx + 1];
    const t = b.wavelength_um > a.wavelength_um ? Math.max(0, Math.min(1, (w - a.wavelength_um) / (b.wavelength_um - a.wavelength_um))) : 0;
    return { wavelength_um: w, brightness: a.brightness + t * (b.brightness - a.brightness) };
  });
}

function interpolateOnGrid(gridW, gridValues, targetW) {
  if (!gridW.length) return 0;
  if (targetW <= gridW[0]) return gridValues[0];
  if (targetW >= gridW[gridW.length - 1]) return gridValues[gridValues.length - 1];
  const step = gridW[1] - gridW[0];
  const pos = (targetW - gridW[0]) / step;
  const idx = Math.max(0, Math.min(gridW.length - 2, Math.floor(pos)));
  const frac = pos - idx;
  return gridValues[idx] + frac * (gridValues[idx + 1] - gridValues[idx]);
}

function observationSpectrum(measurements, activeEntries = null) {
  const direct = spectralAnalysis(measurements);
  if (direct.fft_amplitude?.length) return direct;
  let basis = measurements;
  const uniqueWaves = new Set(measurements.map(m => m.wavelength_um.toFixed(4)));
  if (uniqueWaves.size < 4) {
    const lvf = lvfCutoutMeasurements(activeEntries, state.spectrumPixel);
    if (lvf.length >= 4) basis = lvf;
  }
  const gridSamples = resampleSpectralSeries(basis, 32);
  if (gridSamples.length < 4) return {};
  const gridded = spectralAnalysis(gridSamples);
  if (!gridded.fft_amplitude?.length) return {};
  const gridW = gridSamples.map(s => s.wavelength_um);
  const projectedBands = {};
  for (const name of ["low", "mid", "high"]) {
    projectedBands[name] = measurements.map(m => interpolateOnGrid(gridW, gridded.fft_bands[name], m.wavelength_um));
  }
  for (let i = 0; i < measurements.length; i++) {
    const knotResidual = measurements[i].brightness - (projectedBands.low[i] + projectedBands.mid[i] + projectedBands.high[i]);
    if (Number.isFinite(knotResidual)) projectedBands.high[i] += knotResidual;
  }
  return {
    fft_amplitude: gridded.fft_amplitude,
    fft_period_um: gridded.fft_period_um,
    fft_bands: projectedBands,
    grid_wavelengths: gridW,
    grid_bands: gridded.fft_bands,
    gridded: true
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
  const active = getActiveEpochs();
  const activeDetectors = state.detector.startsWith("D")
    ? new Set([Number(state.detector.slice(1)) - 1])
    : state.detector === "rgb" && [1, 3, 5].every(d => active.some(a => a.ep.detectors.includes(d)))
      ? new Set([0, 2, 4])
      : null;
  const margin = epochWindowMargin();
  const minMjd = active.length ? Math.min(...active.map(a => a.ep.mjd)) - 0.5 : -Infinity;
  const maxMjd = active.length ? Math.max(...active.map(a => a.ep.mjd)) + 0.5 : Infinity;
  let measurements = (state.sky.measurements || []).filter(m => {
    const inDet = !activeDetectors || activeDetectors.has(m.detector);
    const mYear = 2000 + (m.mjd - 51544.5) / 365.25;
    const inTime = (m.mjd >= minMjd && m.mjd <= maxMjd) || (mYear >= state.winStart - margin && mYear <= state.winEnd + margin);
    return inDet && inTime;
  });
  let apertureRadius = Math.max(0, ...measurements.map(m => m.aperture_px || 0));
  if (state.spectrumPixel) {
    measurements = apertureMeasurements(state.spectrumPixel, active);
    apertureRadius = Math.max(0, ...measurements.map(m => m.aperture_px || 0));
  }
  let fieldFallback = false;
  if (!measurements.length && active.length) {
    fieldFallback = true;
    measurements = fieldMeasurements(active);
  }
  const sourceLabel = fieldFallback
    ? "Field mean (pixel unavailable)"
    : state.spectrumPixel
      ? (apertureRadius > 0 ? `Selected-aperture (r=${apertureRadius}px)` : "Selected-pixel")
      : (apertureRadius > 0 ? `Center PSF-aperture` : "Center-pixel");
  document.getElementById("sed-title").textContent = `${sourceLabel} brightness`;
  document.getElementById("sed-subtitle").textContent = `${measurements.length} observations \u00b7 different dates`;
  if (state.fftDemo) {
    measurements = demoSpectralSamples();
    document.getElementById("sed-title").textContent = "FFT DEMO · synthetic signal · arbitrary units";
    document.getElementById("sed-subtitle").textContent = `Not sky measurements · ${state.fftFilter} modes`;
  }
  const spectrum = state.fftDemo ? spectralAnalysis(measurements) : observationSpectrum(measurements, active);
  const filtered = state.fftFilter !== "raw" ? spectrum.fft_bands?.[state.fftFilter] : null;
  renderSedSvg(filtered ? measurements.map((m, i) => ({ ...m, brightness: filtered[i] })) : measurements, spectrum);
  renderFftSvg({ ...spectrum, measurements });
}

function renderSedSvg(measurements, spectrum = {}) {
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
    .attr("fill", m => state.sky.detectors[m.detector]?.color || "#38bdf8")
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
  const counts = Array.from({ length: 6 }, (_, d) => (source.measurements || []).filter(m => m.detector === d).length);
  document.getElementById("fft-subtitle").textContent = amplitudes.length
    ? `${state.fftDemo ? "Synthetic demo · " : ""}|FFT| · period in wavelength space`
    : "Uniform wavelength sampling required";
  if (!amplitudes.length) state.fftFilter = "raw";
  document.querySelectorAll("#fft-buttons .chip[data-fft]").forEach(button => {
    button.disabled = button.dataset.fft !== "raw" && !amplitudes.length;
    button.classList.toggle("active", button.dataset.fft === state.fftFilter);
    button.title = button.disabled ? "Requires valid spectral observations" : "Filter the sampled spectrum";
  });
  const width = (element.clientWidth || 300) - 24;
  if (!amplitudes.length) {
    svg.append("text").attr("x", 12).attr("y", 28).attr("fill", "#94a3b8").text("No FFT for empty observation set.");
    svg.selectAll("rect.coverage").data(counts).join("rect").attr("class", "coverage")
      .attr("x", (_, i) => 12 + i * width / 6).attr("y", 65).attr("width", width / 6 - 5)
      .attr("height", v => v * 5).attr("fill", (_, i) => state.sky.detectors[i]?.color || "#38d8f8ff");
    svg.selectAll("text.coverage").data(counts).join("text").attr("class", "coverage")
      .attr("x", (_, i) => 12 + i * width / 6).attr("y", 55).attr("fill", "#94a3b8").text((v, i) => `D${i + 1}: ${v}`);
    document.getElementById("fft-subtitle").textContent = "No valid observations in current selection";
    return;
  }
  const w = (element.clientWidth || 300) - 52, h = (element.clientHeight || 120) - 36;
  const group = svg.append("g").attr("transform", "translate(40,8)");
  const x = d3.scaleBand().domain(d3.range(amplitudes.length)).range([0, w]).padding(.15);
  const y = d3.scaleLinear().domain([0, d3.max(amplitudes) || 1]).range([h, 0]);
  const limit = Math.max(1, amplitudes.length - 1);
  group.selectAll("rect").data(amplitudes).join("rect")
    .attr("class", "fft-bar")
    .attr("x", (_, i) => x(i)).attr("y", y)
    .attr("width", x.bandwidth()).attr("height", v => h - y(v))
    .attr("fill", (_, i) => {
      const frac = i / limit;
      if (state.fftFilter === "low") return frac <= 1 / 3 ? "rgba(162, 0, 225, 1)" : "rgba(56,189,248,0.22)";
      if (state.fftFilter === "mid") return frac > 1 / 3 && frac <= 2 / 3 ? "rgba(215, 113, 255, 1)" : "rgba(56,189,248,0.22)";
      if (state.fftFilter === "high") return frac > 2 / 3 ? "rgba(228, 160, 255, 1)" : "rgba(56,189,248,0.22)";
      return "#c0ecffff";
    })
    .append("title").text((v, i) => `Mode ${i} (${formatSpectralPeriod(source.fft_period_um[i])}): |FFT| = ${v.toPrecision(4)}`);
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
      const span = Math.max(0.01, state.winEnd - state.winStart);
      document.getElementById("time-subtitle").textContent = `${span.toFixed(2)} yr (${state.winStart.toFixed(2)}–${state.winEnd.toFixed(2)})`;
      if (!event.sourceEvent || event.type === "end") return;
      renderEpochLegend();
      renderCurrentFrame();
      renderSpectralCharts();
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
    const current = state.cursorEpochPos % active.length;
    const next = nextPlaybackPosition(active, current);
    if (next === current) return;
    state.cursorEpochPos = next;
    if (next < current) triggerLoopFlash();
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
    const ra = parseCoordinate(document.getElementById("input-ra").value, true);
    const dec = parseCoordinate(document.getElementById("input-dec").value, false);
    if (Number.isFinite(ra) && Number.isFinite(dec)) querySky(ra, dec);
    else setDataStatus("Enter valid coordinates in decimal degrees or sexagesimal (e.g. 08h55m10.831s, -7d14m42.53s).");
  });

  for (const id of ["input-ra", "input-dec"]) {
    document.getElementById(id).addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") document.getElementById("btn-go-coords").click();
    });
  }

  document.getElementById("preset-select").addEventListener("change", (ev) => {
    const idx = Number.parseInt(ev.target.value, 10);
    const preset = state.config.preset_targets[idx];
    if (preset) querySky(preset.ra, preset.dec, preset.fov || state.fov);
  });

  document.getElementById("btn-random").addEventListener("click", () => {
    const randRa = Math.random() * 360.0;
    const randDec = (Math.random() * 160.0) - 80.0;
    querySky(randRa, randDec, state.fov, state.windowYears, state.releaseId, true);
  });

  document.getElementById("release-select").addEventListener("change", (ev) => {
    querySky(state.ra, state.dec, state.fov, state.windowYears, ev.target.value);
  });

  document.getElementById("btn-reload-releases").addEventListener("click", async () => {
    if (state.staticDemo) {
      if (state.config?.releases) populateReleases(state.config.releases);
      setDataStatus("Static demo mode: release list loaded from pre-cached snapshot.");
      return;
    }
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
      const previousDetector = state.detector;
      state.detector = btn.dataset.det;
      renderCurrentFrame();
      renderSpectralCharts();
      syncUrlHash();
      if (previousDetector !== state.detector && (previousDetector === "rgb" || state.detector === "rgb")) {
        querySky(state.ra, state.dec);
      }
    });
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
    const summary = state.showFlags ? flagSummaryAt(pixel) : null;
    let hoveredSource = null;
    if (state.showGaia || state.showWise) {
      let bestD2 = 2.25;
      for (const src of overlaySources().sources) {
        const d2 = (src.px - px) ** 2 + (src.py - py) ** 2;
        if (d2 < bestD2) { bestD2 = d2; hoveredSource = src; }
      }
    }
    const tip = document.getElementById("flag-tooltip");
    const tipParts = [];
    if (summary) {
      const ch = summary.channels.length ? ` [${summary.channels.join("/")}]` : "";
      tipParts.push(`Quality flags${ch}: ${summary.labels.join(", ") || "flagged pixel"} (0x${summary.bits.toString(16)})`);
    }
    if (hoveredSource) {
      if (hoveredSource.gaia) {
        const gMag = hoveredSource.gaia.phot_g_mean_mag;
        const gStr = Number.isFinite(gMag) ? `G=${gMag.toFixed(2)}` : "G=n/a";
        const pmStr = hoveredSource.propagated
          ? `PM=(${hoveredSource.gaia.pmra.toFixed(1)}, ${hoveredSource.gaia.pmdec.toFixed(1)}) mas/yr`
          : "reference epoch";
        tipParts.push(`Gaia DR3 ${hoveredSource.name} · ${gStr} · ${pmStr}`);
      } else if (hoveredSource.wise) {
        const w1 = hoveredSource.wise.w1mpro, w2 = hoveredSource.wise.w2mpro;
        const w1Str = Number.isFinite(w1) ? `W1=${w1.toFixed(2)}` : "W1=n/a";
        const w2Str = Number.isFinite(w2) ? `W2=${w2.toFixed(2)}` : "W2=n/a";
        tipParts.push(`AllWISE ${hoveredSource.name} · ${w1Str} · ${w2Str}`);
      }
    }
    if (tipParts.length) {
      const stageRect = stage.getBoundingClientRect();
      tip.textContent = tipParts.join(" · ");
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
  if (state.staticDemo) {
    const defaultJobs = presets.map((p, i) => fetch(`data/sky-${i}-${p.fov || 300}-preview.json`)
      .then(r => (r.ok ? r.json() : null)).catch(() => null));
    for (const sky of await Promise.all(defaultJobs)) {
      if (sky) rememberSky(sky);
    }
    const extraJobs = presets.flatMap((p, i) => [150, 300, 600, 1200]
      .filter(f => f !== (p.fov || 300))
      .map(fov => fetch(`data/sky-${i}-${fov}-preview.json`).then(r => (r.ok ? r.json() : null)).catch(() => null)));
    for (const sky of await Promise.all(extraJobs)) {
      if (sky) rememberSky(sky);
    }
    return;
  }
  const fovs = [150, 300, 600, 1200];
  const queries = presets.flatMap((p) => fovs.map((fov) => ({
    ra: p.ra,
    dec: p.dec,
    fov,
    window: state.windowYears,
    release: state.releaseId
  })));
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

  let boot;
  try {
    const stateResp = await fetch("/api/state");
    if (!stateResp.ok) throw new Error(`HTTP ${stateResp.status}`);
    boot = await stateResp.json();
  } catch {
    const staticResp = await fetch("data/state.json");
    if (!staticResp.ok) throw new Error("Could not initialize sky viewer");
    boot = await staticResp.json();
    state.staticDemo = true;
  }
  state.config = boot.config;
  if (boot.initial_sky) rememberSky(boot.initial_sky);
  populateReleases(boot.config.releases);
  populatePresets(boot.config.preset_targets);
  if (!hasUrlCoords) {
    state.ra = boot.config.preset_targets[0].ra;
    state.dec = boot.config.preset_targets[0].dec;
  } else {
    [state.ra, state.dec] = resolveKnownCoords(state.ra, state.dec);
  }
  await querySky(state.ra, state.dec, state.fov, state.windowYears, state.releaseId);

  applyVisualTransform();
  restartBlinkLoop();
  prefetchPresetsBatch(boot.config.preset_targets);
}

init().catch(() => setDataStatus("Unable to load the viewer. Check that the local server is running, then reload this page."));
