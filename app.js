const state = {
  config: null,
  sky: null,
  decoded: null,
  clientCache: new Map(),
  ra: 133.7867,
  dec: -7.2442,
  fov: 300,
  windowYears: 10.0,
  releaseId: "SPHEREx-DR1",
  mode: "blink",
  detector: "all",
  fftFilter: "raw",
  playing: true,
  speedMs: 220,
  zoom: 1.0,
  panX: 0,
  panY: 0,
  invert: false,
  showGaia: true,
  showWise: true,
  showFlags: true,
  showAladin: false,
  epochOps: [],
  winStart: 2016.0,
  winEnd: 2026.0,
  cursorEpochPos: 0,
  selectedSource: null,
  aladinInstance: null,
  aladinSurvey: "P/AllWISE/color"
};

const offscreenCanvas = document.createElement("canvas");
offscreenCanvas.width = 64;
offscreenCanvas.height = 64;
const offscreenCtx = offscreenCanvas.getContext("2d");

let blinkTimer = null;
let dragState = null;

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
  if (merged.has("release")) state.releaseId = merged.get("release");
  if (merged.get("gaia") === "0") state.showGaia = false;
  if (merged.get("wise") === "0") state.showWise = false;
  if (merged.get("flags") === "0") state.showFlags = false;
  if (merged.get("invert") === "1") state.invert = true;
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
  window.history.replaceState(null, "", `#${params.toString()}`);
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
    coaddFft: decodeBase64Typed(sky.coadd_fft_b64, Float32Array),
    flags: decodeBase64Typed(sky.flags_b64, Uint32Array),
    grid: sky.grid_size,
    nEpochs: sky.epochs.length,
    nDet: sky.detectors.length
  };
}

function skyCacheKey(ra, dec, fov, win, releaseId) {
  return `${ra.toFixed(5)}|${dec.toFixed(5)}|${Math.round(fov)}|${win.toFixed(1)}|${releaseId}`;
}

