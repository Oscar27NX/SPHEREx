const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('../.cache/browser/node_modules/playwright');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const fixture=JSON.parse(fs.readFileSync('.cache/browser-fixture.json','utf8'));
    const base=fixture.initial_sky;
    base.sources.push({id:'test-gaia',name:'Motion reference',kind:'Gaia DR3',ra:base.ra,dec:base.dec,px:32,py:32,reference_epoch:2016,gaia:{pmra:1000,pmdec:-2000},wise:null});
    base.sources.push({id:'test-wise',name:'Alignment reference',kind:'AllWISE',ra:base.ra,dec:base.dec+.01,px:32,py:24.32,wise:{},gaia:null});
    let loading=false,polls=0;
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/api/state') return route.fulfill({json:fixture});
      if(url.pathname==='/api/batch') return route.fulfill({json:{results:[]}});
      const sky=structuredClone(base);
      for(const key of ['ra','dec','fov','window']) sky[key]=Number(url.searchParams.get(key));
      sky.pixel_scale_arcsec=sky.fov/sky.grid_size;
      sky.release={id:'auto'};sky.refreshing=false;
      if(loading) {
        polls++;
        sky.epochs=[];sky.sources=[];sky.measurements=[];
        for(const key of ['frames_b64','flags_b64','wavelength_maps_b64','bandwidth_maps_b64']) sky[key]='';
        sky.data_status=polls<3 ? 'loading' : 'empty';
        sky.refreshing=polls<3;
        sky.message=polls<3 ? 'Retrieving observations' : 'No data found for this field';
        sky.progress={phase:'cutouts',completed:polls-1,total:3,elapsed_seconds:polls*2};
      }
      await route.fulfill({json:sky});
    });
    await page.goto(`http://127.0.0.1:8081/?ra=${base.ra}&dec=${base.dec}&gaia=1&wise=1`);
    await page.waitForFunction(()=>document.querySelector('.epoch-chip.is-current'));
    const current=()=>page.locator('.epoch-chip.is-current').getAttribute('data-idx');
    await page.locator('[data-det="rgb"]').click();
    assert.equal(new URL(page.url()).searchParams.get('mode'),'blink');
    const cursorX=await page.locator('.timeline-cursor').getAttribute('x1');
    await page.waitForFunction(old=>document.querySelector('.timeline-cursor').getAttribute('x1')!==old,cursorX);
    let idx=await current();
    await page.waitForFunction(old=>document.querySelector('.epoch-chip.is-current')?.dataset.idx!==old,idx);
    await page.locator('[data-det="all"]').click();
    idx=await current();
    await page.waitForFunction(old=>document.querySelector('.epoch-chip.is-current')?.dataset.idx!==old,idx);
    await page.locator('#btn-go-coords').click();
    idx=await current();
    await page.waitForFunction(old=>document.querySelector('.epoch-chip.is-current')?.dataset.idx!==old,idx);

    const moving=page.locator('[data-source-id="test-gaia"]');
    const x=await moving.getAttribute('cx');
    await page.waitForFunction(old=>document.querySelector('[data-source-id="test-gaia"]').getAttribute('cx')!==old,x);
    await page.locator('#btn-play-pause').click();
    const wise=page.locator('[data-source-id="test-wise"]');
    const before=await wise.evaluate(el=>({px:el.__data__.px,py:el.__data__.py}));
    await page.locator('[data-fov="600"]').click();
    await page.waitForFunction(()=>document.querySelector('#stat-fov').textContent.includes('600'));
    const after=await wise.evaluate(el=>({px:el.__data__.px,py:el.__data__.py}));
    assert.ok(Math.abs((before.py-32)/2-(after.py-32))<1e-7);
    await page.locator('#viewport-stage').hover();
    await page.mouse.wheel(0,-100);
    await page.waitForTimeout(80);
    const scales=await page.evaluate(()=>[document.querySelector('#sky-canvas'),document.querySelector('#sky-overlay-svg')].map(el=>({width:el.getBoundingClientRect().width,parent:el.parentElement.id})));
    assert.equal(scales[0].width,scales[1].width);
    assert.equal(scales[0].parent,'zoom-frame');
    assert.equal(scales[1].parent,'zoom-frame');
    for(const mode of ['coadd','diff','blink']) {
      await page.locator(`[data-mode="${mode}"]`).click();
      assert.deepEqual(await wise.evaluate(el=>({px:el.__data__.px,py:el.__data__.py})),after);
    }
    const selection=await page.locator('#timeline-svg .selection').boundingBox();
    const handle=await page.locator('#timeline-svg .handle--e').boundingBox();
    await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
    await page.mouse.down();await page.mouse.move(selection.x+selection.width*.4,handle.y+handle.height/2,{steps:6});await page.mouse.up();
    assert.ok(await page.locator('.epoch-chip.out-window').count()>0);
    assert.deepEqual(await wise.evaluate(el=>({px:el.__data__.px,py:el.__data__.py})),after);

    const imageBefore=await page.locator('#sky-canvas').evaluate(c=>c.toDataURL());
    const overlayBefore=await moving.getAttribute('cx');
    await page.locator('#btn-fft-demo').click();
    assert.ok((await page.locator('#sed-title').textContent()).includes('synthetic'));
    assert.equal(await page.locator('#fft-svg rect').count(),25);
    for(const mode of ['low','mid','high']) {
      await page.locator(`[data-fft="${mode}"]`).click();
      assert.equal(await page.locator('#sed-svg circle').count(),48);
      assert.equal(await page.locator('#sky-canvas').evaluate(c=>c.toDataURL()),imageBefore);
      assert.equal(await moving.getAttribute('cx'),overlayBefore);
    }
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#btn-fft-demo').getAttribute('aria-pressed')==='true');
    await page.locator('#btn-fft-demo').click();
    assert.equal(await page.locator('[data-fft="low"]').isDisabled(),true);

    loading=true;
    await page.locator('#btn-random').click();
    await page.waitForFunction(()=>!document.querySelector('#retrieval-progress').classList.contains('hidden'));
    await page.waitForFunction(()=>document.querySelector('#retrieval-label').textContent.includes('images checked'));
    assert.equal(await page.locator('#viewport-stage').getAttribute('aria-busy'),'true');
    await page.waitForFunction(()=>document.querySelector('#data-status').textContent.includes('No data found'));
    assert.equal(await page.locator('#retrieval-progress').isVisible(),false);
    assert.equal(await page.locator('#empty-view').isVisible(),true);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:'.cache/sprint-empty-state.png'});
    console.log('Sprint checks passed: RGB playback and later queries, Gaia epoch motion, WISE FOV/zoom/mode/brush alignment, spectrum-only FFT demo and share URL, random-field progress to empty result.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
