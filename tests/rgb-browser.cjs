const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('../.cache/browser/node_modules/playwright');

(async()=>{
  const browser=await chromium.launch({headless:true,
    executablePath:process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[],targets=[];
    page.on('pageerror',e=>errors.push(e.message));
    const boot=page.waitForResponse(r=>r.url().endsWith('/api/state'));
    const batch=page.waitForResponse(r=>r.url().endsWith('/api/batch'));
    await page.goto(process.env.VIEWER_URL || 'http://127.0.0.1:8081');
    const config=(await(await boot).json()).config;
    await(await batch).finished();
    await page.waitForFunction(()=>document.querySelector('.epoch-chip.is-current'));
    await page.locator('#btn-play-pause').click();
    await page.locator('#btn-speed').click();await page.locator('#btn-speed').click();
    await page.locator('[data-det="rgb"]').click();
    for(const [index,target] of config.preset_targets.entries()) {
      await page.locator('#preset-select').selectOption(String(index));
      await page.waitForFunction(ra=>Math.abs(Number(new URL(location.href).searchParams.get('ra'))-ra)<.00001,target.ra);
      assert.equal(new URL(page.url()).searchParams.get('mode'),'blink');
      await page.locator('#btn-play-pause').click();
      const cycle=await page.evaluate(()=>new Promise((resolve,reject)=>{
        const total=document.querySelectorAll('.epoch-chip.in-window').length;
        const frames=new Map(),images=new Set(),start=performance.now();
        const timer=setInterval(()=>{
          const chip=document.querySelector('.epoch-chip.is-current');
          if(chip && !frames.has(chip.dataset.idx)) {
            const canvas=document.querySelector('#sky-canvas'),data=canvas.getContext('2d').getImageData(0,0,64,64).data;
            let visible=0,color=0;
            for(let p=0;p<data.length;p+=4) if(data[p+3]) {
              visible++;
              if(Math.max(data[p],data[p+1],data[p+2])-Math.min(data[p],data[p+1],data[p+2])>2) color++;
            }
            frames.set(chip.dataset.idx,{visible,color,label:document.querySelector('#active-epoch-readout').textContent});
            images.add(canvas.toDataURL());
          }
          if(frames.size===total){clearInterval(timer);resolve({frames:[...frames.values()],distinctImages:images.size});}
          else if(performance.now()-start>6000){clearInterval(timer);reject(Error('RGB playback did not complete a cycle'));}
        },15);
      }));
      await page.locator('#btn-play-pause').click();
      assert.ok(cycle.frames.every(f=>f.color>0),`${target.name}: grayscale frame despite RGB coverage`);
      assert.ok(cycle.frames.every(f=>f.label.includes('non-simultaneous')),`${target.name}: missing provenance label`);
      assert.ok(cycle.distinctImages>1,`${target.name}: RGB image did not change across the cycle`);
      targets.push({target:target.name,frames:cycle.frames.length,distinctImages:cycle.distinctImages,
        minColoredPixels:Math.min(...cycle.frames.map(f=>f.color)),maxColoredPixels:Math.max(...cycle.frames.map(f=>f.color))});
    }
    await page.screenshot({path:'.cache/rgb-after.png'});
    assert.deepEqual(errors,[]);
    const report={measuredAt:new Date().toISOString(),method:'real API and cached observations; color means channel spread >2/255; full playback cycle per target',targets,errors};
    fs.writeFileSync('.cache/rgb-after.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
