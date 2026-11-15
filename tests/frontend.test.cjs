const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function appContext(extra = {}) {
  const elements = new Map();
  const context = vm.createContext({
    console, URLSearchParams, AbortController, Float32Array, Uint32Array, Uint8Array,
    Float64Array, Uint16Array, performance, clearTimeout, setTimeout: () => 1,
    window: { location: { search: '', hash: '', pathname: '/' }, history: { replaceState() { } } },
    document: {
      querySelectorAll: () => [], body: { classList: { contains: () => false } },
      getElementById: id => { if (!elements.has(id)) elements.set(id, { textContent: '', classList: { toggle() { }, add() { }, remove() { } }, setAttribute() { }, removeAttribute() { } }); return elements.get(id); }
    },
    d3: { format: () => value => String(value) }, ...extra
  });
  const source = fs.readFileSync(require.resolve('../app.js'), 'utf8').replace(/init\(\)\.catch\([^\n]+\);\s*$/, '');
  vm.runInContext(source, context);
  return context;
}

test('latest FOV request wins even if an old response arrives later', async () => {
  const context = appContext({
    fetch: async url => {
      const fov = Number(new URL(url, 'http://local').searchParams.get('fov'));
      await new Promise(resolve => setTimeout(resolve, fov === 150 ? 30 : 1));
      return { ok: true, json: async () => ({ ra: 1, dec: 2, fov, window: 10, release: { id: 'auto' }, data_status: 'ready' }) };
    }
  });
  vm.runInContext('globalThis.applied=[]; applySkyData = sky => applied.push(sky.fov);', context);
  await Promise.all([vm.runInContext('querySky(1,2,150)', context), vm.runInContext('querySky(1,2,600)', context)]);
  assert.deepEqual(Array.from(context.applied), [600]);
});

test('missing detector pixels do not dilute available image values', () => {
  const context = appContext();
  const output = vm.runInContext(`state.decoded={grid:1,nDet:6,frames:new Float32Array([12,NaN,NaN,NaN,NaN,NaN])};
    globalThis.buffer=new Float32Array(1); samplePlane(0,'all',buffer); buffer[0]`, context);
  assert.equal(output, 12);
});

test('differences require valid pixels and compatible wavelength maps', () => {
  const context = appContext();
  vm.runInContext(`state.mode='diff';state.decoded={grid:1,nDet:6,
    frames:new Float32Array([2,NaN,NaN,NaN,NaN,NaN,4,NaN,NaN,NaN,NaN,NaN]),
    wavelengths:new Float32Array([1,1.001]),bandwidths:new Float32Array([.01,.01])};
    globalThis.buffer=new Float32Array(1);globalThis.active=[{idx:0,op:'-'},{idx:1,op:'+'}];
    accumulateComposite(active,'D1',buffer);`, context);
  assert.equal(context.buffer[0], 2);
  vm.runInContext("state.decoded.wavelengths[1]=1.1;accumulateComposite(active,'D1',buffer)", context);
  assert.ok(Number.isNaN(context.buffer[0]));
});

test('share URL replaces stale coordinate query parameters', () => {
  let url;
  const context = appContext({
    window: {
      location: { search: '?ra=10&dec=20', hash: '', pathname: '/viewer/' },
      history: { replaceState: (_state, _title, value) => { url = value; } }
    }
  });
  vm.runInContext('state.ra=80;state.dec=40;state.fov=450;state.zoom=2;syncUrlHash()', context);
  const parsed = new URL(url, 'http://local');
  assert.equal(parsed.searchParams.get('ra'), '80.00000');
  assert.equal(parsed.searchParams.get('fov'), '450');
  assert.equal(parsed.searchParams.get('zoom'), '2.00');
  assert.equal(parsed.hash, '');
});

test('DC is distinct from a finite spectral period', () => {
  const context = appContext();
  assert.equal(vm.runInContext('formatSpectralPeriod(null)', context), 'DC');
  assert.equal(vm.runInContext('formatSpectralPeriod(.2)', context), '0.2 µm');
});

