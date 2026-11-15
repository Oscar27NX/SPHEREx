const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('../.cache/browser/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({headless: true,
    executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const fixture = JSON.parse(fs.readFileSync('.cache/browser-fixture.json', 'utf8'));
    fixture.config.releases = [{id:'auto',label:'All releases'}, {id:'spherex_dr1',label:'Cached release'}, {id:'spherex_dr2',label:'Unavailable test release'}];
    let scenario = 'normal';
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let body;
      if (scenario === 'unavailable' && url.pathname !== '/api/state') {
        await route.fulfill({status:503,json:{error:'503 internal upstream failure'}});
        return;
      }
      if (url.pathname === '/api/state') body = fixture;
      else if (url.pathname === '/api/batch') body = {results: []};
      else {
        requests.push(url.toString());
        const sky = structuredClone(fixture.initial_sky);
        for (const key of ['ra', 'dec', 'fov', 'window']) sky[key] = Number(url.searchParams.get(key));
        sky.pixel_scale_arcsec=sky.fov/sky.grid_size;
        sky.release.id = url.searchParams.get('release');
        sky.cache = 'HIT'; sky.refreshing = false;
        if (scenario === 'missing-rgb') {
          const frames = Buffer.from(sky.frames_b64,'base64');
          sky.epochs.forEach((ep,i) => {
            if (ep.detectors.includes(5)) {
              ep.detectors=[];
              for(let p=i*6*64*64;p<(i+1)*6*64*64;p++) frames.writeFloatLE(NaN,p*4);
            }
          });
          sky.frames_b64=frames.toString('base64');
        }
        if (scenario === 'partial-rgb') {
          const frames=Buffer.from(sky.frames_b64,'base64');
          sky.epochs.forEach((ep,i)=> {
            const detector=ep.detectors[0];
            if ([1,3,5].includes(detector)) frames.writeFloatLE(detector===5 ? NaN : 5, (i*6+detector-1)*64*64*4);
          });
          sky.frames_b64=frames.toString('base64');
        }
        if (scenario === 'no-center') sky.measurements=[];
        if (scenario === 'uniform-spectrum') sky.measurements=Array.from({length:12},(_,i)=>({
          wavelength_um:1+i*.1,brightness:3+Math.cos(2*Math.PI*i/4),detector:0,mjd:61000+i}));
        if (scenario === 'empty') {
          sky.epochs=[];sky.measurements=[];sky.sources=[];
          for(const key of ['frames_b64','flags_b64','wavelength_maps_b64','bandwidth_maps_b64']) sky[key]='';
          sky.data_status='empty';sky.message='No observations in this test field';
        }
        body = sky;
        if (sky.fov === 150) await new Promise(resolve => setTimeout(resolve, 150));
      }
      await route.fulfill({json: body});
    });
    await page.goto(`http://127.0.0.1:8081/?ra=${fixture.initial_sky.ra}&dec=${fixture.initial_sky.dec}&fov=450`);
    await page.waitForFunction(() => document.querySelector('#stat-fov').textContent.includes('450'));
    assert.equal(await page.locator('.hud-telemetry > *').count(), 3);
    assert.equal(await page.locator('#stat-cache,#stat-latency,#stat-window,#btn-irsa-live').count(), 0);
    await page.locator('[data-fov="150"]').click();
    await page.locator('[data-fov="600"]').click();
    await page.waitForFunction(() => document.querySelector('#stat-fov').textContent.includes('600'));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#stat-fov').textContent(), 'FOV 600″');
    assert.equal(new URL(page.url()).searchParams.get('fov'), '600');
    await page.locator('#input-fov').fill('450');
    await page.locator('#input-fov').press('Tab');
    await page.waitForFunction(() => document.querySelector('#stat-fov').textContent.includes('450'));
    const beforeZoom = requests.length;
    await page.locator('#viewport-stage').hover();
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(100);
    assert.notEqual(await page.locator('#stat-zoom').textContent(), 'Zoom 1.0x');
    assert.equal(requests.length, beforeZoom);
    await page.locator('#btn-play-pause').click();
    await page.locator('#tog-gaia').click();
    assert.ok(await page.locator('.gaia-layer circle').count() > 0);
    assert.equal(await page.locator('#overlay-status').textContent(), '');
    await page.locator('#tog-wise').click();
    assert.ok(await page.locator('.wise-layer path').count() > 0);
    assert.equal(await page.locator('#overlay-status').textContent(), '');
    await page.locator('#tog-flags').click();
    assert.ok(await page.locator('.flags-layer rect').count()>0);
    assert.equal(await page.locator('#overlay-status').textContent(), '');
    await page.locator('#tog-flags').click();
    await page.locator('[data-mode="coadd"]').click();
    await page.locator('[data-det="rgb"]').click();
    const pixels = () => page.locator('#sky-canvas').evaluate(c => Array.from(c.getContext('2d').getImageData(0,0,64,64).data));
    const normal = await pixels();
    await page.locator('#tog-invert').click();
    const inverted = await pixels();
    let valid=0;
    for(let p=0;p<normal.length;p+=4) {
      assert.equal(normal[p+3],inverted[p+3]);
      if(normal[p+3]) {valid++;for(let c=0;c<3;c++) assert.ok(Math.abs(normal[p+c]+inverted[p+c]-255)<=1);}
    }
    assert.ok(valid>0);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#stat-fov').textContent.includes('450'));
    assert.equal(new URL(page.url()).searchParams.get('det'), 'rgb');
    assert.equal(new URL(page.url()).searchParams.get('invert'), '1');
    assert.equal(await page.locator('#timeline-svg .ep-dot:visible').count(),0);
    const selection=await page.locator('#timeline-svg .brush .selection').boundingBox();
    const handle=await page.locator('#timeline-svg .brush .handle--e').boundingBox();
    await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
    await page.mouse.down();
    await page.mouse.move(selection.x+selection.width*.35,handle.y+handle.height/2,{steps:8});
    await page.mouse.up();
    assert.ok(await page.locator('.epoch-chip.out-window').count()>0);

    scenario='missing-rgb';
    await page.goto('http://127.0.0.1:8081/?ra=1&dec=2&det=rgb&mode=coadd');
    await page.waitForFunction(()=>document.querySelector('#active-epoch-readout').textContent.includes('RGB needs D5'));
    const gray=await pixels();
    assert.ok(gray.some((v,i)=>i%4===3&&v>0));
    for(let p=0;p<gray.length;p+=4) if(gray[p+3]) {assert.equal(gray[p],gray[p+1]);assert.equal(gray[p],gray[p+2]);}

    scenario='partial-rgb';
    await page.goto('http://127.0.0.1:8081/?ra=1&dec=2&det=rgb&mode=coadd');
    await page.waitForFunction(()=>document.querySelector('#active-epoch-readout').textContent.includes('pixels lack RGB coverage'));
    const partial=await pixels();
    assert.equal(partial[3],255);
    assert.equal(partial[0],partial[1]);
    assert.equal(partial[0],partial[2]);

    scenario='no-center';
    await page.goto('http://127.0.0.1:8081/?ra=1&dec=2');
    await page.waitForFunction(()=>document.querySelector('#sed-title').textContent.includes('Field mean'));
    assert.ok(await page.locator('#sed-svg circle').count()>0);
    assert.equal(await page.locator('[data-fft="low"]').isDisabled(),false);
    assert.equal(await page.locator('#fft-svg rect').count(),17);
    assert.equal(await page.locator('#fft-svg path:not(.domain)').count(),0);
    assert.equal(await page.locator('#fft-subtitle').textContent(),'|FFT| · period in wavelength space');

    scenario='uniform-spectrum';
    await page.goto('http://127.0.0.1:8081/?ra=1&dec=2');
    await page.waitForFunction(()=>!document.querySelector('[data-fft="low"]').disabled);
    for(const mode of ['low','mid','high']) {
      await page.locator(`[data-fft="${mode}"]`).click();
      assert.equal(await page.locator(`[data-fft="${mode}"]`).getAttribute('class'),'chip active');
      assert.equal(await page.locator('#sed-svg circle').count(),12);
    }

    await page.locator('#btn-play-pause').click();
    scenario='unavailable';
    await page.locator('#release-select').selectOption('spherex_dr1');
    await page.waitForFunction(()=>document.querySelector('#data-status').textContent.includes('Unable to contact'));
    assert.equal(await page.locator('.epoch-chip').count(),fixture.initial_sky.epochs.filter(ep=>ep.source==='spherex_dr1').length);
    const preserved=await pixels();
    assert.ok(preserved.some((v,i)=>i%4===3&&v>0));
    await page.locator('#release-select').selectOption('spherex_dr2');
    await page.waitForFunction(()=>document.querySelector('#data-status').textContent.includes('Unable to contact'));
    assert.ok((await pixels()).every((v,i)=>v===preserved[i]), 'release failure must preserve the visible cached observation');
    assert.ok(!(await page.locator('#data-status').innerText()).includes('503'));
    await page.locator('#btn-reload-releases').click();
    await page.waitForFunction(()=>document.querySelector('#data-status').textContent.includes('Release updates are temporarily unavailable'));

    scenario='normal';
    await page.locator('#release-select').selectOption('auto');
    await page.waitForFunction(()=>document.querySelector('#data-status').textContent.includes('observed cutouts'));
    const epochLabel=await page.locator('#active-epoch-readout').textContent();
    await page.locator('#btn-play-pause').click();
    await page.waitForFunction(label=>document.querySelector('#active-epoch-readout').textContent!==label,epochLabel);

    scenario='empty';
    await page.goto('http://127.0.0.1:8081/?ra=1&dec=2');
    await page.waitForFunction(()=>document.querySelector('#data-status').textContent.includes('No observations'));
    assert.equal(await page.locator('#empty-view').isVisible(),true);
    assert.equal(await page.locator('[data-fft="low"]').isDisabled(),true);
    assert.ok((await page.locator('#sed-svg').textContent()).includes('No valid measurements'));
    assert.ok((await page.locator('#timeline-svg').textContent()).includes('Dates appear'));
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: HUD, FOV races, custom FOV, zoom, overlays, pixel inversion, hidden dots and working brush, missing RGB, field brightness fallback, spectral filters, release failure recovery, empty states, URL reload.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
