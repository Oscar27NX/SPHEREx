const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function appContext(extra = {}) {
  const elements = new Map();
  const context = vm.createContext({
    console, URLSearchParams, AbortController, Float32Array, Uint32Array, Uint8Array,
    Float64Array, Uint16Array, performance, clearTimeout, setTimeout: () => 1,
    window: {location: {search: '', hash: '', pathname: '/'}, history: {replaceState() {}}},
    document: {querySelectorAll: () => [], body: {classList: {contains: () => false}},
      getElementById: id => { if (!elements.has(id)) elements.set(id, {textContent: ''}); return elements.get(id); }},
    d3: {format: () => value => String(value)}, ...extra
  });
  const source = fs.readFileSync(require.resolve('../app.js'), 'utf8').replace(/init\(\)\.catch\([^\n]+\);\s*$/, '');
  vm.runInContext(source, context);
  return context;
}

test('latest FOV request wins even if an old response arrives later', async () => {
  const context = appContext({fetch: async url => {
    const fov = Number(new URL(url, 'http://local').searchParams.get('fov'));
    await new Promise(resolve => setTimeout(resolve, fov === 150 ? 30 : 1));
    return {ok: true, json: async () => ({ra: 1, dec: 2, fov, window: 10, release: {id: 'auto'}, data_status: 'ready'})};
  }});
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
  const context = appContext({window: {location: {search: '?ra=10&dec=20', hash: '', pathname: '/viewer/'},
    history: {replaceState: (_state, _title, value) => { url = value; }}}});
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