function applySkyData(sky, totalMs, cacheLabel) {
  state.sky = sky;
  state.decoded = decodeSkyPayload(sky);
  state.ra = sky.ra;
  state.dec = sky.dec;
  state.fov = sky.fov;
  state.windowYears = sky.window;
  state.releaseId = sky.release.id;
  state.epochOps = sky.epochs.map(() => "+");
  state.winStart = sky.epochs[0].year;
  state.winEnd = sky.epochs[sky.epochs.length - 1].year;
  state.cursorEpochPos = 0;
  state.selectedSource = sky.sources.length > 0 ? sky.sources[0] : null;

  document.getElementById("input-ra").value = sky.ra.toFixed(4);
  document.getElementById("input-dec").value = sky.dec.toFixed(4);
  document.getElementById("stat-fov").textContent = `FOV ${Math.round(sky.fov)}″`;
  document.getElementById("stat-window").textContent = `Window ${sky.window.toFixed(1)}y`;
  document.getElementById("stat-latency").textContent = `${totalMs.toFixed(1)} ms`;
  document.getElementById("stat-cache").textContent = `${cacheLabel} (${sky.server_ms.toFixed(1)}ms srv)`;

  syncControlUi();
  renderEpochLegend();
  renderCurrentFrame();
  renderSkyOverlay();
  renderSpectralCharts();
  renderTimelineBrush();
  syncAladinView();
  syncUrlHash();
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

async function querySky(ra, dec, fov = state.fov, win = state.windowYears, releaseId = state.releaseId, live = false) {
  const t0 = performance.now();
  const key = skyCacheKey(ra, dec, fov, win, releaseId);
  if (!live && state.clientCache.has(key)) {
    const cached = state.clientCache.get(key);
    applySkyData(cached, performance.now() - t0, "MEM-CACHE");
    return;
  }

  const url = `/api/sky?ra=${encodeURIComponent(ra)}&dec=${encodeURIComponent(dec)}&fov=${encodeURIComponent(fov)}&window=${encodeURIComponent(win)}&release=${encodeURIComponent(releaseId)}&live=${live ? "1" : "0"}`;
  const resp = await fetch(url);
  const sky = await resp.json();
  const elapsed = performance.now() - t0;

  if (state.clientCache.size >= 32) {
    const firstKey = state.clientCache.keys().next().value;
    state.clientCache.delete(firstKey);
  }
  state.clientCache.set(skyCacheKey(sky.ra, sky.dec, sky.fov, sky.window, sky.release.id), sky);
  applySkyData(sky, elapsed, sky.cache || "NET");
}

function getActiveEpochs() {
  if (!state.sky) return [];
  const active = [];
  for (let i = 0; i < state.sky.epochs.length; i += 1) {
    const ep = state.sky.epochs[i];
    const inWin = ep.year >= state.winStart - 0.01 && ep.year <= state.winEnd + 0.01;
    const op = state.epochOps[i] || "+";
    if (inWin && op !== ".") active.push({ idx: i, ep, op });
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

function samplePlane(epochIdx, detIdx, outBuf) {
  const { frames, coaddFft, grid } = state.decoded;
  const planeSize = grid * grid;
  if (detIdx === "fft2d") {
    const base = epochIdx * planeSize;
    for (let p = 0; p < planeSize; p += 1) outBuf[p] = coaddFft[base + p];
    return;
  }
  if (detIdx === "all") {
    const epochBase = epochIdx * 6 * planeSize;
    for (let p = 0; p < planeSize; p += 1) {
      let sum = 0;
      for (let d = 0; d < 6; d += 1) sum += frames[epochBase + d * planeSize + p];
      outBuf[p] = sum / 6.0;
    }
    return;
  }
  const dIdx = Number.parseInt(detIdx.slice(1), 10) - 1;
  const base = (epochIdx * 6 + dIdx) * planeSize;
  for (let p = 0; p < planeSize; p += 1) outBuf[p] = frames[base + p];
}

function accumulateComposite(active, detSpec, outBuf) {
  const planeSize = outBuf.length;
  const tmp = new Float32Array(planeSize);
  outBuf.fill(0);

  if (state.mode === "diff") {
    const hasExplicitMinus = active.some((a) => a.op === "-");
    let posCount = 0;
    let negCount = 0;
    const mid = Math.floor(active.length / 2);
    for (let k = 0; k < active.length; k += 1) {
      samplePlane(active[k].idx, detSpec, tmp);
      const isMinus = hasExplicitMinus ? active[k].op === "-" : k < mid;
      if (isMinus) {
        negCount += 1;
        for (let p = 0; p < planeSize; p += 1) outBuf[p] -= tmp[p];
      } else {
        posCount += 1;
        for (let p = 0; p < planeSize; p += 1) outBuf[p] += tmp[p];
      }
    }
    const normPos = Math.max(1, posCount);
    const normNeg = Math.max(1, negCount);
    if (posCount > 0 && negCount > 0) {
      outBuf.fill(0);
      for (let k = 0; k < active.length; k += 1) {
        samplePlane(active[k].idx, detSpec, tmp);
        const isMinus = hasExplicitMinus ? active[k].op === "-" : k < mid;
        const w = isMinus ? -1.0 / normNeg : 1.0 / normPos;
        for (let p = 0; p < planeSize; p += 1) outBuf[p] += tmp[p] * w;
      }
    }
    return;
  }

  let count = 0;
  for (let k = 0; k < active.length; k += 1) {
    samplePlane(active[k].idx, detSpec, tmp);
    const sign = active[k].op === "-" ? -1 : 1;
    for (let p = 0; p < planeSize; p += 1) outBuf[p] += tmp[p] * sign;
    count += 1;
  }
  if (count > 0) {
    for (let p = 0; p < planeSize; p += 1) outBuf[p] /= count;
  }
}

function renderCurrentFrame() {
  if (!state.sky || !state.decoded) return;
  const active = getActiveEpochs();
  const readout = document.getElementById("active-epoch-readout");
  if (active.length === 0) {
    readout.textContent = "No active epochs";
    return;
  }

  const grid = state.decoded.grid;
  const planeSize = grid * grid;
  const canvas = document.getElementById("sky-canvas");
  const ctx = canvas.getContext("2d");
  const imgData = offscreenCtx.createImageData(grid, grid);
  const pixels = imgData.data;

  const isDiff = state.mode === "diff";
  const minB = isDiff ? -2.2 : -0.25;
  const maxB = isDiff ? 2.2 : 8.5;

  if (state.mode === "blink") {
    const slot = active[state.cursorEpochPos % active.length];
    readout.textContent = `Epoch ${slot.ep.label} · ${slot.ep.source}`;
    highlightEpochChip(slot.idx);

    if (state.detector === "rgb") {
      const rBuf = new Float32Array(planeSize);
      const gBuf = new Float32Array(planeSize);
      const bBuf = new Float32Array(planeSize);
      samplePlane(slot.idx, "D5", rBuf);
      samplePlane(slot.idx, "D3", gBuf);
      samplePlane(slot.idx, "D1", bBuf);
      for (let p = 0; p < planeSize; p += 1) {
        const i4 = p * 4;
        pixels[i4] = Math.round(asinhStretch(rBuf[p], minB, maxB) * 255);
        pixels[i4 + 1] = Math.round(asinhStretch(gBuf[p], minB, maxB) * 255);
        pixels[i4 + 2] = Math.round(asinhStretch(bBuf[p], minB, maxB) * 255);
        pixels[i4 + 3] = 255;
      }
    } else {
      const buf = new Float32Array(planeSize);
      samplePlane(slot.idx, state.detector, buf);
      for (let p = 0; p < planeSize; p += 1) {
        const g = Math.round(asinhStretch(buf[p], minB, maxB) * 255);
        const i4 = p * 4;
        pixels[i4] = g;
        pixels[i4 + 1] = g;
        pixels[i4 + 2] = Math.min(255, Math.round(g * 1.04));
        pixels[i4 + 3] = 255;
      }
    }
  } else {
    highlightEpochChip(-1);
    readout.textContent = isDiff
      ? `Diff (-) across ${active.length} epochs`
      : `Co-add (+) across ${active.length} epochs`;

    if (state.detector === "rgb") {
      const rBuf = new Float32Array(planeSize);
      const gBuf = new Float32Array(planeSize);
      const bBuf = new Float32Array(planeSize);
      accumulateComposite(active, "D5", rBuf);
      accumulateComposite(active, "D3", gBuf);
      accumulateComposite(active, "D1", bBuf);
      for (let p = 0; p < planeSize; p += 1) {
        const i4 = p * 4;
        if (isDiff) {
          pixels[i4] = Math.round(Math.max(0, Math.min(255, 128 + rBuf[p] * 45)));
          pixels[i4 + 1] = Math.round(Math.max(0, Math.min(255, 128 + gBuf[p] * 45)));
          pixels[i4 + 2] = Math.round(Math.max(0, Math.min(255, 128 + bBuf[p] * 45)));
        } else {
          pixels[i4] = Math.round(asinhStretch(rBuf[p], minB, maxB) * 255);
          pixels[i4 + 1] = Math.round(asinhStretch(gBuf[p], minB, maxB) * 255);
          pixels[i4 + 2] = Math.round(asinhStretch(bBuf[p], minB, maxB) * 255);
        }
        pixels[i4 + 3] = 255;
      }
    } else {
      const buf = new Float32Array(planeSize);
      accumulateComposite(active, state.detector, buf);
      for (let p = 0; p < planeSize; p += 1) {
        const i4 = p * 4;
        if (isDiff) {
          // diverge cyan positive and coral negative around zero baseline for moving dipoles
          const v = buf[p];
          const pos = Math.min(255, Math.max(0, Math.round(v * 52)));
          const neg = Math.min(255, Math.max(0, Math.round(-v * 52)));
          pixels[i4] = Math.min(255, 16 + neg);
          pixels[i4 + 1] = Math.min(255, 22 + Math.round(pos * 0.85) + Math.round(neg * 0.25));
          pixels[i4 + 2] = Math.min(255, 32 + pos);
        } else {
          const g = Math.round(asinhStretch(buf[p], minB, maxB) * 255);
          pixels[i4] = g;
          pixels[i4 + 1] = g;
          pixels[i4 + 2] = Math.min(255, Math.round(g * 1.04));
        }
        pixels[i4 + 3] = 255;
      }
    }
  }

  offscreenCtx.putImageData(imgData, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offscreenCanvas, 0, 0);
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
      .attr("d", "M 0 -1.5 L 1.5 0 L 0 1.5 L -1.5 0 Z")
      .attr("transform", (d) => `translate(${d.px},${d.py})`)
      .attr("fill", "none")
      .attr("stroke", "#f59e0b")
      .attr("stroke-width", 0.28)
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
      .attr("r", 1.15)
      .attr("fill", "none")
      .attr("stroke", "#34d399")
      .attr("stroke-width", 0.25);

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

  if (state.showFlags && state.sky.flag_events) {
    const active = getActiveEpochs();
    const curEpoch = state.mode === "blink" && active.length
      ? active[state.cursorEpochPos % active.length].idx
      : -1;
    const flagsToShow = state.sky.flag_events.filter((f) => curEpoch === -1 || f.epoch === curEpoch);
    const flagLayer = svg.append("g").attr("class", "flags-layer");

    flagLayer.selectAll("rect")
      .data(flagsToShow)
      .join("rect")
      .attr("x", (d) => d.x - 1.1)
      .attr("y", (d) => d.y - 1.1)
      .attr("width", 2.2)
      .attr("height", 2.2)
      .attr("fill", "none")
      .attr("stroke", (d) => d.color)
      .attr("stroke-width", 0.28)
      .attr("stroke-dasharray", "0.6,0.4");
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

function getFilteredSpectrum(source) {
  if (!source) return state.sky.field_spectrum_102;
  if (state.fftFilter === "raw") return source.spectrum_102;
  return source.fft_bands[state.fftFilter] || source.spectrum_102;
}

function renderSpectralCharts() {
  if (!state.sky) return;
  const source = state.selectedSource || {
    name: "Field Average",
    kind: "Combined FOV",
    spectrum_102: state.sky.field_spectrum_102,
    fft_power_52: state.sky.field_fft_power_52,
    fft_bands: state.sky.field_fft_bands
  };

  document.getElementById("sed-title").textContent = `102-Band Spectrum · ${source.name}`;
  document.getElementById("sed-subtitle").textContent = `${source.kind} · filter=${state.fftFilter}`;
  document.getElementById("fft-subtitle").textContent = `Active passband: ${state.fftFilter}`;

  renderSedSvg(source);
  renderFftSvg(source);
}

function renderSedSvg(source) {
  const svgEl = document.getElementById("sed-svg");
  const w = svgEl.clientWidth || 440;
  const h = svgEl.clientHeight || 120;
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const margin = { top: 8, right: 10, bottom: 20, left: 34 };
  const iw = Math.max(40, w - margin.left - margin.right);
  const ih = Math.max(30, h - margin.top - margin.bottom);

  const lams = state.sky.wavelengths_um;
  const detIdx = state.sky.detector_index_102;
  const dets = state.sky.detectors;
  const rawSpec = source.spectrum_102;
  const filtSpec = getFilteredSpectrum(source);

  const yMin = Math.min(0, d3.min(filtSpec), d3.min(rawSpec));
  const yMax = Math.max(0.5, d3.max(rawSpec), d3.max(filtSpec)) * 1.1;

  const x = d3.scaleLinear().domain([0.75, 5.0]).range([0, iw]);
  const y = d3.scaleLinear().domain([yMin, yMax]).range([ih, 0]);

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  dets.forEach((d) => {
    g.append("rect")
      .attr("x", x(d.lambda_min_um))
      .attr("y", 0)
      .attr("width", Math.max(1, x(d.lambda_max_um) - x(d.lambda_min_um)))
      .attr("height", ih)
      .attr("fill", d.color)
      .attr("opacity", state.detector === d.id ? 0.16 : 0.05);
  });

  const markers = [
    { lam: 3.05, label: "H2O" },
    { lam: 3.35, label: "CH4" },
    { lam: 4.27, label: "CO2" },
    { lam: 4.67, label: "CO" }
  ];
  markers.forEach((m) => {
    g.append("line")
      .attr("x1", x(m.lam))
      .attr("x2", x(m.lam))
      .attr("y1", 0)
      .attr("y2", ih)
      .attr("stroke", "rgba(226, 232, 240, 0.2)")
      .attr("stroke-dasharray", "2,2");
    g.append("text")
      .attr("x", x(m.lam) + 2)
      .attr("y", 9)
      .attr("fill", "rgba(148, 163, 184, 0.8)")
      .style("font-size", "8px")
      .text(m.label);
  });

  const lineRaw = d3.line()
    .x((_, i) => x(lams[i]))
    .y((v) => y(v));

  if (state.fftFilter !== "raw") {
    g.append("path")
      .datum(rawSpec)
      .attr("fill", "none")
      .attr("stroke", "rgba(148, 163, 184, 0.4)")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "2,2")
      .attr("d", lineRaw);
  }

  for (let d = 0; d < 6; d += 1) {
    const seg = [];
    for (let i = 0; i < lams.length; i += 1) {
      if (detIdx[i] === d) seg.push({ lam: lams[i], val: filtSpec[i] });
    }
    const segLine = d3.line().x((p) => x(p.lam)).y((p) => y(p.val));
    g.append("path")
      .datum(seg)
      .attr("fill", "none")
      .attr("stroke", dets[d].color)
      .attr("stroke-width", 1.8)
      .attr("d", segLine);
  }

  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat((d) => `${d}µm`));

  g.append("g")
    .attr("class", "axis")
    .call(d3.axisLeft(y).ticks(4));
}

function renderFftSvg(source) {
  const svgEl = document.getElementById("fft-svg");
  const w = svgEl.clientWidth || 300;
  const h = svgEl.clientHeight || 120;
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const margin = { top: 8, right: 8, bottom: 20, left: 32 };
  const iw = Math.max(40, w - margin.left - margin.right);
  const ih = Math.max(30, h - margin.top - margin.bottom);
  const power = source.fft_power_52 || [];

  const x = d3.scaleBand()
    .domain(d3.range(power.length))
    .range([0, iw])
    .padding(0.18);
  const yMax = Math.max(1, d3.max(power.slice(1)) || 1);
  const y = d3.scaleLinear().domain([0, yMax]).range([ih, 0]).clamp(true);

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const bands = {
    raw: [0, power.length - 1],
    low: [0, 6],
    mid: [3, 20],
    high: [12, power.length - 1]
  };
  const [kMin, kMax] = bands[state.fftFilter] || bands.raw;

  g.append("rect")
    .attr("x", x(kMin) || 0)
    .attr("y", 0)
    .attr("width", Math.max(4, ((x(kMax) || iw) + x.bandwidth()) - (x(kMin) || 0)))
    .attr("height", ih)
    .attr("fill", "rgba(56, 189, 248, 0.12)");

  g.selectAll("rect.bar")
    .data(power)
    .join("rect")
    .attr("class", "bar")
    .attr("x", (_, i) => x(i))
    .attr("y", (d) => y(d))
    .attr("width", x.bandwidth())
    .attr("height", (d) => ih - y(d))
    .attr("fill", (_, i) => (i >= kMin && i <= kMax ? "#38bdf8" : "rgba(148, 163, 184, 0.25)"));

  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(x).tickValues([0, 6, 12, 20, 35, 50]).tickFormat((d) => `k${d}`));

  g.append("g")
    .attr("class", "axis")
    .call(d3.axisLeft(y).ticks(3));
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
  const minY = epochs[0].year - 0.4;
  const maxY = epochs[epochs.length - 1].year + 0.4;
  const x = d3.scaleLinear().domain([minY, maxY]).range([0, iw]);

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.selectAll("circle.ep-dot")
    .data(epochs)
    .join("circle")
    .attr("class", "ep-dot")
    .attr("cx", (d) => x(d.year))
    .attr("cy", ih * 0.5)
    .attr("r", 4.5)
    .attr("fill", (d) => (d.source.includes("SPHEREx") ? "#38bdf8" : "#f59e0b"));

  g.selectAll("text.ep-lbl")
    .data(epochs)
    .join("text")
    .attr("x", (d) => x(d.year))
    .attr("y", ih * 0.5 - 9)
    .attr("text-anchor", "middle")
    .attr("fill", "rgba(148, 163, 184, 0.85)")
    .style("font-size", "8px")
    .text((d) => d.label);

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
      document.getElementById("stat-window").textContent = `Window ${span.toFixed(1)}y`;
      renderEpochLegend();
      renderCurrentFrame();
    });

  const brushG = g.append("g").attr("class", "brush").call(brush);
  brushG.call(brush.move, [x(state.winStart), x(state.winEnd)]);

  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d3.format(".0f")));
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