test('inversion exactly complements the display stretch without changing data', () => {
  const context = appContext();
  for (const value of [-10, 0, 2, 10]) {
    const sum = vm.runInContext(`state.invert=false;globalThis.normal=asinhStretch(${value});state.invert=true;normal+asinhStretch(${value})`, context);
    assert.ok(Math.abs(sum - 1) < 1e-12);
  }
});

test('uniform spectral samples reconstruct through all three disjoint filters', () => {
  const context = appContext();
  const result = vm.runInContext(`spectralAnalysis(Array.from({length:12},(_,i)=>({wavelength_um:1+i*.1,brightness:3+Math.cos(2*Math.PI*i/4)})))`, context);
  assert.equal(result.fft_amplitude.length, 7);
  assert.ok(Math.abs(result.fft_amplitude[0] - 36) < 1e-10);
  assert.ok(Math.abs(result.fft_amplitude[3] - 6) < 1e-10);
  assert.ok(Math.abs(result.fft_period_um[3] - .4) < 1e-10);
  for (let i = 0; i < 12; i++) {
    assert.ok(Math.abs(result.fft_bands.low[i] - 3) < 1e-10);
    assert.ok(Math.abs(result.fft_bands.mid[i] - Math.cos(2 * Math.PI * i / 4)) < 1e-10);
    assert.ok(Math.abs(result.fft_bands.high[i]) < 1e-10);
    assert.ok(Math.abs(result.fft_bands.low[i] + result.fft_bands.mid[i] + result.fft_bands.high[i] - (3 + Math.cos(2 * Math.PI * i / 4))) < 1e-10);
  }
  assert.equal(Object.keys(vm.runInContext('spectralAnalysis([{wavelength_um:1,brightness:1},{wavelength_um:2,brightness:2},{wavelength_um:4,brightness:3},{wavelength_um:5,brightness:4}])', context)).length, 0);
  assert.equal(Object.keys(vm.runInContext('spectralAnalysis([{wavelength_um:1,brightness:1},{wavelength_um:2,brightness:2},{wavelength_um:NaN,brightness:3},{wavelength_um:4,brightness:4}])', context)).length, 0);
});

test('Aladin retains its zoom without changing the science FOV or issuing setFoV', async () => {
  const context = appContext();
  vm.runInContext(`state.showAladin=true;state.fov=450;
    document.getElementById('aladin-pane').classList={remove(){}};
    globalThis.events={};globalThis.moves=[];
    window.A={init:Promise.resolve(),aladin:()=>({on:(name,cb)=>events[name]=cb,
      gotoRaDec:(ra,dec)=>moves.push([ra,dec]),setFoV:()=>{throw new Error('unexpected zoom reset')}})};
    syncAladinView();`, context);
  await Promise.resolve();
  vm.runInContext("events.zoomChanged([.3,.2]);state.ra=42;syncAladinView()", context);
  await Promise.resolve();
  assert.equal(vm.runInContext('state.fov', context), 450);
  assert.equal(vm.runInContext('state.aladinFov', context), .3);
  assert.equal(context.moves[0][0], 42);
  vm.runInContext('events.zoomChanged(.4)', context);
  assert.equal(vm.runInContext('state.aladinFov', context), .4);
  assert.equal(vm.runInContext('state.fov', context), 450);
});

test('cached data is shown synchronously while refresh is pending', async () => {
  let finish;
  const context = appContext({ fetch: () => new Promise(resolve => { finish = resolve; }) });
  vm.runInContext(`globalThis.applied=[];applySkyData=sky=>applied.push(sky.fov);
    rememberSky({ra:1,dec:2,fov:300,window:10,release:{id:'auto'},data_status:'ready'});`, context);
  const pending = vm.runInContext('querySky(1,2,300)', context);
  assert.deepEqual(Array.from(context.applied), [300]);
  finish({ ok: true, json: async () => ({ data_status: 'loading' }) });
  await pending;
  assert.deepEqual(Array.from(context.applied), [300]);
});

