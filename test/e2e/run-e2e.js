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
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH;
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
  for (const item of [
    'manifest.json',
    'popup',
    'content',
    'background',
    'data',
    'vendor',
    'icons',
    'shared',
  ]) {
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

/**
 * 把一組測試包起來：整組丟例外時記錄失敗並「繼續下一組」，
 * 不讓一個例外中止後面所有測試（各組自帶頁面/popup、彼此獨立）。
 */
async function runStep(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`✗ STEP ERROR [${name}]: ${e && e.message ? e.message : e}`);
    results.push({ name: `${name}（整組例外中止）`, ok: false });
  }
}

/** 關掉任何殘留的 popup 分頁（前一組若中途例外，popup 可能沒關）*/
async function closeStalePopups(browser) {
  for (const t of browser.targets()) {
    if (t.url().includes('/popup/popup.html')) {
      const pg = await t.page().catch(() => null);
      if (pg) await pg.close().catch(() => {});
    }
  }
}

async function openPopup(browser, sw) {
  await sw.evaluate(() => chrome.action.openPopup());
  const target = await browser.waitForTarget((t) => t.url().includes('/popup/popup.html'), {
    timeout: 10000,
  });
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

  // CI（GitHub Actions runner 以 root 執行、無 user namespace）下 Chromium 需 --no-sandbox
  // 才能啟動；本機以真 Chrome 執行時維持沙箱，不降低安全性。
  const launchArgs = ['--no-first-run', '--no-default-browser-check', '--window-size=1400,900'];
  if (process.env.CI) launchArgs.push('--no-sandbox');

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: false,
    defaultViewport: null,
    pipe: true,
    enableExtensions: true,
    args: launchArgs,
  });

  try {
    const extId = await browser.installExtension(EXT);
    console.log('EXT ID:', extId);
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes(extId),
      { timeout: 15000 },
    );
    const sw = await swTarget.worker();

    const page = (await browser.pages())[0];
    await page.goto(`http://127.0.0.1:${PORT}/fixture.html`, { waitUntil: 'load' });
    await page.bringToFront();

    await runStep('A 掃描結果／篩選／匯出／高亮', async () => {
      await closeStalePopups(browser);
      // ===== T1：初始狀態只顯示一個 view（[hidden] 修正驗證）=====
      const popup = await openPopup(browser, sw);
      const vis = await popup.evaluate(() =>
        ['view-initial', 'view-loading', 'view-results', 'view-error'].map((id) => ({
          id,
          display: getComputedStyle(document.getElementById(id)).display,
        })),
      );
      const visible = vis.filter((v) => v.display !== 'none').map((v) => v.id);
      check(
        'T1 只顯示單一狀態（hidden 修正）',
        visible.length === 1 && visible[0] === 'view-initial',
        visible.join(','),
      );
      await popup.screenshot({ path: OUT + '/popup-initial.png' });

      // ===== T2：執行掃描 =====
      await popup.click('#btn-scan');
      await popup.waitForSelector('#view-results:not([hidden])', { timeout: 60000 });
      await sleep(300);
      const stats = await popup.$eval('#stats', (el) => el.innerText.replace(/\s+/g, ' '));
      console.log('STATS:', stats);
      const headings = await popup.$$eval('.group-heading', (els) => els.map((e) => e.textContent));
      const titles = await popup.$$eval('.issue-title', (els) =>
        els.map((e) => e.textContent.trim()),
      );
      check('T2 掃描完成並顯示結果', headings.length > 0, headings.length + ' 個分組');

      // ===== T3：對應表規則以繁中顯示、分組正確 =====
      const expectedZh = [
        '圖片缺少替代文字',
        '網頁缺少標題',
        '未標示網頁語言',
        '表單欄位缺少標籤',
        '連結沒有可辨識文字',
        '按鈕沒有可辨識名稱',
        '標題階層順序錯亂',
        '清單結構不正確',
        'iframe 缺少標題',
        'ARIA 缺少必要屬性',
        'ARIA 屬性值無效',
        '出現重複的 id',
        '文字與背景對比不足',
      ];
      const missing = expectedZh.filter((t) => !titles.includes(t));
      check(
        'T3 對應表規則以繁中顯示',
        missing.length === 0,
        missing.length ? '缺: ' + missing.join(',') : `${titles.length} 項全繁中`,
      );
      check(
        'T3b 等級 A/AA 分組存在',
        headings.some((h) => h.includes('等級 A（')) && headings.some((h) => h.includes('等級 AA')),
      );
      check(
        'T3c 需人工複核分組存在',
        headings.some((h) => h.includes('需人工複核')),
      );
      check('T3d link-in-text-block 有出現', titles.includes('連結僅以顏色區辨'));
      check('T3e target-size 對應 2.5.8 有出現', titles.includes('可點擊目標尺寸不足'));

      // ===== T13：NVDA 報讀預覽（名稱＋角色，用詞取自 NVDA 官方 zh_TW）=====
      // 節點內容即使在收合的 issue-body 中仍存在於 DOM，可直接查詢。
      const nvdaLines = await popup.$$eval('.nvda-line', (els) =>
        els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()),
      );
      const anyLine = (kw) => nvdaLines.some((l) => l.includes(kw));
      // 有算出預覽（若 axe.commons API 路徑錯誤，nvdaPreview 會回 null，這裡會是 0 行）
      check('T13 NVDA 報讀預覽有渲染', nvdaLines.length > 0, nvdaLines.length + ' 行');
      // 無名元素以「（無可朗讀名稱）」呈現（button-name / link-name / image-alt / label）
      check('T13a 無名元素標示無可朗讀名稱', anyLine('無可朗讀名稱'));
      // 各角色用詞正確（按鈕 / 連結 / 圖片 / 編輯 / 核取方塊）
      check('T13b 角色「按鈕」正確', anyLine('按鈕'));
      check('T13c 角色「連結」正確', anyLine('連結'));
      check('T13d 角色「圖片」正確', anyLine('圖片'));
      check('T13e 角色「編輯」正確', anyLine('編輯'));
      check('T13f 角色「核取方塊」正確', anyLine('核取方塊'));
      // 有名稱者念出名稱＋角色（fixture 第 14 區 aria-label 的迷你按鈕）
      check(
        'T13g 具名元素念出名稱＋角色',
        nvdaLines.some((l) => l.includes('關閉') && l.includes('按鈕')),
        nvdaLines.find((l) => l.includes('關閉')) || '(無)',
      );

      // ===== T10：目標等級篩選（預設 AA；切到 A 後 AA 項目應移入「超出目標等級」）=====
      await popup.select('#level-select', 'A');
      await sleep(300);
      const h10 = await popup.$$eval('.group-heading', (els) => els.map((e) => e.textContent));
      check(
        'T10 目標等級篩選',
        h10.some((h) => h.includes('超出目標等級 A（')) &&
          !h10.some((h) => h.startsWith('等級 AA')),
        JSON.stringify(h10),
      );
      await popup.select('#level-select', 'AA');
      await sleep(300);

      // ===== T11：結果篩選 chips（複核 → 只剩需人工複核分組）=====
      await popup.click('.chip[data-filter="review"]');
      await sleep(300);
      const h11 = await popup.$$eval('.group-heading', (els) => els.map((e) => e.textContent));
      check(
        'T11 結果篩選（複核）',
        h11.some((h) => h.includes('需人工複核')) && !h11.some((h) => h.startsWith('等級 A（')),
        JSON.stringify(h11),
      );
      await popup.click('.chip[data-filter="all"]');
      await sleep(300);
      await popup.screenshot({ path: OUT + '/popup-results.png' });

      // ===== T9：匯出報告（攔截 blob 內容驗證）=====
      // 直接 hook URL.createObjectURL 擷取報告 HTML，避開 headless:false 下 OS blob
      // 下載時序不穩的 flakiness——仍走真實的 exportReport→buildReportHtml→blob 路徑。
      await popup.evaluate(() => {
        window.__reportHtml = null;
        const orig = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
          try {
            blob.text().then((t) => {
              window.__reportHtml = t;
            });
          } catch (e) {
            /* 忽略 */
          }
          return orig(blob);
        };
      });
      await popup.click('#btn-export');
      let reportHtml = '';
      for (let i = 0; i < 20 && !reportHtml; i++) {
        await sleep(300);
        reportHtml = await popup.evaluate(() => window.__reportHtml || '');
      }
      const reportOk =
        reportHtml.includes('Ramp 無障礙檢測報告') &&
        reportHtml.includes('等級 A') &&
        reportHtml.includes('限制聲明') &&
        reportHtml.includes('對比值(最小)') && // 官方準則名稱有進報告
        reportHtml.includes('HM1240200C') && // 官方檢測碼有進報告（document-title）
        reportHtml.includes('人工複核自評'); // 自評摘要與狀態有進報告
      check(
        'T9 匯出報告產生且內容正確',
        reportOk,
        reportHtml ? '已擷取報告 HTML' : '未擷取到 blob',
      );

      // ===== T4：展開＋點擊元素 → 頁面高亮 =====
      await popup.click('.issue-header');
      await sleep(200);
      await popup.click('.node-btn');
      await sleep(700);
      const hl1 = await page.evaluate(
        () => document.querySelectorAll('.ramp-a11y-highlight').length,
      );
      check('T4 點擊元素在頁面高亮', hl1 === 1, 'highlight=' + hl1);

      // ===== T5：再次點擊清除高亮 =====
      await popup.click('.node-btn.active');
      await sleep(500);
      const hl2 = await page.evaluate(
        () => document.querySelectorAll('.ramp-a11y-highlight').length,
      );
      check('T5 再次點擊清除高亮', hl2 === 0, 'highlight=' + hl2);
      await popup.close();
    });

    await runStep('B 快取還原與自評持久化', async () => {
      await closeStalePopups(browser);
      // ===== T6：關閉 popup 重開 → 快取還原（沿用 A 組的掃描與 session 快取）=====
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
        cacheState.resultsShown &&
          !cacheState.noteHidden &&
          cacheState.noteText.includes('上次檢測'),
        cacheState.noteText.slice(0, 40),
      );
      await popup2.screenshot({ path: OUT + '/popup-cache.png' });

      // ===== T12（前半）：在快取還原的 popup 中設定人工複核自評 =====
      await popup2.select('.review-select', 'pass');
      await sleep(300);

      // T6b：還原後高亮仍可用
      await popup2.click('.issue-header');
      await sleep(200);
      await popup2.click('.node-btn');
      await sleep(700);
      const hl3 = await page.evaluate(
        () => document.querySelectorAll('.ramp-a11y-highlight').length,
      );
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
      const hl4 = await page.evaluate(
        () => document.querySelectorAll('.ramp-a11y-highlight').length,
      );
      check('T7 頁面重整後高亮自動補注入', hl4 === 1, 'highlight=' + hl4);

      // ===== T12（後半）：自評狀態跨 popup 開關與頁面重整仍保存 =====
      const rv = await popup3.$eval('.review-select', (el) => el.value);
      check('T12 人工複核自評持久化', rv === 'pass', 'value=' + rv);
      await popup3.close();
    });

    await runStep('C 朗讀順序線性化', async () => {
      // ===== T14：朗讀順序線性化＋視覺順序落差偵測 =====
      await page.goto(`http://127.0.0.1:${PORT}/reading-order-fixture.html`, { waitUntil: 'load' });
      await page.addScriptTag({ path: path.join(REPO, 'vendor/axe.min.js') });
      await page.addScriptTag({ path: path.join(REPO, 'vendor/axe-locale-zh_TW.js') });
      await page.addScriptTag({ path: path.join(REPO, 'content/scanner.js') });
      const ro = await page.evaluate(() => window.__rampA11yReadingOrder());
      check(
        'T14 朗讀順序線性化',
        ro.total >= 10 && /標題第 1/.test(ro.stops[0].role || ''),
        ro.total + ' 個停點',
      );
      // 行內連結應插在段落文字中間（前後皆為文字停點）
      const linkIdx = ro.stops.findIndex((s) => s.kind === 'object' && s.name === '行內連結');
      check(
        'T14a 行內連結插在文字中間',
        linkIdx > 0 &&
          ro.stops[linkIdx - 1].kind === 'text' &&
          (ro.stops[linkIdx + 1] || {}).kind === 'text',
        'idx=' + linkIdx,
      );
      // aria-hidden 段不得出現在朗讀順序中
      check(
        'T14b aria-hidden 段排除',
        !ro.stops.some((s) => (s.text || '').includes('aria-hidden 隱藏')),
      );
      // flex order 造成的同列反序 → 兩段標為落差
      const flagged = ro.stops.filter((s) => s.flagged);
      check(
        'T14c 視覺順序落差偵測',
        ro.flaggedCount === 2 &&
          flagged.length === 2 &&
          flagged.every((s) => (s.text || '').includes('DOM 第')),
        'flaggedCount=' + ro.flaggedCount,
      );
      // 清單邊界（NVDA 進入清單念「清單 有 N 項」）與清單項目位置「N 之 M」
      check(
        'T14d 清單邊界',
        ro.stops.some(
          (s) => s.kind === 'list' && s.boundary === 'enter' && s.text === '清單 有 2 項',
        ),
        JSON.stringify(ro.stops.filter((s) => s.kind === 'list').map((s) => s.text)),
      );
      const li1 = ro.stops.find((s) => (s.text || '') === '清單項目一');
      check('T14e 清單項目位置', li1 && li1.position === '2 之 1', li1 && li1.position);
    });

    await runStep('D NVDA 值／表格／地標', async () => {
      // ===== T15：NVDA 報讀預覽的值／位置／項目數／描述／進階狀態 =====
      await page.goto(`http://127.0.0.1:${PORT}/nvda-fixture.html`, { waitUntil: 'load' });
      await page.addScriptTag({ path: path.join(REPO, 'vendor/axe.min.js') });
      await page.addScriptTag({ path: path.join(REPO, 'vendor/axe-locale-zh_TW.js') });
      await page.addScriptTag({ path: path.join(REPO, 'content/scanner.js') });
      const nv = await page.evaluate(() => window.__rampA11yReadingOrder());
      const objs = nv.stops.filter((s) => s.kind === 'object');
      const find = (pred) => objs.find(pred) || {};
      const slider = find((s) => s.role === '滑桿');
      const prog = find((s) => s.role === '進度列');
      const city = find((s) => s.name === '城市');
      const acc = find((s) => s.value === 'user123');
      const hobby = find((s) => s.itemCount);
      const tab = find((s) => s.position);
      const more = find((s) => s.name === '更多');
      const note = find((s) => (s.states || []).includes('多行'));
      check('T15 滑桿值', slider.value === '30', 'value=' + slider.value);
      check('T15a 進度列值（真 NVDA 念原始值）', prog.value === '75', 'value=' + prog.value);
      check('T15b 下拉選中項', city.value === '台中', 'value=' + city.value);
      check(
        'T15c 編輯區描述',
        acc.description === '請輸入 6 到 12 個英數字',
        'desc=' + acc.description,
      );
      // 經真 NVDA 驗證：listbox 不念項目數；真清單（ul）以邊界「清單 有 N 項」呈現
      check(
        'T15d listbox 不誤報項目數',
        hobby === undefined || hobby.itemCount == null,
        'hobby.itemCount=' + (hobby && hobby.itemCount),
      );
      check(
        'T15d2 真清單邊界含項目數',
        nv.stops.some(
          (s) => s.kind === 'list' && s.boundary === 'enter' && s.text === '清單 有 3 項',
        ),
        JSON.stringify(nv.stops.filter((s) => s.kind === 'list').map((s) => s.text)),
      );
      check('T15e 集合位置', tab.position === '5 之 2', 'pos=' + tab.position);
      check(
        'T15f 子功能表＋折疊狀態',
        (more.states || []).includes('子功能表') && (more.states || []).includes('折疊'),
        JSON.stringify(more.states),
      );
      check('T15g 多行狀態', note.name === '備註', 'name=' + note.name);

      // ===== T16：表格座標、欄/列標題、表格維度 =====
      const stops = nv.stops;
      const tblEnter = stops.find((s) => s.kind === 'table' && s.boundary === 'enter');
      check(
        'T16 表格維度（列先欄後，真 NVDA 語序）',
        tblEnter && tblEnter.text === '表格有 3 列 2 欄',
        tblEnter && tblEnter.text,
      );
      const cell = stops.find((s) => (s.text || '') === '1000');
      check('T16a 儲存格座標', cell && cell.position === '第 2 列 第 2 欄', cell && cell.position);
      check(
        'T16b 儲存格欄/列標題',
        cell && cell.description === '金額・一月',
        cell && cell.description,
      );
      check(
        'T16c 表格離開邊界',
        stops.some((s) => s.kind === 'table' && s.boundary === 'exit' && s.text === '離開表格'),
      );

      // ===== T17：地標進入‧離開邊界 =====
      const navEnter = stops.find(
        (s) => s.kind === 'landmark' && s.boundary === 'enter' && /導覽區/.test(s.text || ''),
      );
      check(
        'T17 導覽地標（含 aria-label＋地標後綴）',
        navEnter && navEnter.text === '主要選單 導覽區 地標',
        navEnter && navEnter.text,
      );
      check(
        'T17a 主要內容地標',
        stops.some(
          (s) => s.kind === 'landmark' && s.boundary === 'enter' && s.text === '主要內容區 地標',
        ),
      );
      check(
        'T17b 地標離開邊界',
        stops.some(
          (s) => s.kind === 'landmark' && s.boundary === 'exit' && s.text === '離開導覽區',
        ),
      );
    });

    await runStep('E 動態播報', async () => {
      // ===== T18：動態播報監看（即時區域 aria-live / role=alert）=====
      await page.goto(`http://127.0.0.1:${PORT}/live-fixture.html`, { waitUntil: 'load' });
      await page.addScriptTag({ path: path.join(REPO, 'content/scanner.js') });
      const liveOn = await page.evaluate(() => window.__rampA11yLiveStart());
      await page.click('#save');
      await sleep(250);
      await page.click('#submit');
      await sleep(250);
      const live = await page.evaluate(() => window.__rampA11yLiveGet());
      const saved = live.log.find((e) => e.text === '已儲存變更');
      const alertMsg = live.log.find((e) => e.text === '密碼長度不足');
      check('T18 動態播報監看啟動', liveOn === true && live.on === true);
      check(
        'T18a polite 儲存提示',
        saved && saved.politeness === 'polite',
        saved && saved.politeness,
      );
      check(
        'T18b assertive 警示（role=alert）',
        alertMsg && alertMsg.politeness === 'assertive',
        alertMsg && alertMsg.politeness,
      );
    });

    await runStep('F XSS 逸出', async () => {
      // ===== T19：XSS — 頁面惡意字串不得注入 popup（逸出防呆迴歸）=====
      await page.goto(`http://127.0.0.1:${PORT}/xss-fixture.html`, { waitUntil: 'load' });
      await page.bringToFront(); // 開 popup 前確保視窗為前景（chrome.action.openPopup 需要）
      await closeStalePopups(browser);
      const popupX = await openPopup(browser, sw);
      await popupX.click('#btn-scan');
      await popupX.waitForSelector('#view-results:not([hidden])', { timeout: 60000 });
      await sleep(300);
      // 展開所有問題，讓 node.html 進入 DOM（scan 渲染路徑）
      await popupX.$$eval('.issue-header', (els) =>
        els.forEach((h) => {
          h.setAttribute('aria-expanded', 'true');
          if (h.nextElementSibling) h.nextElementSibling.hidden = false;
        }),
      );
      await sleep(150);
      // 切到朗讀順序，讓 name/value/text 進入 DOM（reading 渲染路徑）
      await popupX.click('.mode-tab[data-mode="reading"]');
      await popupX.waitForSelector('.ro-item', { timeout: 15000 });
      await sleep(300);
      const xss = await popupX.evaluate(() => ({
        injected: document.querySelectorAll('[data-xss]').length, // 任何被注入的惡意元素
        popupFlag: !!window.__xss, // popup 端是否被觸發
        escapedShown: /<svg|<b |<img|<script/.test(document.body.innerText), // 惡意字串以文字逸出顯示
      }));
      const pageFlag = await page.evaluate(() => !!window.__xss);
      check('T19 XSS：popup 無注入元素', xss.injected === 0, 'injected=' + xss.injected);
      check('T19a XSS：未觸發腳本（popup／page）', !xss.popupFlag && !pageFlag);
      check('T19b XSS：惡意字串以文字逸出顯示', xss.escapedShown);
      await popupX.close();
    });

    await runStep('G 受保護頁面', async () => {
      // ===== T8：受保護頁面 → 開啟即顯示無法檢測 =====
      await page.goto('chrome://version/');
      await page.bringToFront();
      await closeStalePopups(browser);
      const popup4 = await openPopup(browser, sw);
      const errState = await popup4.evaluate(() => ({
        errShown: getComputedStyle(document.getElementById('view-error')).display !== 'none',
        initShown: getComputedStyle(document.getElementById('view-initial')).display !== 'none',
        title: document.getElementById('error-title').textContent,
      }));
      check(
        'T8 受保護頁面預先顯示無法檢測',
        errState.errShown && !errState.initShown && errState.title.includes('無法檢測'),
        errState.title,
      );
      await popup4.screenshot({ path: OUT + '/popup-restricted.png' });
    });
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
