/**
 * 動態播報（即時區域）的真 NVDA 對照（需互動桌面；不進 CI）
 *
 * compare.js 只會逐行讀靜態頁面；即時區域要「頁面發生變動」才會播報，所以另寫這支：
 * 在 test/nvda-live-fixture.html 上依序製造幾種變動，同時記錄
 *   (A) 真 NVDA 實際念了什麼（guidepup spokenPhraseLog）
 *   (B) 我們的監看器（content/scanner.js 的 __rampA11yLive*）抓到什麼
 * 兩者並排，判定每個情境的模擬是否忠實。
 *
 * 用法：npm run test:nvda:live（前置同 compare.js：npx @guidepup/setup install nvda）
 * 以 Chrome --app 模式開頁（沒有網址列，焦點只會在頁面上——理由見 compare.js）。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const cp = require('child_process');
const { nvda } = require('@guidepup/guidepup');
const puppeteer = require('puppeteer-core');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 18987;
const URL = `http://127.0.0.1:${PORT}/nvda-live-fixture.html`;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每個情境：在頁面裡做什麼、預期 NVDA 是否播報、要找的文字
const CASES = [
  {
    name: '既有 polite 區域（role=status）內容變動',
    expectSpoken: true,
    text: '已儲存',
    run: () => {
      document.getElementById('polite').textContent = '已儲存';
    },
  },
  {
    name: '插入整個 role=alert 節點',
    expectSpoken: true,
    text: '表單有錯誤',
    run: () => {
      const d = document.createElement('div');
      d.setAttribute('role', 'alert');
      d.textContent = '表單有錯誤';
      document.getElementById('host').appendChild(d);
    },
  },
  {
    name: '插入「包著 role=alert」的外層容器',
    expectSpoken: true,
    text: '巢狀錯誤訊息',
    run: () => {
      const w = document.createElement('div');
      w.innerHTML = '<div role="alert">巢狀錯誤訊息</div>';
      document.getElementById('host').appendChild(w);
    },
  },
  {
    name: '插入「已帶文字」的新 polite 區域（role=status）',
    expectSpoken: false,
    text: '新狀態列文字',
    run: () => {
      const d = document.createElement('div');
      d.setAttribute('role', 'status');
      d.textContent = '新狀態列文字';
      document.getElementById('host').appendChild(d);
    },
  },
  {
    name: 'aria-live 值無效（aria-live=""）的區域內容變動',
    expectSpoken: false,
    text: '無效區域文字',
    run: () => {
      document.getElementById('invalid').textContent = '無效區域文字';
    },
  },
  {
    name: '插入整個 aria-live="assertive" 節點（非 alert 角色）',
    expectSpoken: null, // 未知：一般認知只有 alert 角色插入即播，交給真 NVDA 決定
    text: '緊急區域文字',
    run: () => {
      const d = document.createElement('div');
      d.setAttribute('aria-live', 'assertive');
      d.textContent = '緊急區域文字';
      document.getElementById('host').appendChild(d);
    },
  },
  {
    name: 'role=alert 插進「既有」的 polite 區域（念幾次？）',
    expectSpoken: true,
    text: '區域內的警告',
    run: () => {
      const d = document.createElement('div');
      d.setAttribute('role', 'alert');
      d.textContent = '區域內的警告';
      document.getElementById('polite').appendChild(d);
    },
  },
  {
    name: '插入 display:none 的 role=alert（隱藏的 toast 模板）',
    expectSpoken: false,
    text: '隱藏的警告',
    run: () => {
      const d = document.createElement('div');
      d.setAttribute('role', 'alert');
      d.style.display = 'none';
      d.textContent = '隱藏的警告';
      document.getElementById('host').appendChild(d);
    },
  },
  {
    name: '插入帶 hidden 屬性的 role=alert',
    expectSpoken: false,
    text: '屬性隱藏的警告',
    run: () => {
      const d = document.createElement('div');
      d.setAttribute('role', 'alert');
      d.hidden = true;
      d.textContent = '屬性隱藏的警告';
      document.getElementById('host').appendChild(d);
    },
  },
];

(async () => {
  if (!CHROME) throw new Error('找不到 Chrome');
  const server = http
    .createServer((req, res) => {
      const p = path.join(REPO, 'test', req.url.replace(/^\//, ''));
      fs.readFile(p, (e, d) => {
        if (e) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d);
      });
    })
    .listen(PORT);

  try {
    cp.execSync('taskkill /IM nvda.exe /F', { stdio: 'ignore' });
  } catch (e) {
    /* 沒有殘留的 NVDA */
  }
  await sleep(800);
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    pipe: true,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--window-position=100,100',
      '--window-size=1000,800',
      '--force-renderer-accessibility',
      `--app=${URL}`,
    ],
  });
  let pg = null;
  for (let i = 0; i < 50 && !pg; i++) {
    pg = (await b.pages()).find((p) => p.url() === URL) || null;
    if (!pg) await sleep(100);
  }
  if (!pg) throw new Error('app 視窗沒有開出測試頁');
  await pg.waitForFunction(() => document.readyState === 'complete');
  // 我們的監看器與真 NVDA 看同一批變動
  await pg.addScriptTag({ path: path.join(REPO, 'content/scanner.js') });
  await pg.evaluate(() => window.__rampA11yLiveStart());

  console.log('NVDA 啟動中…');
  await nvda.start();
  await sleep(2500);
  try {
    cp.execSync('taskkill /IM SystemSettings.exe /F', { stdio: 'ignore' });
  } catch (e) {
    /* 沒有彈出設定 */
  }
  await pg.bringToFront();
  await sleep(1500);
  await nvda.press('Control+Home'); // 讓 NVDA 進入本頁的瀏覽模式
  await sleep(1500);
  console.log('探測句：', ((await nvda.lastSpokenPhrase()) || '').trim() || '（無）');
  await nvda.press('Tab'); // 焦點移到「觸發」鈕（頁面上唯一可聚焦的元素）
  await sleep(1200);

  const rows = [];
  for (const c of CASES) {
    // 把本情境的變動掛到觸發鈕上，再以真鍵盤（經 NVDA 的 OS 層按鍵）按下——
    // 實測由計時器或 CDP 直接改 DOM 時 NVDA 不一定播報，使用者操作觸發才是真實情境
    await pg.evaluate((src) => {
      window.__runCase = new Function(`(${src})()`);
    }, c.run.toString());
    await nvda.clearSpokenPhraseLog();
    const before = (await pg.evaluate(() => window.__rampA11yLiveGet().log.length)) || 0;
    await nvda.press('Enter');
    await sleep(2500);
    const phrases = await nvda.spokenPhraseLog();
    const entries = (await pg.evaluate(() => window.__rampA11yLiveGet().log)).slice(before);
    // 比「念了幾次」而不只是「有沒有念」——重複記錄（同一則記成兩筆）也是不忠實
    const nvdaCount = phrases.filter((p) => p.includes(c.text)).length;
    const ourCount = entries.filter((e) => e.text.includes(c.text)).length;
    rows.push({
      c,
      spoken: phrases.join(' ／ '),
      ours: entries.map((e) => `${e.text}（${e.politeness}）`).join(' ／ '),
      nvdaCount,
      ourCount,
    });
  }

  await nvda.stop();
  await b.close();
  server.close();

  console.log('\n' + '═'.repeat(80));
  let mismatch = 0;
  for (const { c, spoken, ours, nvdaCount, ourCount } of rows) {
    const faithful = nvdaCount === ourCount;
    const asExpected = c.expectSpoken === null || nvdaCount > 0 === c.expectSpoken;
    if (!faithful) mismatch++;
    console.log(`${faithful ? '✅' : '❌'} ${c.name}`);
    console.log(
      `   真 NVDA：念 ${nvdaCount} 次${asExpected ? '' : '（與預設假設不同！）'}　「${spoken || '—'}」`,
    );
    console.log(`   我們的監看器：記 ${ourCount} 筆　「${ours || '—'}」`);
  }
  console.log('═'.repeat(80));
  console.log(mismatch ? `⚠ ${mismatch} 個情境模擬與真 NVDA 不一致` : '全部情境與真 NVDA 一致');
  // 探測句偶爾為空但後續情境照常播報，不能單憑它判斷；全部情境都沒聲音才是沒讀到本頁
  if (rows.every((r) => !r.spoken)) {
    console.log('⚠ 所有情境 NVDA 都沒有出聲：可能沒讀到本頁，結果不可信，請重跑');
  }
  fs.writeFileSync(
    path.join(__dirname, 'last-live-run.json'),
    JSON.stringify(
      rows.map((r) => ({ case: r.c.name, nvda: r.spoken, ours: r.ours })),
      null,
      2,
    ),
  );
  process.exit(mismatch ? 1 : 0);
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(2);
});