test('FOV previews reuse measured pixels, mask uncovered sky, and never pollute the cache', () => {
  const context = appContext();
  vm.runInContext(`globalThis.source={ra:1,dec:2,fov:300,window:10,release:{id:'auto'},data_status:'ready',sources:[{px:3,py:1}],
    epochs:[{mjd:Date.now()/86400000+40586,source:'spherex_dr1',detectors:[1]}],measurements:[]};
    decodedCache.set(source,{grid:4,nDet:1,nEpochs:1,frames:new Float32Array(16).fill(5),
      flags:new Uint32Array(16),wavelengths:new Float32Array(16).fill(1),bandwidths:new Float32Array(16).fill(.1)});
    rememberSky(source);globalThis.preview=cachedSkyPreview(1,2,600,10,'spherex_dr1');
    globalThis.decoded=decodedCache.get(preview);rememberSky(preview);`, context);
  assert.equal(context.preview.fov, 600);
  assert.equal(context.preview.sources[0].px, 2.5);
  assert.equal(context.decoded.frames[5], 5);
  assert.ok(Number.isNaN(context.decoded.frames[0]));
  assert.equal(context.decoded.flags[0], 1 << 9);
  assert.equal(vm.runInContext('state.clientCache.size', context), 1);
  assert.equal(vm.runInContext('decodedCache.get(source).frames[0]', context), 5);
  assert.equal(vm.runInContext("cachedSkyPreview(1,2,600,10,'spherex_dr2')", context), null);
  assert.equal(vm.runInContext("cachedSkyPreview(2,2,600,10,'auto')", context), null);
});

test('Gaia propagation agrees with Astropy WCS including RA wrap and near the pole', () => {
  const cases = JSON.parse(fs.readFileSync(require.resolve('./astrometry-fixture.json'), 'utf8'));
  for (const sample of cases) {
    const context = appContext();
    context.sample = sample;
    const point = vm.runInContext(`state.ra=sample.ra;state.dec=sample.dec;state.sky={pixel_scale_arcsec:300/64};state.decoded={grid:64};
      catalogPosition({ra:sample.ra,dec:sample.dec,reference_epoch:2016,gaia:{pmra:1000,pmdec:-2000}},sample.year)`, context);
    assert.ok(Math.abs(point.px - sample.px) < 1e-7);
    assert.ok(Math.abs(point.py - sample.py) < 1e-7);
    const wise = vm.runInContext('catalogPosition({ra:sample.ra,dec:sample.dec,wise:{},reference_epoch:2016},2026)', context);
    assert.equal(wise.propagated, false);
    assert.ok(Math.abs(wise.px - 32) < 1e-8 && Math.abs(wise.py - 32) < 1e-8);
    const missing = vm.runInContext('catalogPosition({ra:sample.ra,dec:sample.dec,gaia:{pmra:null,pmdec:1},reference_epoch:2016},2026)', context);
    assert.equal(missing.propagated, false);
  }
});

test('flag overlays and tooltips use only the image contributors in RGB, blink, and detector modes', () => {
  const context = appContext();
  vm.runInContext(`state.sky={epochs:[1,3,5,2].map((d,i)=>({year:2026,mjd:61000+i,detectors:[d]}))};
    state.decoded={grid:1,flags:new Uint32Array([2,4,64,128])};state.epochOps=['+','+','+','+'];
    state.winStart=2025;state.winEnd=2027;state.detector='rgb';state.mode='coadd';`, context);
  assert.equal(vm.runInContext('displayedFlagsAt(0)', context), 70);
  assert.equal(vm.runInContext("state.mode='blink';state.cursorEpochPos=3;displayedFlagsAt(0)", context), 70);
  assert.equal(vm.runInContext("state.epochOps[2]='.';state.cursorEpochPos=2;displayedFlagsAt(0)", context), 128);
  assert.equal(vm.runInContext("state.mode='coadd';state.detector='D1';displayedFlagsAt(0)", context), 2);
});

