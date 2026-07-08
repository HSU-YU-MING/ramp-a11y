/**
 * ramp-a11y 端對端迴歸測試
 *
 * 用法：npm test（需先 npm install，且本機裝有 Chrome）
 * 可用環境變數 CHROME_PATH 指定 Chrome 執行檔位置。
 *
 * 運作方式：
 *  1. 將擴充套件複製到暫存資料夾，並在 manifest 加上 <all_urls>。
 *     原因：測試以 chrome.action.openPopup() 程式化開啟 popup，這不是
 *     使用者手勢，Chrome 不會核發 activeTab 授權；正式版 manifest 僅有
 *     activeTab，在此環境下讀不到分頁網址。加 <all_urls> 只影響測試副本。
 *     （真實的 activeTab 授權流程只能由真人點擊工具列圖示驗證。）
 *  2. 以本機 http 伺服器供應 test/fixture.html（避開 file:// 存取權設定）。
 *  3. 啟動獨立 Chrome（Chrome 137+ 已移除 --load-extension，
 *     改用 Puppeteer 的 installExtension API）跑 12 項驗證。
 *
 * 截圖輸出於 test/e2e/output/（已列入 .gitignore）。
 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'output');
const PORT = 18923;

// ===== Chrome 位置偵測 =====
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('找不到 Chrome，請以環境變數 CHROME_PATH 指定');
  return found;
}

// ===== 建立測試副本（加 <all_urls>）=====
function buildTestExtension() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ramp-a11y-e2e-'));
  for (const item of ['manifest.json', 'popup', 'content', 'background', 'data', 'vendor', 'icons']) {
    fs.cpSync(path.join(REPO, item), path.join(dest, item), { recursive: true });
  }
  const mfPath = path.join(dest, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.host_permissions = ['<all_urls>']; // 僅測試副本，理由見檔頭註解
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
  return dest;
}

// ===== 測試結果收集 =====
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPopup(browser, sw) {
  await sw.evaluate(() => chrome.action.openPopup());
  const target = await browser.waitForTarget((t) => t.url().includes('/popup/popup.html'), { timeout: 10000 });
  let page = await target.page();
  if (!page) page = await target.asPage();
  page.on('pageerror', (e) => console.log('POPUP PAGE ERROR:', e.message));
  await sleep(800); // 等 initPopup（快取還原/受保護頁面檢查）跑完
  return page;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const EXT = buildTestExtension();

  const server = http
    .createServer((req, res) => {
      const p = path.join(REPO, 'test', req.url === '/' ? 'fixture.html' : req.url);
      fs.readFile(p, (e, d) => {
        if (e) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d);
      });
    })
    .listen(PORT);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: false,
    defaultViewport: null,
    pipe: true,
    enableExtensions: true,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1400,900'],
  });

  try {
    const extId = await browser.installExtension(EXT);
    console.log('EXT ID:', extId);
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes(extId),
      { timeout: 15000 }
    );
    const sw = await swTarget.worker();

    const page = (await browser.pages())[0];
    await page.goto(`http://127.0.0.1:${PORT}/fixture.html`, { waitUntil: 'load' });
    await page.bringToFront();

    // ===== T1：初始狀態只顯示一個 view（[hidden] 修正驗證）=====
    const popup = await openPopup(browser, sw);
    const vis = await popup.evaluate(() =>
      ['view-initial', 'view-loading', 'view-results', 'view-error'].map((id) => ({
        id,
        display: getComputedStyle(document.getElementById(id)).display,
      }))
    );
    const visible = vis.filter((v) => v.display !== 'none').map((v) => v.id);
    check('T1 只顯示單一狀態（hidden 修正）', visible.length === 1 && visible[0] === 'view-initial', visible.join(','));
    await popup.screenshot({ path: OUT + '/popup-initial.png' });

    // ===== T2：執行掃描 =====
    await popup.click('#btn-scan');
    await popup.waitForSelector('#view-results:not([hidden])', { timeout: 60000 });
    await sleep(300);
    const stats = await popup.$eval('#stats', (el) => el.innerText.replace(/\s+/g, ' '));
    console.log('STATS:', stats);
    const headings = await popup.$$eval('.group-heading', (els) => els.map((e) => e.textContent));
    const titles = await popup.$$eval('.issue-title', (els) => els.map((e) => e.textContent.trim()));
    check('T2 掃描完成並顯示結果', headings.length > 0, headings.length + ' 個分組');

    // ===== T3：對應表規則以繁中顯示、分組正確 =====
    const expectedZh = [
      '圖片缺少替代文字', '網頁缺少標題', '未標示網頁語言', '表單欄位缺少標籤',
      '連結沒有可辨識文字', '按鈕沒有可辨識名稱', '標題階層順序錯亂', '清單結構不正確',
      'iframe 缺少標題', 'ARIA 缺少必要屬性', 'ARIA 屬性值無效', '出現重複的 id',
      '文字與背景對比不足',
    ];
    const missing = expectedZh.filter((t) => !titles.includes(t));
    check('T3 對應表規則以繁中顯示', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : `${titles.length} 項全繁中`);
    check('T3b 等級 A/AA 分組存在', headings.some((h) => h.includes('等級 A（')) && headings.some((h) => h.includes('等級 AA')));
    check('T3c 需人工複核分組存在', headings.some((h) => h.includes('需人工複核')));
    check('T3d link-in-text-block 有出現', titles.includes('連結僅以顏色區辨'));
    check('T3e target-size 對應 2.5.8 有出現', titles.includes('可點擊目標尺寸不足'));
    await popup.screenshot({ path: OUT + '/popup-results.png' });

    // ===== T9：匯出報告（攔截下載並驗證內容）=====
    const dlClient = await popup.target().createCDPSession();
    await dlClient.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: OUT, eventsEnabled: true,
    });
    // 只認本次新產生的報告檔，避免上次執行的殘留檔造成誤判
    const isReport = (f) => f.startsWith('ramp-a11y-report-') && f.endsWith('.html');
    const before = new Set(fs.readdirSync(OUT).filter(isReport));
    await popup.click('#btn-export');
    await sleep(1500);
    const reportFile = fs.readdirSync(OUT).filter(isReport).find((f) => !before.has(f));
    let reportOk = false;
    if (reportFile) {
      const html = fs.readFileSync(path.join(OUT, reportFile), 'utf8');
      reportOk =
        html.includes('Ramp 無障礙檢測報告') &&
        html.includes('等級 A') &&
        html.includes('限制聲明') &&
        html.includes('對比值(最小)'); // 官方準則名稱有進報告
    }
    check('T9 匯出報告產生且內容正確', reportOk, reportFile || '無新下載檔案');

    // ===== T4：展開＋點擊元素 → 頁面高亮 =====
    await popup.click('.issue-header');
    await sleep(200);
    await popup.click('.node-btn');
    await sleep(700);
    const hl1 = await page.evaluate(() => document.querySelectorAll('.ramp-a11y-highlight').length);
    check('T4 點擊元素在頁面高亮', hl1 === 1, 'highlight=' + hl1);

    // ===== T5：再次點擊清除高亮 =====
    await popup.click('.node-btn.active');
    await sleep(500);
    const hl2 = await page.evaluate(() => document.querySelectorAll('.ramp-a11y-highlight').length);
    check('T5 再次點擊清除高亮', hl2 === 0, 'highlight=' + hl2);

    // ===== T6：關閉 popup 重開 → 快取還原 =====
    await popup.close();
    await sleep(300);
    await page.bringToFront();
    const popup2 = await openPopup(browser, sw);
    const cacheState = await popup2.evaluate(() => ({
      resultsShown: getComputedStyle(document.getElementById('view-results')).display !== 'none',
      noteHidden: document.getElementById('cache-note').hidden,
      noteText: document.getElementById('cache-note').textContent,
    }));
    check(
      'T6 快取還原與提示條',
      cacheState.resultsShown && !cacheState.noteHidden && cacheState.noteText.includes('上次檢測'),
      cacheState.noteText.slice(0, 40)
    );
    await popup2.screenshot({ path: OUT + '/popup-cache.png' });

    // T6b：還原後高亮仍可用
    await popup2.click('.issue-header');
    await sleep(200);
    await popup2.click('.node-btn');
    await sleep(700);
    const hl3 = await page.evaluate(() => document.querySelectorAll('.ramp-a11y-highlight').length);
    check('T6b 快取還原後高亮可用', hl3 === 1, 'highlight=' + hl3);

    // ===== T7：頁面重整（isolated world 消失）→ 高亮自動補注入 =====
    await popup2.close();
    await page.reload({ waitUntil: 'load' });
    await page.bringToFront();
    const popup3 = await openPopup(browser, sw);
    await popup3.click('.issue-header');
    await sleep(200);
    await popup3.click('.node-btn');
    await sleep(1200);
    const hl4 = await page.evaluate(() => document.querySelectorAll('.ramp-a11y-highlight').length);
    check('T7 頁面重整後高亮自動補注入', hl4 === 1, 'highlight=' + hl4);
    await popup3.close();

    // ===== T8：受保護頁面 → 開啟即顯示無法檢測 =====
    await page.goto('chrome://version/');
    await page.bringToFront();
    const popup4 = await openPopup(browser, sw);
    const errState = await popup4.evaluate(() => ({
      errShown: getComputedStyle(document.getElementById('view-error')).display !== 'none',
      initShown: getComputedStyle(document.getElementById('view-initial')).display !== 'none',
      title: document.getElementById('error-title').textContent,
    }));
    check(
      'T8 受保護頁面預先顯示無法檢測',
      errState.errShown && !errState.initShown && errState.title.includes('無法檢測'),
      errState.title
    );
    await popup4.screenshot({ path: OUT + '/popup-restricted.png' });
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(EXT, { recursive: true, force: true });
  }

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n==== ${results.length - fails}/${results.length} PASS ====`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(2);
});
