const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const DIR = '/workspace/screenshots-battle-arena-2026-11-28-live';
(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const b = await puppeteer.launch({ headless: 'new', protocolTimeout: 300000,
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    args: ['--no-sandbox','--disable-setuid-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader-webgl','--disable-dev-shm-usage'] });
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await p.goto('https://territory-war-online-production.up.railway.app/?q=low', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { ok = await p.evaluate(() => !!window.BA); } catch (e) {} if (!ok) await new Promise(r => setTimeout(r, 1000)); }
  await new Promise(r => setTimeout(r, 1500));
  const st = await p.evaluate(() => ({
    unlocked: window.BA.solo().unlocked,
    btnClass: document.getElementById('startBtn').className,
    classCards: document.querySelectorAll('.class-card').length,
    classPanel: !!document.querySelector('.class-panel'),
    redeemVisible: !!document.getElementById('redeemCode'),
    codeInPage: /2012/.test(document.body.innerText),
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200)
  }));
  console.log('상태', JSON.stringify(st, null, 0));
  await p.screenshot({ path: DIR + '/10-live-home-minimal.png' });
  /* 코드 입력 후 해금 상태도 */
  await p.evaluate(() => { const i = document.getElementById('redeemCode'); i.value = '2012'; document.getElementById('redeemApply').click(); });
  await new Promise(r => setTimeout(r, 900));
  console.log('해금', JSON.stringify(await p.evaluate(() => ({ unlocked: window.BA.solo().unlocked, stored: localStorage.getItem('ba.soloUnlocked.v1') }))));
  await p.screenshot({ path: DIR + '/11-live-home-unlocked.png' });
  await b.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