test('RGB selects the nearest available exposure per detector with deterministic ties', () => {
  const context = appContext();
  const result = vm.runInContext(`globalThis.epochs=[
    {idx:0,ep:{mjd:10,detectors:[1]}},{idx:1,ep:{mjd:30,detectors:[1]}},
    {idx:2,ep:{mjd:12,detectors:[3]}},{idx:3,ep:{mjd:32,detectors:[3]}},
    {idx:4,ep:{mjd:14,detectors:[5]}},{idx:5,ep:{mjd:34,detectors:[5]}}];
    nearestRgbEpochs(epochs,20).map(a=>a.idx)`, context);
  assert.deepEqual(Array.from(result), [4, 2, 0]);
  assert.deepEqual(Array.from(vm.runInContext('nearestRgbEpochs(epochs,33).map(a=>a.idx)', context)), [5, 3, 1]);
  assert.equal(vm.runInContext('nearestRgbEpochs(epochs.slice(0,4),20)[0]', context), null);
  assert.deepEqual(Array.from(vm.runInContext('nearestRgbEpochs(epochs,NaN)', context)), [null, null, null]);
});

test('RGB blink renders known colors from three real channel planes and changes with time', () => {
  const context = appContext();
  vm.runInContext(`renderSkyOverlay=()=>{};updateTimelineCursor=()=>{};highlightEpochChip=()=>{};
    document.getElementById('sky-canvas').getContext=()=>({clearRect(){},
      createImageData:(w,h)=>({data:new Uint8Array(w*h*4)}),putImageData:image=>globalThis.rendered=image.data});
    state.mode='blink';state.detector='rgb';state.winStart=2024;state.winEnd=2027;
    state.epochOps=Array(6).fill('+');state.cursorEpochPos=1;
    state.sky={epochs:[1,3,5,1,3,5].map((d,i)=>({year:2025+i*.01,mjd:60000+(i<3?i:100+i-3),
      detectors:[d],label:'date'+i+' D'+d,source:'test'}))};
    state.decoded={grid:4,nDet:6,frames:new Float32Array(6*6*16).fill(NaN)};
    state.sky.epochs.forEach((ep,i)=>{const d=ep.detectors[0];for(let p=0;p<16;p++) {
      const value=d===5?p:d===3?15-p:p%4;
      state.decoded.frames[(i*6+d-1)*16+p]=i<3?value:(d===1?3:15)-value;
    }});
    globalThis.original=state.decoded.frames.slice();renderCurrentFrame();`, context);
  assert.deepEqual(Array.from(context.rendered.slice(0, 4)), [0, 255, 0, 255]);
  assert.deepEqual(Array.from(context.rendered.slice(60, 64)), [255, 0, 255, 255]);
  assert.equal(vm.runInContext('state.mode', context), 'blink');
  assert.ok(vm.runInContext("document.getElementById('active-epoch-readout').textContent.includes('non-simultaneous')", context));
  vm.runInContext('state.cursorEpochPos=4;renderCurrentFrame()', context);
  assert.deepEqual(Array.from(context.rendered.slice(0, 4)), [255, 0, 255, 255]);
  assert.deepEqual(Array.from(context.rendered.slice(60, 64)), [0, 255, 0, 255]);
  assert.ok(vm.runInContext('original.every((v,i)=>Object.is(v,state.decoded.frames[i]))', context));
  vm.runInContext('state.winStart=2025.04;state.winEnd=2025.06;state.cursorEpochPos=0;renderCurrentFrame()', context);
  assert.ok(vm.runInContext('displayedEpochs().every(a=>a.idx>=3)', context));
  assert.deepEqual(Array.from(context.rendered.slice(0, 4)), [255, 0, 255, 255]);
  vm.runInContext('state.winStart=2024;state.winEnd=2027', context);
  vm.runInContext("state.epochOps[2]='.';state.epochOps[5]='.';state.cursorEpochPos=0;renderCurrentFrame()", context);
  for (let p = 0; p < context.rendered.length; p += 4) {
    assert.equal(context.rendered[p], context.rendered[p + 1]);
    assert.equal(context.rendered[p], context.rendered[p + 2]);
  }
});

