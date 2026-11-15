const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('../.cache/browser/node_modules/playwright');

(async () => {
  const baseline = process.argv.includes('--baseline');
  const browser = await chromium.launch({headless:true,
    executablePath:process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[], targets=[];
    page.on('pageerror',e=>errors.push(e.message));
    const boot=page.waitForResponse(r=>r.url().endsWith('/api/state'));
    const batch=page.waitForResponse(r=>r.url().endsWith('/api/batch'));
    await page.goto(process.env.VIEWER_URL || 'http://127.0.0.1:8081');
    const config=(await(await boot).json()).config;
    await(await batch).finished();
    await page.waitForFunction(()=>document.querySelector('.epoch-chip.is-current'));
    await page.locator('#btn-play-pause').click();
    await page.locator('#btn-speed').click();await page.locator('#btn-speed').click();
    for(const [index,target] of config.preset_targets.entries()) {
      await page.locator('#preset-select').selectOption(String(index));
      await page.waitForFunction(ra=>Math.abs(Number(new URL(location.href).searchParams.get('ra'))-ra)<.00001,target.ra);
      const result={target:target.name};
      for(const detector of ['all','rgb']) {
        const ready=page.waitForResponse(async response=>{
          const url=new URL(response.url());
          if(url.pathname!=='/api/sky' || Math.abs(Number(url.searchParams.get('ra'))-target.ra)>.00001
            || url.searchParams.get('sampling')!==(detector==='rgb'?'rgb':'preview')) return false;
          const sky=await response.json();
          return !sky.preview && !sky.refreshing && (sky.sampling || 'preview')===(detector==='rgb'?'rgb':'preview');
        },{timeout:180000});
        await page.locator(`[data-det="${detector}"]`).click();
        if(detector==='all' && index===0) await page.locator('#preset-select').selectOption(String(index));
        const sky=await(await ready).json();
        await page.waitForFunction(count=>document.querySelectorAll('.epoch-chip').length===count,sky.epochs.length);
        await page.locator('#btn-play-pause').click();
        result[detector]=await page.evaluate(()=>new Promise((resolve,reject)=>{
          const frames=[],start=performance.now();let last=null;
          const timer=setInterval(()=>{
            const index=document.querySelector('.epoch-chip.is-current')?.dataset.idx;
            if(index!==undefined && index!==last) {
              const canvas=document.querySelector('#sky-canvas');
              frames.push({index,time:performance.now(),image:canvas.toDataURL(),pixels:canvas.getContext('2d').getImageData(0,0,64,64).data});
              last=index;
            }
            if(frames.length===25) {
              clearInterval(timer);
              let changed=0,maxHold=1,hold=1,difference=0,valid=0;
              const changes=[];
              for(let i=1;i<frames.length;i++) {
                const a=frames[i-1],b=frames[i];
                if(a.image!==b.image){changed++;hold=1;changes.push(b.time);}
                else maxHold=Math.max(maxHold,++hold);
                for(let p=0;p<a.pixels.length;p+=4) if(a.pixels[p+3] && b.pixels[p+3]) {
                  for(let c=0;c<3;c++){difference+=Math.abs(a.pixels[p+c]-b.pixels[p+c]);valid++;}
                }
              }
              const intervals=changes.slice(1).map((v,i)=>v-changes[i]);
              resolve({ticks:24,changed,unchanged:24-changed,distinctImages:new Set(frames.map(f=>f.image)).size,
                maxRepeatedFrames:maxHold,meanPixelDifference:Number((difference/Math.max(1,valid)).toFixed(3)),
                meanImageChangeMs:intervals.length?Number((intervals.reduce((a,b)=>a+b,0)/intervals.length).toFixed(1)):null});
            } else if(performance.now()-start>7000) {clearInterval(timer);reject(Error('Playback did not advance through 24 ticks'));}
          },10);
        }));
        await page.locator('#btn-play-pause').click();
        if(!baseline) assert.equal(result[detector].unchanged,0,`${target.name}: redundant ${detector} frames`);
      }
      targets.push(result);
    }
    assert.deepEqual(errors,[]);
    const report={measuredAt:new Date().toISOString(),baseline,method:'real local API, 24 transitions per mode per target at 120 ms; pixel differences are display variation, not proper motion',targets,errors};
    fs.writeFileSync(`.cache/rgb-motion-${baseline?'before':'after'}.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
