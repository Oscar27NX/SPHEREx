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
  const sameEpochs = sameView && JSON.stringify(state.sky.epochs) === JSON.stringify(sky.epochs);
  state.sky = sky;
  state.decoded = decodeSkyPayload(sky);
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
  if (!sameView) { state.panX = 0; state.panY = 0; }

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
  document.querySelectorAll("#fft-buttons .chip").forEach((b) => {
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

function rememberSky(sky) {
  if (sky.data_status !== "ready" && sky.data_status !== "empty") return;
  if (state.clientCache.size >= 32) state.clientCache.delete(state.clientCache.keys().next().value);
  state.clientCache.set(skyCacheKey(sky.ra, sky.dec, sky.fov, sky.window, sky.release.id), { sky, at: Date.now() });
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
  if (cached && Date.now() - cached.at < 60000) applySkyData(cached.sky);
  else setDataStatus("Loading live IRSA cutouts…");
  try {
    const params = new URLSearchParams({ra, dec, fov, window: win, release: releaseId});
    const resp = await fetch(`/api/sky?${params}`, {signal: skyController.signal});
    const sky = await resp.json();
    if (!resp.ok) throw new Error(sky.error || `HTTP ${resp.status}`);
    if (serial !== requestSerial) return;
    rememberSky(sky);
    applySkyData(sky);
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
    if (error.name !== "AbortError" && serial === requestSerial) setDataStatus(`Could not load sky: ${error.message}`);
  }
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
  const {frames, grid, nDet} = state.decoded;
  const count = grid * grid;
  const detectors = detSpec === "all" || detSpec === "fft2d"
    ? Array.from({length: nDet}, (_, d) => d) : [Number(detSpec.slice(1)) - 1];
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
      const {wavelengths, bandwidths} = state.decoded;
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
  const values = buffers.flatMap(b => Array.from(b).filter(Number.isFinite)).sort((a,b) => a-b);
  if (!values.length) return [0, 1];
  const lo = values[Math.floor((values.length - 1) * .01)];
  const hi = values[Math.floor((values.length - 1) * .99)];
  if (difference) { const span = Math.max(Math.abs(lo), Math.abs(hi), 1e-6); return [-span, span]; }
  return [lo, Math.max(lo + 1e-6, hi)];
}

function renderCurrentFrame() {
  if (!state.sky || !state.decoded) return;
  const active = getActiveEpochs();
  const readout = document.getElementById("active-epoch-readout");
  const canvas = document.getElementById("sky-canvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!active.length) { readout.textContent = "No observations for this selection"; renderSkyOverlay(); return; }
  if (state.mode === "diff" && (!state.detector.startsWith("D") || active.length < 2)) {
    readout.textContent = "Choose one detector and at least two epochs to compare wavelengths";
    renderSkyOverlay();
    return;
  }
  if (state.detector === "rgb" && state.mode === "blink") {
    readout.textContent = "Select Mean (+) for a D1/D3/D5 color composite";
    return;
  }
  const grid = state.decoded.grid;
  const specs = state.detector === "rgb" ? ["D5", "D3", "D1"] : [state.detector];
  const buffers = specs.map(() => new Float32Array(grid * grid));
  if (state.mode === "blink") {
    const slot = active[state.cursorEpochPos % active.length];
    specs.forEach((spec, i) => samplePlane(slot.idx, spec, buffers[i]));
    readout.textContent = `${slot.ep.label} · ${slot.ep.source}`;
    highlightEpochChip(slot.idx);
  } else {
    specs.forEach((spec, i) => accumulateComposite(active, spec, buffers[i]));
    readout.textContent = state.mode === "diff" ? "Difference preview · wavelength mismatch pixels masked"
      : `Mean of ${active.length} observations · mixed wavelengths`;
    highlightEpochChip(-1);
  }
  const limits = specs.map((spec, i) => {
    const all = [];
    if (state.mode === "blink") for (const epoch of active) {
      const plane = new Float32Array(grid * grid); samplePlane(epoch.idx, spec, plane); all.push(plane);
    }
    return stretchLimits(all.length ? all : [buffers[i]], state.mode === "diff");
  });
  if (!buffers.some(b => b.some(Number.isFinite))) readout.textContent = "No valid pixels with matching wavelength coverage";
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

function renderSkyOverlay() {
  if (!state.sky) return;
  const svg = d3.select("#sky-overlay-svg");
  svg.selectAll("*").remove();

  const sources = state.sky.sources || [];
  const pxScale = state.sky.pixel_scale_arcsec;

  if (state.showWise) {
    const wiseLayer = svg.append("g").attr("class", "wise-layer");
    wiseLayer.selectAll("path")
      .data(sources.filter((s) => s.wise))
      .join("path")
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
      .attr("cx", (d) => d.px)
      .attr("cy", (d) => d.py)
      .attr("r", 0.5)
      .attr("fill", "none")
      .attr("stroke", "#34d399")
      .attr("stroke-width", 0.12);

    // draw proper-motion displacement vector scaled to ten years
    gaiaLayer.selectAll("line")
      .data(gaiaSources.filter((d) => Math.hypot(d.pmra_mas_yr, d.pmdec_mas_yr) > 120))
      .join("line")
      .attr("x1", (d) => d.px)
      .attr("y1", (d) => d.py)
      .attr("x2", (d) => d.px - (d.pmra_mas_yr * 0.01) / pxScale)
      .attr("y2", (d) => d.py - (d.pmdec_mas_yr * 0.01) / pxScale)
      .attr("stroke", "#34d399")
      .attr("stroke-width", 0.25)
      .attr("opacity", 0.9);
  }

  if (state.showFlags && state.decoded.flags.length) {
    const active = getActiveEpochs();
    const curEpoch = state.mode === "blink" && active.length
      ? active[state.cursorEpochPos % active.length].idx
      : -1;
    const flagsToShow = [];
    const grid = state.decoded.grid;
    const badMask = [0, 1, 2, 6, 7, 9, 10, 11, 15, 17, 19, 20, 22, 24, 27, 28]
      .reduce((mask, bit) => mask | (1 << bit), 0);
    const indices = curEpoch >= 0 ? [curEpoch] : active.map(a => a.idx);
    for (let p = 0; p < grid * grid; p++) {
      const bits = indices.reduce((value, epoch) => value | state.decoded.flags[epoch * grid * grid + p], 0) & badMask;
      if (bits) flagsToShow.push({x: p % grid + .5, y: Math.floor(p / grid) + .5, bits});
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

  if (state.selectedSource) {
    svg.append("circle")
      .attr("cx", state.selectedSource.px)
      .attr("cy", state.selectedSource.py)
      .attr("r", 2.4)
      .attr("fill", "none")
      .attr("stroke", "#38bdf8")
      .attr("stroke-width", 0.36);
  }
}

function renderSpectralCharts() {
  if (!state.sky) return;
  let measurements = state.sky.measurements || [];
  if (state.spectrumPixel) {
    const {grid, frames, wavelengths, nDet} = state.decoded;
    const pixel = state.spectrumPixel.y * grid + state.spectrumPixel.x;
    measurements = state.sky.epochs.flatMap((epoch, index) => {
      const detector = epoch.detectors[0] - 1;
      const brightness = frames[(index * nDet + detector) * grid * grid + pixel];
      const wavelength = wavelengths[index * grid * grid + pixel];
      return Number.isFinite(brightness) && Number.isFinite(wavelength)
        ? [{brightness, wavelength_um: wavelength, detector, mjd: epoch.mjd}] : [];
    }).sort((a, b) => a.wavelength_um - b.wavelength_um);
  }
  document.getElementById("sed-title").textContent = `${state.spectrumPixel ? "Selected" : "Center"}-pixel brightness · MJy/sr`;
  document.getElementById("sed-subtitle").textContent = `${measurements.length} observations \u00b7 different dates`;
  renderSedSvg(measurements);
  renderFftSvg(state.sky);
}

function renderSedSvg(measurements) {
  const element = document.getElementById("sed-svg");
  const width = element.clientWidth || 440, height = element.clientHeight || 120;
  const svg = d3.select(element); svg.selectAll("*").remove();
  const margin = {top: 10, right: 12, bottom: 24, left: 42};
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
    .append("title").text(m => `${m.wavelength_um.toFixed(4)} \u00b5m \u00b7 ${m.brightness.toPrecision(5)} MJy/sr \u00b7 MJD ${m.mjd.toFixed(3)}`);
  if (!measurements.length) group.append("text").attr("x", 4).attr("y", 16).attr("fill", "#94a3b8").text("No valid measurements at this pixel (masked or missing)");
}

function formatSpectralPeriod(period) {
  return period === null ? "DC" : `${d3.format(".3~g")(period)} \u00b5m`;
}

function renderFftSvg(source) {
  const element = document.getElementById("fft-svg");
  const svg = d3.select(element); svg.selectAll("*").remove();
  const amplitudes = source.fft_amplitude || [];
  document.getElementById("fft-subtitle").textContent = amplitudes.length ? "|FFT| \u00b7 period in wavelength space" : "Uniform wavelength sampling required";
  document.querySelectorAll("#fft-buttons .chip").forEach(button => { button.disabled = button.dataset.fft !== "raw" && !amplitudes.length; });
  if (!amplitudes.length) {
    svg.append("text").attr("x", 12).attr("y", 28).attr("fill", "#94a3b8").text("No FFT for sparse, unequal-wavelength samples.");
    svg.append("text").attr("x", 12).attr("y", 48).attr("fill", "#94a3b8").text("Measured wavelengths are shown at left.");
    return;
  }
  const w = (element.clientWidth || 300) - 52, h = (element.clientHeight || 120) - 36;
  const group = svg.append("g").attr("transform", "translate(40,8)");
  const x = d3.scaleBand().domain(d3.range(amplitudes.length)).range([0,w]).padding(.15);
  const y = d3.scaleLinear().domain([0,d3.max(amplitudes) || 1]).range([h,0]);
  group.selectAll("rect").data(amplitudes).join("rect").attr("x",(_,i) => x(i)).attr("y",y)
    .attr("width",x.bandwidth()).attr("height",v => h-y(v)).attr("fill","#38bdf8");
  const ticks = [0, ...d3.range(1,amplitudes.length).filter(i => i % Math.max(1,Math.floor(amplitudes.length/4)) === 0)];
  group.append("g").attr("class","axis").attr("transform",`translate(0,${h})`)
    .call(d3.axisBottom(x).tickValues(ticks).tickFormat(i => formatSpectralPeriod(source.fft_period_um[i])));
  group.append("g").attr("class","axis").call(d3.axisLeft(y).ticks(3));
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
  if (!epochs.length) { document.getElementById("time-subtitle").textContent = "No observed epochs"; return; }
  const minY = epochs[0].year - 0.04;
  const maxY = epochs[epochs.length - 1].year + 0.04;
  const x = d3.scaleLinear().domain([minY, maxY]).range([0, iw]);

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.selectAll("circle.ep-dot")
    .data(epochs)
    .join("circle")
    .attr("class", "ep-dot")
    .attr("cx", (d) => x(d.year))
    .attr("cy", ih * 0.5)
    .attr("r", 4.5)
    .attr("fill", (d) => (d.source.startsWith("spherex") ? "#38bdf8" : "#f59e0b"));

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
        statusEl.textContent = `Aladin could not load: ${error.message}`;
      });
    }

    return;
  }

  window.A.init.then(() => {
    const fovDeg = state.fov / 3600.0;
    if (!state.aladinInstance) {
      state.aladinInstance = window.A.aladin("#aladin-lite-div", {
        survey: aladinSurveySource(state.aladinSurvey),
        target: `${state.ra} ${state.dec}`,
        fov: fovDeg,
        log: false
      });

    } else {
      state.aladinInstance.gotoRaDec(state.ra, state.dec);
      state.aladinInstance.setFoV(fovDeg);
    }
    statusEl.textContent = `Survey imagery; catalog markers are in the main view. Synced to RA ${state.ra.toFixed(4)}°, Dec ${state.dec.toFixed(4)}°`;
  }).catch(() => {
    statusEl.textContent = "Aladin Lite init skipped";
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
  return {ra: ((ra % 360) + 360) % 360, dec};
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
    const resp = await fetch("/api/releases/reload", { method: "POST" });
    const data = await resp.json();
    if (data.releases) populateReleases(data.releases);
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

  document.querySelectorAll("#fft-buttons .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#fft-buttons .chip").forEach((b) => b.classList.remove("active"));
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
    const {ra: cursorRa, dec: cursorDec} = pixelToSky(px, py);

    const active = getActiveEpochs();
    const current = active[state.cursorEpochPos % Math.max(1, active.length)];
    const pixel = Math.floor(py) * state.decoded.grid + Math.floor(px);
    const flags = current ? state.decoded.flags[current.idx * state.decoded.grid ** 2 + pixel] : 0;
    const tip = document.getElementById("flag-tooltip");
    if (flags && state.showFlags) {
      const stageRect = stage.getBoundingClientRect();
      tip.textContent = `Archive pixel bitmask: 0x${flags.toString(16)}`;
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
    for (const src of state.sky.sources) {
      const d2 = (src.px - px) ** 2 + (src.py - py) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = src;
      }
    }
    state.selectedSource = best;
    state.spectrumPixel = {x: Math.floor(px), y: Math.floor(py)};
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
  if (!stateResp.ok) throw new Error(boot.error || "Could not initialize sky viewer");
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

init().catch(error => setDataStatus(`Could not initialize: ${error.message}`));