test('the public FFT demo contains independently known low, mid, and high modes', () => {
  const context = appContext();
  const result = vm.runInContext('spectralAnalysis(demoSpectralSamples())', context);
  for (const [k, amplitude] of [[0, 144], [3, 24], [12, 12], [20, 6]]) assert.ok(Math.abs(result.fft_amplitude[k] - amplitude) < 1e-9);
  for (let i = 0; i < 48; i++) {
    assert.ok(Math.abs(result.fft_bands.low[i] - (3 + Math.cos(2 * Math.PI * 3 * i / 48))) < 1e-9);
    assert.ok(Math.abs(result.fft_bands.mid[i] - .5 * Math.cos(2 * Math.PI * 12 * i / 48)) < 1e-9);
    assert.ok(Math.abs(result.fft_bands.high[i] - .25 * Math.cos(2 * Math.PI * 20 * i / 48)) < 1e-9);
  }
});

test('non-uniform SPHEREx multi-detector and single-detector LVF cutouts produce additive gridded FFT spectra', () => {
  const context = appContext();
  const multi = vm.runInContext(`globalThis.meas=[
    {wavelength_um:0.758,brightness:18.4,detector:0,mjd:60900},
    {wavelength_um:1.124,brightness:24.1,detector:1,mjd:60901},
    {wavelength_um:1.682,brightness:31.7,detector:2,mjd:60902},
    {wavelength_um:2.415,brightness:21.9,detector:3,mjd:60903},
    {wavelength_um:3.812,brightness:12.6,detector:4,mjd:60904},
    {wavelength_um:4.871,brightness:8.2,detector:5,mjd:60905}
  ];observationSpectrum(meas)`, context);
  assert.equal(multi.gridded, true);
  assert.equal(multi.fft_amplitude.length, 17);
  for (let i = 0; i < 6; i++) {
    const sum = multi.fft_bands.low[i] + multi.fft_bands.mid[i] + multi.fft_bands.high[i];
    assert.ok(Math.abs(sum - context.meas[i].brightness) < 1e-9);
  }
  const singleDet = vm.runInContext(`state.sky={epochs:[{year:2026,mjd:61000,detectors:[1]}]};
    state.decoded={grid:8,nDet:6,frames:new Float32Array(6*64).fill(NaN),wavelengths:new Float32Array(64)};
    for(let p=0;p<64;p++){
      const w=0.75+0.005*p;
      state.decoded.wavelengths[p]=w;
      state.decoded.frames[p]=10+2*Math.cos(2*Math.PI*(w-0.75)/0.16);
    }
    observationSpectrum([{wavelength_um:0.91,brightness:10,detector:0,mjd:61000}],[{idx:0,ep:state.sky.epochs[0]}])`, context);
  assert.equal(singleDet.gridded, true);
  assert.equal(singleDet.fft_amplitude.length, 17);
});

test('spatial smoothing mode propagates neighbor artifact flags and diff unconfigured state clears flags', () => {
  const context = appContext();
  vm.runInContext(`state.config={flags_bitmask:[{bit:26,label:'BLOOM',severity:'warn',color:'#f59e0b'}]};
    state.sky={epochs:[{year:2026,mjd:61000,detectors:[1]}]};
    state.decoded={grid:3,nDet:6,frames:new Float32Array(6*9).fill(1),flags:new Uint32Array(9)};
    state.decoded.flags[0]=1<<26;
    state.epochOps=['+'];state.winStart=2025;state.winEnd=2027;state.detector='D1';state.mode='coadd';`, context);
  assert.equal(vm.runInContext('displayedFlagsAt(4)', context), 0);
  assert.equal(vm.runInContext("state.detector='fft2d';displayedFlagsAt(4)", context), 1 << 26);
  const summary = vm.runInContext('flagSummaryAt(4)', context);
  assert.ok(summary.labels.includes('BLOOM'));
  assert.equal(vm.runInContext("state.mode='diff';displayedFlagsAt(0)", context), 0);
});
