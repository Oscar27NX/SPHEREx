const assert=require('node:assert/strict');
const {chromium}=require('../.cache/browser/node_modules/playwright');

(async()=>{
  const browser=await chromium.launch({headless:true,
    executablePath:process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  let release;
  const complete=new Promise(resolve=>{release=resolve;});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const origin=process.env.VIEWER_URL || 'http://127.0.0.1:8081';
    const boot=await(await context.request.get(`${origin}/api/state`)).json();
    const preview=boot.initial_sky;
    const params=new URLSearchParams({ra:preview.ra,dec:preview.dec,fov:preview.fov,window:preview.window,release:'auto',sampling:'rgb'});
    const expanded=await(await context.request.get(`${origin}/api/sky?${params}`)).json();
    assert.equal(expanded.sampling,'rgb','Pre-cache the RGB presets before this test');
    assert.ok(expanded.epochs.length>preview.epochs.length);
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    let requests=0;
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/api/state') return route.fulfill({json:boot});
      if(url.pathname==='/api/batch') return route.fulfill({json:{results:[]}});
      if(url.searchParams.get('sampling')==='rgb') {
        if(requests++===0) return route.fulfill({json:{...preview,preview:true,refreshing:true,
          requested_sampling:'rgb',progress:{phase:'cutouts',completed:12,total:42}}});
        await complete;
        return route.fulfill({json:{...expanded,refreshing:false}});
      }
      return route.fulfill({json:preview});
    });
    await page.goto(origin);
    await page.waitForFunction(()=>document.querySelector('.epoch-chip.is-current'));
    await page.locator('[data-det="rgb"]').click();
    await page.waitForFunction(()=>document.querySelector('#retrieval-label').textContent.includes('Loading more RGB observations'));
    assert.equal(await page.locator('#retrieval-progress').isVisible(),true);
    const current=await page.locator('.epoch-chip.is-current').getAttribute('data-idx');
    await page.waitForFunction(index=>document.querySelector('.epoch-chip.is-current')?.dataset.idx!==index,current);
    await page.locator('#btn-play-pause').click();
    const selection=await page.locator('#timeline-svg .selection').boundingBox();
    const handle=await page.locator('#timeline-svg .handle--e').boundingBox();
    await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
    await page.mouse.down();await page.mouse.move(selection.x+selection.width*.65,handle.y+handle.height/2,{steps:6});await page.mouse.up();
    const subtitle=await page.locator('#time-subtitle').textContent();
    const skip=page.locator('.epoch-chip.in-window').first();
    const skipped=preview.epochs[Number(await skip.getAttribute('data-idx'))];
    await skip.click();await skip.click();
    await page.locator('#viewport-stage').hover();await page.mouse.wheel(0,-100);
    await page.waitForFunction(()=>!document.querySelector('#stat-zoom').textContent.includes('1.0x'));
    const zoom=await page.locator('#stat-zoom').textContent();
    await page.screenshot({path:'.cache/rgb-background-loading.png'});
    release();
    await page.waitForFunction(count=>document.querySelectorAll('.epoch-chip').length===count,expanded.epochs.length);
    assert.equal(await page.locator('#time-subtitle').textContent(),subtitle);
    assert.equal(await page.locator('#stat-zoom').textContent(),zoom);
    assert.equal(await page.locator('#btn-play-pause').textContent(),'Play');
    assert.equal(await page.locator('#retrieval-progress').isVisible(),false);
    const skippedIndex=expanded.epochs.findIndex(ep=>ep.mjd===skipped.mjd && ep.source===skipped.source
      && JSON.stringify(ep.detectors)===JSON.stringify(skipped.detectors));
    assert.ok(skippedIndex>=0);
    assert.equal(await page.locator(`.epoch-chip[data-idx="${skippedIndex}"] .epoch-op`).textContent(),'.');
    await page.locator('.epoch-chip').last().click();
    assert.equal(await page.locator('.epoch-chip').last().locator('.epoch-op').textContent(),'-');
    const count=Number((await page.locator('#active-epoch-readout').textContent()).match(/^RGB \d+\/(\d+)/)?.[1]);
    assert.ok(count>2,'The narrowed brush should contain additional RGB combinations');
    const held=await page.locator('.epoch-chip.is-current').getAttribute('data-idx');
    await page.locator('#btn-play-pause').click();
    await page.waitForFunction(index=>document.querySelector('.epoch-chip.is-current')?.dataset.idx!==index,held);
    assert.deepEqual(errors,[]);
    console.log(`Background RGB checks passed: playable preview, progress, preserved brush/skips/zoom/pause, accessible first/last epoch controls, ${count} combinations inside the narrowed brush, resumed playback.`);
  } finally {release();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
