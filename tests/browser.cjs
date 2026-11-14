const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('../.cache/browser/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({headless: true,
    executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const fixture = JSON.parse(fs.readFileSync('.cache/browser-fixture.json', 'utf8'));
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let body;
      if (url.pathname === '/api/state') body = fixture;
      else if (url.pathname === '/api/batch') body = {results: []};
      else {
        requests.push(url.toString());
        const sky = structuredClone(fixture.initial_sky);
        for (const key of ['ra', 'dec', 'fov', 'window']) sky[key] = Number(url.searchParams.get(key));
        sky.release.id = url.searchParams.get('release');
        sky.cache = 'HIT'; sky.refreshing = false;
        body = sky;
        if (sky.fov === 150) await new Promise(resolve => setTimeout(resolve, 150));
      }
      await route.fulfill({json: body});
    });
    await page.goto('http://127.0.0.1:8081/?ra=269.446259&dec=4.768324&fov=450');
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
    await page.locator('#tog-wise').click();
    assert.ok(await page.locator('.wise-layer path').count() > 0);
    await page.locator('[data-mode="coadd"]').click();
    await page.locator('[data-det="rgb"]').click();
    await page.locator('#tog-invert').click();
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#stat-fov').textContent.includes('450'));
    assert.equal(new URL(page.url()).searchParams.get('det'), 'rgb');
    assert.equal(new URL(page.url()).searchParams.get('invert'), '1');
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: HUD, URL FOV, rapid FOV changes, custom FOV, zoom, overlays, RGB, inversion, reload.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
