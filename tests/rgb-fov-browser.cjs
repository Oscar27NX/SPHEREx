const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('../.cache/browser/node_modules/playwright');

(async()=>{
  const browser=await chromium.launch({headless:true,
    executablePath:process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],timings=[];
    page.on('pageerror',error=>errors.push(error.message));
    const boot=page.waitForResponse(r=>r.url().endsWith('/api/state'));
    const batch=page.waitForResponse(r=>r.url().endsWith('/api/batch'));
    await page.goto(process.env.VIEWER_URL || 'http://127.0.0.1:8081');
    const config=(await(await boot).json()).config;
    await(await batch).finished();
    await page.waitForFunction(()=>document.querySelector('.epoch-chip.is-current'));
    await page.locator('#btn-play-pause').click();
    for(const [index,target] of config.preset_targets.entries()) {
      const ready=page.waitForResponse(async response=>{
        const url=new URL(response.url());
        if(url.pathname!=='/api/sky' || url.searchParams.get('sampling')!=='rgb'
          || Math.abs(Number(url.searchParams.get('ra'))-target.ra)>.00001) return false;
        const sky=await response.json();
        return sky.sampling==='rgb' && !sky.preview && !sky.refreshing;
      });
      await page.locator('#preset-select').selectOption(String(index));
      if(index===0) await page.locator('[data-det="rgb"]').click();
      const sky=await(await ready).json();
      assert.ok(sky.epochs.length>12,'Pre-cache the expanded RGB observations');
      await page.waitForFunction(n=>document.querySelectorAll('.epoch-chip').length===n,sky.epochs.length);
      for(const fov of [150,600,300]) {
        const result=await page.evaluate(fov=>new Promise(resolve=>{
          const start=performance.now();document.querySelector(`[data-fov="${fov}"]`).click();
          const count=document.querySelectorAll('.epoch-chip').length;
          requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({fov,count,ms:performance.now()-start,
            after:document.querySelectorAll('.epoch-chip').length})));
        }),fov);
        assert.equal(result.count,sky.epochs.length,'RGB observations disappeared during the FOV change');
        assert.equal(result.after,sky.epochs.length,'The server preview replaced the longer RGB animation');
        timings.push({target:target.name,...result});
      }
    }
    assert.deepEqual(errors,[]);
    const report={measuredAt:new Date().toISOString(),timings,errors,maxMs:Math.max(...timings.map(t=>t.ms))};
    fs.writeFileSync('.cache/rgb-fov-report.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
    assert.ok(report.maxMs<100,`RGB FOV exceeded the 100 ms budget: ${report.maxMs} ms`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
