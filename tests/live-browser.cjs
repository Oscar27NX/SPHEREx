const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('../.cache/browser/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({headless:true,
    executablePath:process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[], targets=[], timings=[];
    page.on('pageerror', error=>errors.push(error.message));
    const bootResponse=page.waitForResponse(r=>r.url().endsWith('/api/state'));
    const batchResponse=page.waitForResponse(r=>r.url().endsWith('/api/batch'));
    await page.goto(process.env.VIEWER_URL || 'http://127.0.0.1:8081');
    const boot=await (await bootResponse).json();
    await (await batchResponse).finished();
    await page.waitForFunction(()=>document.querySelector('#data-status').textContent.includes('observed cutouts'));
    await page.locator('#btn-play-pause').click();
    for (const [index,target] of boot.config.preset_targets.entries()) {
      await page.locator('#preset-select').selectOption(String(index));
      await page.waitForFunction(ra=>Math.abs(Number(new URL(location.href).searchParams.get('ra'))-ra)<.00001,target.ra);
      const summary={name:target.name,brightnessPoints:await page.locator('#sed-svg circle').count(),
        brightnessTitle:await page.locator('#sed-title').textContent(),
        opaquePixels:await page.locator('#sky-canvas').evaluate(c=>{
          const pixels=c.getContext('2d').getImageData(0,0,64,64).data;
          return Array.from(pixels).filter((v,i)=>i%4===3 && v>0).length;
        })};
      assert.ok(summary.opaquePixels>0,`${target.name}: missing image`);
      assert.ok(summary.brightnessPoints>0,`${target.name}: missing measured brightness`);
      targets.push(summary);
      for (const fov of [150,600,1200,300]) {
        const result=await page.evaluate(fov=>new Promise(resolve=>{
          const start=performance.now();
          document.querySelector(`[data-fov="${fov}"]`).click();
          const synchronous=document.querySelector('#stat-fov').textContent.startsWith(`FOV ${fov}`);
          requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({synchronous,ms:performance.now()-start})));
        }),fov);
        assert.ok(result.synchronous,`${target.name}: FOV ${fov} waited for the server`);
        timings.push({target:target.name,fov,ms:Math.round(result.ms*10)/10});
      }
    }
    const rgbPlaybackTargets=[];
    await page.locator('[data-det="rgb"]').click();
    await page.locator('#btn-play-pause').click();
    for(const [index,target] of boot.config.preset_targets.entries()) {
      await page.locator('#preset-select').selectOption(String(index));
      await page.waitForFunction(ra=>Math.abs(Number(new URL(location.href).searchParams.get('ra'))-ra)<.00001,target.ra);
      assert.equal(new URL(page.url()).searchParams.get('mode'),'blink');
      const current=await page.locator('.epoch-chip.is-current').getAttribute('data-idx');
      await page.waitForFunction(idx=>document.querySelector('.epoch-chip.is-current')?.dataset.idx!==idx,current);
      rgbPlaybackTargets.push(target.name);
    }
    await page.locator('#btn-play-pause').click();
    await page.screenshot({path:'.cache/latency-preview.png'});
    await page.locator('#btn-fft-demo').click();
    assert.equal(await page.locator('#fft-svg rect').count(),25);
    await page.screenshot({path:'.cache/fft-demo.png'});
    assert.deepEqual(errors,[]);
    const report={measuredAt:new Date().toISOString(),method:'DOM click to second animation frame, real cached observations, no API mocks',
      errors,targets,timings,rgbPlaybackTargets,maxMs:Math.max(...timings.map(t=>t.ms))};
    fs.writeFileSync('.cache/latency-report.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
    assert.ok(report.maxMs<100,`cached FOV preview exceeded the 100 ms budget: ${report.maxMs} ms`);
  } finally {
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