function syncAladinView() {
  if (!state.showAladin) return;
  const pane = document.getElementById("aladin-pane");
  pane.classList.remove("hidden");
  const statusEl = document.getElementById("aladin-status");

  if (!window.A) {
    statusEl.textContent = "Aladin Lite v3 unavailable offline (using built-in Gaia/WISE D3 overlays)";
    return;
  }

  window.A.init.then(() => {
    const fovDeg = Math.max(0.03, state.fov / 3600.0);
    if (!state.aladinInstance) {
      state.aladinInstance = window.A.aladin("#aladin-lite-div", {
        survey: state.aladinSurvey,
        target: `${state.ra} ${state.dec}`,
        fov: fovDeg
      });
      if (window.A.catalogFromVizieR) {
        const gaiaCat = window.A.catalogFromVizieR("I/355/gaiadr3", `${state.ra} ${state.dec}`, fovDeg, {
          color: "#34d399",
          shape: "circle",
          limit: 120
        });
        state.aladinInstance.addCatalog(gaiaCat);
      }
    } else {
      state.aladinInstance.gotoRaDec(state.ra, state.dec);
      state.aladinInstance.setFoV(fovDeg);
    }
    statusEl.textContent = `Synced to RA ${state.ra.toFixed(4)}°, Dec ${state.dec.toFixed(4)}°`;
  }).catch(() => {
    statusEl.textContent = "Aladin Lite init skipped";
  });
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

  document.getElementById("btn-irsa-live").addEventListener("click", () => {
    querySky(state.ra, state.dec, state.fov, state.windowYears, state.releaseId, true);
  });

  document.getElementById("btn-copy-url").addEventListener("click", async () => {
    syncUrlHash();
    const shareUrl = `${window.location.origin}/?ra=${state.ra.toFixed(5)}&dec=${state.dec.toFixed(5)}&fov=${Math.round(state.fov)}&window=${state.windowYears.toFixed(1)}`;
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
    if (state.aladinInstance) state.aladinInstance.setImageSurvey(state.aladinSurvey);
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
    dragState = null;
  });

  stage.addEventListener("mousemove", (ev) => {
    if (!state.sky) return;
    const { px, py } = canvasPointToPixel(ev);
    if (px < 0 || px >= 64 || py < 0 || py >= 64) return;
    const cosDec = Math.max(0.15, Math.cos((state.dec * Math.PI) / 180));
    const scaleDeg = state.sky.pixel_scale_arcsec / 3600.0;
    const cursorRa = ((state.ra + (32.0 - px) * (scaleDeg / cosDec)) % 360 + 360) % 360;
    const cursorDec = state.dec + (32.0 - py) * scaleDeg;

    const flagHit = (state.sky.flag_events || []).find((f) => Math.hypot(f.x - px, f.y - py) < 2.1);
    const tip = document.getElementById("flag-tooltip");
    if (flagHit && state.showFlags) {
      const stageRect = stage.getBoundingClientRect();
      tip.textContent = `FLAG ${flagHit.name} (bit ${flagHit.bit}): ${flagHit.label}`;
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
    if (dragState && dragState.moved) return;
    if (!state.sky) return;
    const { px, py } = canvasPointToPixel(ev);
    if (ev.shiftKey) {
      const cosDec = Math.max(0.15, Math.cos((state.dec * Math.PI) / 180));
      const scaleDeg = state.sky.pixel_scale_arcsec / 3600.0;
      const targetRa = ((state.ra + (32.0 - px) * (scaleDeg / cosDec)) % 360 + 360) % 360;
      const targetDec = state.dec + (32.0 - py) * scaleDeg;
      querySky(targetRa, targetDec);
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
    opt.textContent = `${rel.id}`;
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
      state.clientCache.set(skyCacheKey(sky.ra, sky.dec, sky.fov, sky.window, sky.release.id), sky);
    });
  } catch {
    return;
  }
}

async function init() {
  const hasUrlCoords = parseUrlParams();
  bindEvents();

  const t0 = performance.now();
  const stateResp = await fetch("/api/state");
  const boot = await stateResp.json();
  state.config = boot.config;
  populateReleases(boot.config.releases);
  populatePresets(boot.config.preset_targets);

  if (hasUrlCoords) {
    await querySky(state.ra, state.dec, state.fov, state.windowYears, state.releaseId);
  } else {
    const presets = boot.config.preset_targets || [];
    const pick = presets[Math.floor(Math.random() * Math.max(1, presets.length))];
    if (pick && (pick.ra !== boot.initial_sky.ra || pick.dec !== boot.initial_sky.dec)) {
      await querySky(pick.ra, pick.dec, pick.fov || 300, state.windowYears, state.releaseId);
    } else {
      const sky = boot.initial_sky;
      state.clientCache.set(skyCacheKey(sky.ra, sky.dec, sky.fov, sky.window, sky.release.id), sky);
      applySkyData(sky, performance.now() - t0, "PREWARM");
    }
  }

  applyVisualTransform();
  restartBlinkLoop();
  prefetchPresetsBatch(boot.config.preset_targets);
}

init();
