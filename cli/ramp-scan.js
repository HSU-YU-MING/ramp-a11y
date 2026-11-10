#!/usr/bin/env node
/**
 * ramp-scan — 全站爬掃 CLI
 *
 * 三種模式：
 *   單頁    node cli/ramp-scan.js <url>                    （--depth 0，預設）
 *   全站爬掃 node cli/ramp-scan.js <url> --depth 2          （同源 BFS）
 *   URL 清單 node cli/ramp-scan.js --url-list inventory.csv （吃外部清單，可含語言別）
 *
 * 每一頁都以 headless Chrome 導覽、注入 repo 內真正的 vendor/axe.min.js、
 * vendor/axe-locale-zh_TW.js 與 content/scanner.js，呼叫 window.__rampA11yScan()
 * （與擴充套件 popup 相同路徑），再用 data/rules-map.json 轉譯為台灣規範。
 *
 * PolyMigrate 橋接：--url-list 相容 PolyMigrate 的 url_inventory.csv
 * （欄位 source_url,lang,…）。當清單帶 lang 欄時，額外輸出「逐語言」a11y 彙整，
 * 讓已用 PolyMigrate 遷移過的多語站，能對中/英各語言版本分別檢視無障礙狀況。
 *
 * 規則→台灣準則對應核心與 popup 共用 shared/report-core.js（resolveMapping），不各持一份。
 */
'use strict';

const { parseArgs } = require('node:util');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { AXE_VERSION, escapeHtml, resolveMapping, nvdaParts } = require('../shared/report-core.js');
const { MANUAL_CHECKS, manualChecksForLevel } = require('../shared/manual-checks.js');
const {
  parseCookieFile,
  parseHeaders,
  isLogoutUrl,
  originOf,
  authMethods,
  authLine,
} = require('./auth.js');

const REPO = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// page.evaluate 沒有 Puppeteer 逾時；掃描/腳本卡住會拖死整個爬蟲，故自行加逾時。
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 逾時（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 以最多 concurrency 個並行對 items 逐一套用 fn(item, index)，結果依輸入順序回傳。
// 用於固定清單（scanList）；爬蟲的動態佇列另用內嵌的動態池。
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  const n = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length || 1));
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// ===== 參數解析 =====
function parseCliArgs(argv) {
  // 不認得的旗標、旗標缺值會讓 parseArgs 丟例外——由呼叫端轉成參數錯誤（exit 1）
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      depth: { type: 'string', default: '0' },
      'max-pages': { type: 'string', default: '50' },
      concurrency: { type: 'string', default: '1' },
      delay: { type: 'string', default: '250' },
      include: { type: 'string' },
      exclude: { type: 'string' },
      'url-list': { type: 'string' },
      scope: { type: 'string' },
      'scope-exclude': { type: 'string' },
      cookies: { type: 'string' },
      header: { type: 'string', multiple: true },
      'user-data-dir': { type: 'string' },
      login: { type: 'boolean', default: false },
      'login-url': { type: 'string' },
      level: { type: 'string', default: 'AA' },
      'fail-on': { type: 'string', default: 'none' },
      out: { type: 'string', default: './ramp-report' },
      format: { type: 'string', default: 'json' },
      chrome: { type: 'string' },
      'no-sandbox': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '60000' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  return { values, url: positionals[0] };
}

const HELP = `ramp-scan — 全站爬掃 CLI

用法：
  node cli/ramp-scan.js <url>                     單頁掃描
  node cli/ramp-scan.js <url> --depth 2           同源全站爬掃
  node cli/ramp-scan.js --url-list <file>         掃描外部 URL 清單（相容 PolyMigrate 盤點）

爬取
  --depth <n>        爬取深度（預設 0＝僅起始頁）
  --max-pages <n>    頁數上限（預設 50）
  --concurrency <n>  並行掃描頁數（預設 1＝循序；提高可加速，但降低禮貌性）
  --delay <ms>       每次請求前間隔，禮貌用（預設 250；設 0 關閉）
  --include <regex>  只掃符合的 URL（爬掃模式的「起始頁」一律會掃，篩選套用在爬到的連結）
  --exclude <regex>  跳過符合的 URL（同上，起始頁不受此限）
  --url-list <file>  改掃清單中的 URL（.txt 每行一個，或 PolyMigrate url_inventory.csv）

局部掃描（每一頁都只掃這一塊）
  --scope <css>         只掃符合 CSS 選擇器的元素（如 "#main"、".modal"；對到幾個掃幾個）。
                        某一頁對不到任何元素 → 那一頁記為失敗（不會退回掃整頁）
  --scope-exclude <css> 從掃描範圍挖掉符合的元素（如 ".ad, #cookie-banner"）

登入後掃描（機關後台、會員頁；憑證的值不寫進報告、不印出來）
  --cookies <file>      匯入 cookie：DevTools／擴充功能匯出的 JSON，或 Netscape cookies.txt
  --header "名稱: 值"   自訂標頭（可重複，如 Authorization），只送給被掃網站自己的來源
  --user-data-dir <dir> 用這個 Chrome 設定檔（裡面已登入的工作階段直接沿用；沒有就建立）
  --login               先開一個看得見的 Chrome 讓你自己登入（驗證碼、自然人憑證都行），
                        回終端機按 Enter 後才開始掃；沒給 --user-data-dir 時用暫存設定檔、掃完刪除
  --login-url <url>     --login 開哪一頁（預設起始網址或清單第一筆）
  用了任何一種，爬掃與清單都會跳過看起來像登出的網址（logout、sign-out、登出…），免得把自己登出

輸出／執行
  --level <A|AA|AAA> 目標檢測等級（預設 AA）
  --fail-on <cond>   none｜violations（預設 none）：violations 時，掃出「--level 目標內、已對應
                     台灣準則」的違規即以離開碼 3 結束，供 CI 做門檻（超出目標等級、未對應
                     台灣準則、最佳實務建議都不算）
  --out <dir>        報告輸出目錄（預設 ./ramp-report）
  --format <fmt>     輸出格式 json｜html｜both（預設 json）
  --chrome <path>    指定 Chrome（等同 CHROME_PATH）
  --no-sandbox       以 --no-sandbox 啟動 Chrome（預設不關沙箱；容器/root 等跑不起來時才用；
                     環境變數 CI 為真值時自動附加，CI=false／0 不算）
  --timeout <ms>     單頁載入逾時（預設 60000）
  --quiet            只寫檔、不印摘要
  --help             顯示此說明

離開碼
  0  掃描完成（未觸發 --fail-on）
  1  參數錯誤（不認得的旗標、旗標缺值或值不合法、無效的 regex、--scope／--scope-exclude 不是
     有效的 CSS 選擇器、清單檔不存在或為空、
     起始網址或清單全部被 --include/--exclude 排除）
  2  掃描錯誤（單頁模式掃描失敗；多頁模式「全部」頁面都失敗。部分頁面失敗仍為 0，失敗數見報告）
  3  --fail-on 條件觸發
`;

// ===== Chrome 位置偵測（沿用 test/e2e/run-e2e.js 的邏輯）=====
function findChrome(override) {
  const candidates = [
    override,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('找不到 Chrome，請以 --chrome 或環境變數 CHROME_PATH 指定');
  return found;
}

// ===== URL 工具 =====
// normalizeUrl 移植自作者的雙語站爬蟲 phase1_crawl.py 的 norm()：
// 去 fragment、剝除 session/追蹤參數、去尾斜線，確保去重穩定。
const TRACKING_PREFIXES = ['phpsessid=', 'utm_', 'fbclid=', 'gclid='];
function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  u.hash = '';
  // 先正規化 pathname 的尾斜線（含有 query 的網址也才能正確去重）
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  if (u.search) {
    // 直接在原始 query 字串上逐段過濾，不經 URLSearchParams 重組——重序列化會改變原始
    // 編碼（%20→+ 等），剝掉追蹤參數時其餘參數也該原封不動
    const segs = u.search.slice(1).split('&');
    const kept = segs.filter(
      (s) => s && !TRACKING_PREFIXES.some((p) => s.toLowerCase().startsWith(p)),
    );
    if (kept.length !== segs.length) u.search = kept.length ? '?' + kept.join('&') : '';
  }
  return u.toString();
}

const ASSET_EXT = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.zip',
  '.css',
  '.js',
  '.mp3',
  '.mp4',
  '.woff',
  '.woff2',
];
function isAsset(url) {
  try {
    return ASSET_EXT.some((ext) => new URL(url).pathname.toLowerCase().endsWith(ext));
  } catch {
    return false;
  }
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
function makeFilter(includeRe, excludeRe) {
  const inc = includeRe ? new RegExp(includeRe) : null;
  const exc = excludeRe ? new RegExp(excludeRe) : null;
  return (url) => (!inc || inc.test(url)) && !(exc && exc.test(url));
}

// ===== rules-map 轉譯（對應核心 resolveMapping 來自共用 shared/report-core.js）=====
const rulesList = JSON.parse(fs.readFileSync(path.join(REPO, 'data/rules-map.json'), 'utf8'));
const rulesMap = new Map(
  (Array.isArray(rulesList) ? rulesList : Object.values(rulesList)).map((r) => [r.axeRuleId, r]),
);

// 共用對應核心（resolveMapping）＋ CLI 專屬的節點樣本資料
function translateRule(rule) {
  return {
    ...resolveMapping(rule, rulesMap),
    nodeCount: rule.nodeCount != null ? rule.nodeCount : rule.nodes.length,
    sampleTargets: rule.nodes.slice(0, 5).map((n) => n.target),
    sampleNvda: (rule.nodes.find((n) => n.nvda) || {}).nvda || null,
  };
}

function buildPageReport(url, finalUrl, title, scan) {
  const translatedV = scan.violations.map(translateRule);
  const violations = translatedV.filter((r) => !r.isBestPractice);
  const bestPractice = translatedV.filter((r) => r.isBestPractice);
  const incomplete = scan.incomplete.map(translateRule);

  const byLevel = { A: 0, AA: 0, AAA: 0, unmapped: 0 };
  let affected = 0;
  violations.forEach((v) => {
    if (v.mapped) byLevel[v.level] = (byLevel[v.level] || 0) + 1;
    else byLevel.unmapped += 1;
    affected += v.nodeCount;
  });

  return {
    url,
    finalUrl,
    title,
    summary: {
      violations: violations.length,
      affectedElements: affected,
      byLevel,
      bestPractice: bestPractice.length,
      needsManualReview: incomplete.length,
    },
    violations: violations.sort((a, b) => b.nodeCount - a.nodeCount),
    bestPractice,
    incomplete,
    // 局部掃描的範圍（整頁是 null）
    scope: scan.scope || null,
  };
}

/** 報告頁首的範圍說明（整頁回 null） */
function scopeLine(scope) {
  if (!scope || !(scope.include || scope.exclude)) return null;
  const parts = [];
  if (scope.include) parts.push(`只掃描 ${scope.include}`);
  if (scope.exclude) parts.push(`排除 ${scope.exclude}`);
  return `檢測範圍：${parts.join('、')}（範圍外的問題不在本報告）`;
}

/**
 * 115 年修正版新增、axe 無法判定的準則。報告一律帶全部，並標示是否在目標等級內；
 * 這些項目與 --fail-on 無關，不會改變離開碼。
 */
function manualChecksReport(targetLevel) {
  const shownIds = new Set(manualChecksForLevel(targetLevel).shown.map((c) => c.id));
  return MANUAL_CHECKS.map((c) => ({ ...c, withinTarget: shownIds.has(c.id) }));
}

// ===== 訪問單一頁面：載入 → 掃描 → 蒐集連結 =====
const INJECT = ['vendor/axe.min.js', 'vendor/axe-locale-zh_TW.js', 'content/scanner.js'];
async function visitPage(browser, url, opts) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      `Mozilla/5.0 (compatible; ramp-scan/${VERSION}; +https://github.com/HSU-YU-MING/ramp-a11y)`,
    );
    // 以 addScriptTag 注入 axe 會被嚴格 CSP（script-src 'self' 等）擋下，
    // 掃描失敗時只會看到「__rampA11yScan is not a function」這種無從排查的錯誤。
    // CLI 是使用者主動對目標做檢測，繞過 CSP 屬合理工具行為。代價：原本會被頁面 CSP
    // 擋下的頁面腳本在掃描工作階段裡也會執行，DOM 可能與真實使用者看到的略有不同
    //（SECURITY.md 已揭露）。
    await page.setBypassCSP(true);
    // 登入後掃描：cookie 綁網域（Chrome 自己決定送給誰）；自訂標頭只送被掃網站的來源，
    // 不跟著頁面上的第三方資源（CDN、分析、廣告）出去
    if (opts.cookies && opts.cookies.length) await page.setCookie(...opts.cookies);
    if (opts.headers && Object.keys(opts.headers).length) {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return;
        if (opts.headerOrigins && opts.headerOrigins.has(originOf(req.url()))) {
          req.continue({ headers: { ...req.headers(), ...opts.headers } });
        } else {
          req.continue();
        }
      });
    }
    await page.goto(url, { waitUntil: 'networkidle2', timeout: opts.timeout });
    const title = await page.title();
    for (const f of INJECT) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
    }
    const scan = await withTimeout(
      page.evaluate(async (o) => await window.__rampA11yScan(o), {
        include: opts.scope || '',
        exclude: opts.scopeExclude || '',
      }),
      opts.timeout,
      '掃描',
    );
    // 範圍對不到（或選擇器在這頁才出錯）：這一頁算失敗，不退回掃整頁假裝成功
    if (scan && scan.error) {
      throw new Error(
        scan.error === 'no-match'
          ? `這一頁找不到 --scope 指定的範圍「${scan.selector}」`
          : `「${scan.selector}」不是有效的 CSS 選擇器`,
      );
    }
    const links = await withTimeout(
      page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href)),
      opts.timeout,
      '連結蒐集',
    );
    return { report: buildPageReport(url, page.url(), title, scan), links };
  } finally {
    await page.close();
  }
}

// ===== 全站 BFS 爬取 =====
async function crawlSite(browser, startUrl, opts, log) {
  const startHost = hostOf(startUrl);
  const pass = opts.pass; // 參數階段已編譯（無效 regex 在啟動瀏覽器前就以參數錯誤擋下）
  const start = normalizeUrl(startUrl);
  const enqueued = new Set([start]); // 已排入佇列（含未取出者），保證每個 URL 只訪問一次
  const queue = [{ url: start, depth: 0 }];
  const pages = [];
  let failed = 0;
  let started = 0; // 已「開始訪問」的頁數 → 精確封頂在 maxPages（並行下也不超額）
  let active = 0; // 進行中的訪問數 → 判斷佇列暫空時是否還會有新連結進來

  async function worker() {
    // 佇列動態成長（訪問中才發現新連結），故用 started/active 協調並行結束時機
    while (true) {
      if (started >= opts.maxPages) return;
      const item = queue.shift();
      if (!item) {
        if (active === 0) return; // 佇列空且無人在跑 → 不會再有新工作
        await sleep(15); // 佇列暫空但有人在跑，可能補入連結 → 稍候再試
        continue;
      }
      started += 1;
      active += 1;
      const { url, depth } = item;
      try {
        if (opts.delay) await sleep(opts.delay);
        const { report, links } = await (opts.visit || visitPage)(browser, url, opts);
        report.depth = depth;
        report.ok = true;
        pages.push(report);
        log(`[${pages.length}] ${url} — 違規 ${report.summary.violations}`);
        if (depth < opts.depth) {
          for (const raw of links) {
            const n = normalizeUrl(raw);
            if (enqueued.has(n) || hostOf(n) !== startHost || isAsset(n) || !pass(n)) continue;
            enqueued.add(n);
            queue.push({ url: n, depth: depth + 1 });
          }
        }
      } catch (e) {
        pages.push({ url, depth, ok: false, error: e.message });
        failed += 1;
        log(`[x] ${url} — ${e.message}`);
      } finally {
        active -= 1;
      }
    }
  }

  const n = Math.max(1, Math.floor(opts.concurrency) || 1);
  await Promise.all(Array.from({ length: n }, worker));
  return { pages, failed, truncated: queue.length > 0 };
}

// ===== URL 清單解析（相容 PolyMigrate url_inventory.csv）=====

/** 切一行 CSV：支援雙引號欄（欄內可含逗號、"" 跳脫）。天真 split(',')
 *  會讓「任何欄含逗號」的整列靜默消失——PolyMigrate 盤點的 title 欄就常有。 */
function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/**
 * 解析 URL 清單。被略過的行數與格式誤判一律透過 warn 出聲——
 * 「靜默少掃幾頁」比報錯更糟（本專案反覆出現的失敗模式）。
 */
function parseUrlList(file, warn = () => {}) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  // 每格 trim 並去除包住的雙引號——真實盤點常見「source_url, lang」逗號後帶空白，
  // 若不 trim 會使 lang 欄對不到而讓逐語言功能靜默失效。
  const cell = (s) =>
    s == null
      ? ''
      : s
          .trim()
          .replace(/^"(.*)"$/, '$1')
          .trim();
  const looksCsv =
    file.toLowerCase().endsWith('.csv') || /(^|,)\s*"?source_url"?\s*(,|$)/i.test(lines[0]);
  const header = looksCsv ? splitCsvLine(lines[0]).map((h) => cell(h).toLowerCase()) : null;
  const hasHeader = looksCsv && header.includes('source_url');

  // 純清單路徑：.txt，或「存成 .csv 但沒有 source_url 表頭」的純 URL 清單
  // （後者過去會把第一行當表頭丟掉——純清單的第一筆就這樣靜默消失）。
  if (!hasHeader) {
    if (looksCsv) {
      warn(`--url-list：${file} 的表頭沒有 source_url 欄，整份當純 URL 清單處理`);
    }
    let skipped = 0;
    const entries = [];
    for (const l of lines) {
      const t = l.trim();
      if (t.startsWith('#')) continue;
      // .txt 的行尾註解（「網址 # 備註」）：URL 裡的 # 是 fragment 不會前接空白，
      // 所以只認「空白 + #」
      const u = looksCsv ? cell(splitCsvLine(t)[0]) : t.replace(/\s+#.*$/, '');
      if (/^https?:\/\//i.test(u)) entries.push({ url: u, lang: '' });
      else skipped++;
    }
    if (skipped) warn(`--url-list：${skipped} 行不是 http(s) 網址，已略過`);
    return entries;
  }

  // CSV 路徑：取 source_url 與 lang 欄
  const urlIdx = header.indexOf('source_url');
  const langIdx = header.indexOf('lang');
  let skipped = 0;
  const entries = [];
  for (const l of lines.slice(1)) {
    const c = splitCsvLine(l).map(cell);
    if (/^https?:\/\//i.test(c[urlIdx] || '')) {
      entries.push({ url: c[urlIdx], lang: langIdx >= 0 ? c[langIdx] || '' : '' });
    } else skipped++;
  }
  if (skipped) warn(`--url-list：${skipped} 筆的 source_url 不是 http(s) 網址，已略過`);
  return entries;
}

async function scanList(browser, entries, opts, log) {
  // 篩選與截斷分開算：truncated 只在「通過篩選的筆數超過 maxPages」時為真，
  // 否則被 --exclude 濾掉幾筆就會誤報「達上限截斷」
  const passed = entries.filter((e) => opts.pass(e.url));
  const targets = passed.slice(0, opts.maxPages);
  let failed = 0;
  let done = 0;
  // 固定清單 → 直接用 mapPool 並行；結果依清單順序回傳（可重現）
  const pages = await mapPool(targets, opts.concurrency, async ({ url, lang }) => {
    if (opts.delay) await sleep(opts.delay);
    try {
      const { report } = await (opts.visit || visitPage)(browser, normalizeUrl(url), opts);
      report.lang = lang || undefined;
      report.ok = true;
      log(
        `[${++done}/${targets.length}]${lang ? ` (${lang})` : ''} ${url} — 違規 ${report.summary.violations}`,
      );
      return report;
    } catch (e) {
      failed += 1;
      log(`[x] ${url} — ${e.message}`);
      return { url, lang: lang || undefined, ok: false, error: e.message };
    }
  });
  return { pages, failed, truncated: passed.length > targets.length };
}

// ===== 目標等級 =====
const LEVEL_ORDER = ['A', 'AA', 'AAA'];
// 依目標等級把 byLevel 拆成「目標內／超出目標」——不隱藏任何違規，只分組（與 popup 語意一致）
function targetSplit(byLevel, targetLevel) {
  const ti = LEVEL_ORDER.indexOf(targetLevel);
  let within = 0;
  let beyond = 0;
  LEVEL_ORDER.forEach((lv, i) => {
    if (i <= ti) within += byLevel[lv] || 0;
    else beyond += byLevel[lv] || 0;
  });
  return { within, beyond };
}

// ===== 離開碼與啟動參數的決策（純函式，test:cli 直接驗證；main 只負責套用）=====

/** --fail-on violations 是否觸發：只看「目標等級內、已對應台灣準則」的違規——
 *  --level A 的 CI 不該因為 AAA、未對應（如對應表沒收錄的 WCAG 2.2）或最佳實務而變紅 */
function failOnTriggered(byLevel, failOn, targetLevel) {
  return failOn === 'violations' && targetSplit(byLevel || {}, targetLevel).within > 0;
}

/** 單頁模式的離開碼（掃描失敗由 main 的 catch 給 2） */
function singlePageExitCode(summary, failOn, targetLevel) {
  return failOnTriggered(summary.byLevel, failOn, targetLevel) ? 3 : 0;
}

/** 多頁模式的離開碼：全部頁面失敗 → 2；觸發 --fail-on → 3；其餘（含部分失敗）→ 0 */
function multiPageExitCode(pages, failOn, targetLevel) {
  const ok = pages.filter((p) => p.ok !== false);
  if (pages.length > 0 && ok.length === 0) return 2;
  if (ok.some((p) => failOnTriggered(p.summary.byLevel, failOn, targetLevel))) return 3;
  return 0;
}

/** 環境變數是否為真值（CI=false／0／空字串不算——CI 平台以外的人也可能隨手設成 false） */
function isTruthyEnv(v) {
  return v != null && !/^(|0|false|no|off)$/i.test(String(v).trim());
}

/** Chrome 啟動參數：沙箱預設保留；--no-sandbox 旗標或 CI 環境才關（與 e2e 同慣例） */
function chromeLaunchArgs(noSandbox, env) {
  return ['--disable-dev-shm-usage', ...(noSandbox || isTruthyEnv(env.CI) ? ['--no-sandbox'] : [])];
}

// ===== 彙整 =====
function aggregate(pages) {
  const ok = pages.filter((p) => p.ok !== false);
  const byLevel = { A: 0, AA: 0, AAA: 0, unmapped: 0 };
  // axeId -> 完整規則資訊（第一次出現時保留）＋跨頁 pages/elements 累計，供 HTML 詳列一次
  const rules = new Map();
  let affected = 0;
  let manualReview = 0;
  let bestPractice = 0;
  ok.forEach((p) => {
    p.violations.forEach((v) => {
      affected += v.nodeCount;
      const r = rules.get(v.axeId);
      if (r) {
        r.pages += 1;
        r.elements += v.nodeCount;
      } else {
        const { nodeCount, ...rest } = v;
        rules.set(v.axeId, { ...rest, pages: 1, elements: nodeCount });
      }
    });
    manualReview += p.summary.needsManualReview;
    bestPractice += p.summary.bestPractice;
  });
  // byLevel 依「不重複規則」計（跨頁同一規則只算一次），與 uniqueRulesFailing 一致
  for (const r of rules.values()) {
    if (r.mapped) byLevel[r.level] = (byLevel[r.level] || 0) + 1;
    else byLevel.unmapped += 1;
  }
  const topRules = [...rules.values()].sort((a, b) => b.pages - a.pages || b.elements - a.elements);
  const worstPages = ok
    .map((p) => ({ url: p.finalUrl || p.url, violations: p.summary.violations }))
    .sort((a, b) => b.violations - a.violations)
    .slice(0, 10);
  return {
    pagesScanned: ok.length,
    pagesWithViolations: ok.filter((p) => p.summary.violations > 0).length,
    uniqueRulesFailing: rules.size,
    byLevel,
    totalAffectedElements: affected,
    needsManualReviewTotal: manualReview,
    bestPracticeTotal: bestPractice,
    topRules,
    worstPages,
  };
}

function aggregateByLanguage(pages) {
  const langs = [...new Set(pages.map((p) => p.lang).filter(Boolean))];
  if (langs.length < 1) return null;
  const out = {};
  langs.forEach((lang) => {
    out[lang] = aggregate(pages.filter((p) => p.lang === lang));
  });
  return out;
}

// ===== 主控台摘要 =====
function printManualChecksLine(targetLevel) {
  const { shown } = manualChecksForLevel(targetLevel);
  console.log(
    `  新增準則      ${shown.length} 條需人工檢核（axe 無法判定，不影響離開碼；詳見報告）`,
  );
}

function printPageSummary(report) {
  const s = report.summary;
  console.log('\n── Ramp 檢測摘要 ──');
  console.log('  ' + report.title);
  console.log('  ' + report.finalUrl + '\n');
  console.log(`  違規規則      ${s.violations}（受影響元素 ${s.affectedElements}）`);
  console.log(
    `    依等級      A ${s.byLevel.A} · AA ${s.byLevel.AA} · AAA ${s.byLevel.AAA}` +
      (s.byLevel.unmapped ? ` · 其他 ${s.byLevel.unmapped}` : ''),
  );
  const tsp = targetSplit(s.byLevel, report.targetLevel);
  console.log(`    目標 ${report.targetLevel}     目標內 ${tsp.within} · 超出目標 ${tsp.beyond}`);
  console.log(`  最佳實務建議  ${s.bestPractice}`);
  console.log(`  需人工複核    ${s.needsManualReview}`);
  printManualChecksLine(report.targetLevel);
}

function printSiteSummary(site) {
  const a = site.siteSummary;
  console.log('\n══ Ramp 全站彙整 ══');
  console.log(
    `  掃描頁數      ${a.pagesScanned}（有違規 ${a.pagesWithViolations}，失敗 ${site.crawl.pagesFailed}）`,
  );
  console.log(`  站內失敗規則  ${a.uniqueRulesFailing} 種，共 ${a.totalAffectedElements} 個元素`);
  console.log(
    `    依等級      A ${a.byLevel.A} · AA ${a.byLevel.AA} · AAA ${a.byLevel.AAA}` +
      (a.byLevel.unmapped ? ` · 其他 ${a.byLevel.unmapped}` : ''),
  );
  const tsp = targetSplit(a.byLevel, site.targetLevel);
  console.log(`    目標 ${site.targetLevel}     目標內 ${tsp.within} · 超出目標 ${tsp.beyond}`);
  console.log(`  需人工複核    ${a.needsManualReviewTotal}`);
  printManualChecksLine(site.targetLevel);
  if (a.topRules.length) {
    console.log('\n  最常見的障礙：');
    a.topRules.slice(0, 8).forEach((r) => {
      console.log(
        `    • ${r.title}（${r.guideline || '未對應'}/${r.level || '—'}）— ${r.pages} 頁 / ${r.elements} 元素`,
      );
    });
  }
  if (site.byLanguage) {
    console.log('\n  逐語言違規規則數：');
    Object.entries(site.byLanguage).forEach(([lang, agg]) => {
      console.log(
        `    ${lang}: ${agg.uniqueRulesFailing} 種 / ${agg.totalAffectedElements} 元素（${agg.pagesScanned} 頁）`,
      );
    });
  }
}

// ===== HTML 報告（沿用擴充套件匯出報告的視覺風格；escapeHtml 來自共用模組）=====
const REPORT_CSS = `
  body { font-family: "Microsoft JhengHei","PingFang TC","Noto Sans TC",system-ui,sans-serif;
         max-width: 960px; margin: 0 auto; padding: 24px; color: #1F2937; line-height: 1.7; }
  header { border-bottom: 3px solid #0F766E; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { font-size: 22px; color: #0F766E; margin: 0 0 8px; }
  h2 { font-size: 17px; margin: 28px 0 10px; padding-bottom: 4px; border-bottom: 1px solid #E5E7EB; }
  .info, .meta, .more { color: #4B5563; font-size: 13px; }
  table.stats { border-collapse: collapse; margin: 12px 0; width: 100%; }
  table.stats th, table.stats td { border: 1px solid #E5E7EB; padding: 6px 12px; font-size: 14px; text-align: center; }
  table.stats th { background: #F9FAFB; }
  .issue { border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px 16px; margin: 10px 0; page-break-inside: avoid; }
  .issue h4 { font-size: 15px; margin: 0 0 4px; }
  .badge { display: inline-block; background: #374151; color: #fff; border-radius: 999px;
           font-size: 12px; padding: 1px 10px; margin-right: 8px; vertical-align: middle; }
  .count { color: #B91C1C; font-size: 13px; }
  .nodes { margin: 4px 0 0 20px; }
  .nodes code { font-size: 12px; word-break: break-all; }
  .nvda { font-size: 12px; color: #0F766E; margin: 4px 0; }
  details { border: 1px solid #E5E7EB; border-radius: 8px; padding: 8px 14px; margin: 8px 0; }
  summary { cursor: pointer; font-weight: 600; font-size: 14px; }
  ul.pagerules { margin: 6px 0 0 18px; font-size: 13px; }
  .disclaimer { margin-top: 32px; padding: 12px 16px; background: #FEF9C3; border-radius: 8px;
                font-size: 13px; color: #713F12; }
`;

function nvdaText(nvda) {
  const parts = nvdaParts(nvda);
  return parts.length
    ? `<p class="nvda">🔊 模擬 NVDA 朗讀：${escapeHtml(parts.join('　'))}</p>`
    : '';
}

function ruleDetailHtml(r) {
  const badge = r.mapped ? r.level : r.isBestPractice ? '建議' : '其他';
  const meta = r.mapped
    ? `台灣規範 ${escapeHtml(r.guideline)} ${escapeHtml(r.guidelineName || '')}（${escapeHtml(r.category)}）・等級 ${escapeHtml(r.level)}` +
      (r.impact ? `・影響 ${escapeHtml(r.impact)}` : '') +
      (r.checkCodes && r.checkCodes.length
        ? `・檢測碼 ${r.checkCodes.map(escapeHtml).join('、')}`
        : '')
    : `${r.isBestPractice ? '最佳實務建議（非規範必要）' : r.isWcag22 ? 'WCAG 2.2 新增（115 年修正版起適用）' : '未對應台灣準則'}・axe ${escapeHtml(r.axeId)}`;
  const count = r.pages != null ? `${r.pages} 頁 / ${r.elements} 元素` : `×${r.elements}`;
  const targets = (r.sampleTargets || [])
    .map((t) => `<li><code>${escapeHtml(t)}</code></li>`)
    .join('');
  return `<section class="issue">
    <h4><span class="badge">${escapeHtml(badge)}</span>${escapeHtml(r.title)} <span class="count">${count}</span></h4>
    <p class="meta">${meta}</p>
    ${r.why ? `<p><strong>為什麼是障礙：</strong>${escapeHtml(r.why)}</p>` : ''}
    ${r.how ? `<p><strong>如何修正：</strong>${escapeHtml(r.how)}</p>` : ''}
    ${r.note ? `<p class="more">※ ${escapeHtml(r.note)}</p>` : ''}
    ${nvdaText(r.sampleNvda)}
    ${targets ? `<p class="meta">代表元素：</p><ul class="nodes">${targets}</ul>` : ''}
  </section>`;
}

function pageDetailHtml(p) {
  if (p.ok === false) {
    return `<details><summary>⚠ ${escapeHtml(p.url)} — 掃描失敗</summary><p class="meta">${escapeHtml(p.error || '')}</p></details>`;
  }
  const rules = p.violations.length
    ? p.violations
        .map(
          (v) =>
            `<li><span class="badge">${escapeHtml(v.mapped ? v.level : '其他')}</span>${escapeHtml(v.title)} <span class="count">×${v.nodeCount}</span></li>`,
        )
        .join('')
    : '<li>（無自動化違規）</li>';
  const lang = p.lang ? `　語言 ${escapeHtml(p.lang)}` : '';
  return `<details>
    <summary>${escapeHtml(p.finalUrl || p.url)} — 違規 ${p.summary.violations}・待複核 ${p.summary.needsManualReview}${lang}</summary>
    <p class="meta">${escapeHtml(p.title || '')}</p>
    <ul class="pagerules">${rules}</ul>
  </details>`;
}

function docShell(title, headerHtml, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
${headerHtml}
${bodyHtml}
<div class="disclaimer">
  <strong>限制聲明：</strong>自動化檢測僅能涵蓋約三到四成的無障礙問題，本報告不等同官方無障礙標章認證；
  鍵盤操作動線、報讀軟體實際體驗、替代文字是否恰當等仍需人工複核。
</div>
</body>
</html>`;
}

/** 115 年修正版新增準則的人工檢核清單（單頁與全站報告共用，一律列出全部） */
function manualChecksHtml() {
  const items = MANUAL_CHECKS.map(
    (c) => `<section class="issue">
    <h4><span class="badge">${escapeHtml(c.level)}</span>${escapeHtml(c.title)}</h4>
    <p class="meta">台灣規範 ${escapeHtml(c.guideline)} ${escapeHtml(c.guidelineName)}（${escapeHtml(c.category)}）・等級 ${escapeHtml(c.level)}・檢測碼 ${c.checkCodes.map(escapeHtml).join('、')}</p>
    <p><strong>什麼時候適用：</strong>${escapeHtml(c.appliesWhen)}</p>
    <p><strong>怎麼檢查：</strong>${escapeHtml(c.check)}</p>
    <p><strong>如何修正：</strong>${escapeHtml(c.how)}</p>
  </section>`,
  ).join('');
  return `<h2>115 年修正版新增準則・需人工檢核（${MANUAL_CHECKS.length} 項）</h2><p class="info">axe 無法自動判定這些準則，請自行確認；未確認不代表通過，也不影響離開碼。</p>${items}`;
}

function reportHeader(title, lines) {
  return `<header><h1>${escapeHtml(title)}</h1><p class="info">${lines.map(escapeHtml).join('<br>')}</p></header>`;
}

function buildSiteHtml(site) {
  const a = site.siteSummary;
  const time = new Date(site.scannedAt).toLocaleString('zh-TW');
  const tsp = targetSplit(a.byLevel, site.targetLevel);
  const header = reportHeader('Ramp 全站無障礙檢測報告', [
    `檢測來源：${site.source}`,
    ...[scopeLine(site.scope), authLine(site.auth)].filter(Boolean),
    `檢測時間：${time}`,
    `模式：${site.crawl.mode}・掃描 ${a.pagesScanned} 頁（失敗 ${site.crawl.pagesFailed}${site.crawl.truncated ? '，達上限截斷' : ''}）`,
    `工具：Ramp（ramp-a11y）v${site.version}・檢測引擎 axe-core ${AXE_VERSION}`,
    `目標等級 ${site.targetLevel}：目標內 ${tsp.within} 種規則・超出目標 ${tsp.beyond} 種（報告仍列出全部）`,
  ]);
  const stats = `<table class="stats">
    <tr><th>掃描頁數</th><th>有違規頁數</th><th>失敗規則(不重複)</th><th>受影響元素</th><th>A</th><th>AA</th><th>AAA</th><th>其他</th><th>需人工複核</th></tr>
    <tr><td>${a.pagesScanned}</td><td>${a.pagesWithViolations}</td><td>${a.uniqueRulesFailing}</td><td>${a.totalAffectedElements}</td><td>${a.byLevel.A}</td><td>${a.byLevel.AA}</td><td>${a.byLevel.AAA}</td><td>${a.byLevel.unmapped}</td><td>${a.needsManualReviewTotal}</td></tr>
  </table>`;
  let langHtml = '';
  if (site.byLanguage) {
    const rows = Object.entries(site.byLanguage)
      .map(
        ([lang, g]) =>
          `<tr><td>${escapeHtml(lang)}</td><td>${g.pagesScanned}</td><td>${g.uniqueRulesFailing}</td><td>${g.totalAffectedElements}</td><td>${g.needsManualReviewTotal}</td></tr>`,
      )
      .join('');
    langHtml = `<h2>逐語言彙整</h2><table class="stats"><tr><th>語言</th><th>頁數</th><th>失敗規則</th><th>受影響元素</th><th>需人工複核</th></tr>${rows}</table>`;
  }
  const topRules = a.topRules.length
    ? `<h2>最常見的障礙（依影響頁數，每項修正建議詳列一次）</h2>${a.topRules.map(ruleDetailHtml).join('')}`
    : '<h2>最常見的障礙</h2><p>未發現自動化可偵測的違規。</p>';
  const worst = a.worstPages.length
    ? `<h2>問題最多的頁面</h2><table class="stats"><tr><th style="text-align:left">頁面</th><th>違規數</th></tr>${a.worstPages
        .map(
          (w) =>
            `<tr><td style="text-align:left">${escapeHtml(w.url)}</td><td>${w.violations}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const perPage = `<h2>逐頁明細（${site.pages.length}）</h2>${site.pages.map(pageDetailHtml).join('')}`;
  return docShell(
    `Ramp 全站報告 — ${site.source}`,
    header,
    `${stats}${langHtml}${topRules}${worst}${manualChecksHtml()}${perPage}`,
  );
}

function buildPageHtml(out) {
  const time = new Date(out.scannedAt).toLocaleString('zh-TW');
  const s = out.summary;
  const tsp = targetSplit(s.byLevel, out.targetLevel);
  const header = reportHeader('Ramp 無障礙檢測報告', [
    `檢測網址：${out.finalUrl}`,
    ...[scopeLine(out.scope), authLine(out.auth)].filter(Boolean),
    `檢測時間：${time}`,
    `工具：Ramp（ramp-a11y）v${out.version}・檢測引擎 axe-core ${AXE_VERSION}`,
    `目標等級 ${out.targetLevel}：目標內 ${tsp.within} 項・超出目標 ${tsp.beyond} 項（報告仍列出全部）`,
  ]);
  const stats = `<table class="stats">
    <tr><th>違規規則</th><th>受影響元素</th><th>A</th><th>AA</th><th>AAA</th><th>其他</th><th>最佳實務建議</th><th>需人工複核</th></tr>
    <tr><td>${s.violations}</td><td>${s.affectedElements}</td><td>${s.byLevel.A}</td><td>${s.byLevel.AA}</td><td>${s.byLevel.AAA}</td><td>${s.byLevel.unmapped}</td><td>${s.bestPractice}</td><td>${s.needsManualReview}</td></tr>
  </table>`;
  const rulesHtml = out.violations.length
    ? out.violations.map((v) => ruleDetailHtml({ ...v, elements: v.nodeCount })).join('')
    : '<p>未發現自動化可偵測的違規。</p>';
  return docShell(
    `Ramp 報告 — ${out.finalUrl}`,
    header,
    `${stats}<h2>違規明細</h2>${rulesHtml}${manualChecksHtml()}`,
  );
}

// ===== 輸出 =====
function writeReport(outDir, baseName, report) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = report.scannedAt.replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${baseName}-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  return outFile;
}

function writeHtml(outDir, baseName, scannedAt, html) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = scannedAt.replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${baseName}-${stamp}.html`);
  fs.writeFileSync(outFile, html);
  return outFile;
}
function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'page';
  }
}

// ===== 進入點 =====
async function main() {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    // 不認得的旗標、旗標缺值：參數錯誤（exit 1），不是掃描錯誤
    console.error(`參數錯誤：${e.message}（--help 看用法）`);
    process.exit(1);
  }
  const { values, url } = parsed;
  const urlList = values['url-list'];
  if (values.help || (!url && !urlList)) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  if (!['json', 'html', 'both'].includes(values.format)) {
    console.error(`--format 需為 json｜html｜both；收到：${values.format}`);
    process.exit(1);
  }
  if (!LEVEL_ORDER.includes(values.level)) {
    console.error(`--level 需為 A｜AA｜AAA；收到：${values.level}`);
    process.exit(1);
  }
  if (!['none', 'violations'].includes(values['fail-on'])) {
    console.error(`--fail-on 需為 none｜violations；收到：${values['fail-on']}`);
    process.exit(1);
  }
  if (urlList && url) {
    console.error(`提醒：已指定 --url-list，位置參數網址 ${url} 將被忽略`);
  }
  // --include/--exclude 在參數階段就編譯：無效 regex 是參數錯誤（exit 1），
  // 不該等瀏覽器啟動後才以掃描錯誤（exit 2）炸出來
  let pass;
  try {
    pass = makeFilter(values.include, values.exclude);
  } catch (e) {
    console.error(`--include/--exclude 不是有效的正規表示式：${e.message}`);
    process.exit(1);
  }
  const fmtJson = values.format === 'json' || values.format === 'both';
  const fmtHtml = values.format === 'html' || values.format === 'both';
  // 數值旗標：值不合法一律 exit 1，不靜默夾值——--timeout 0 過去被夾成 1 毫秒，
  // 結果每頁都逾時失敗卻不算參數錯誤；--max-pages 0 被夾成 1 也沒說
  const num = (v, name, min) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) {
      console.error(`--${name} 需為 ≥ ${min} 的數字；收到：${v}`);
      process.exit(1);
    }
    return n;
  };
  const opts = {
    depth: Math.floor(num(values.depth, 'depth', 0)),
    maxPages: Math.floor(num(values['max-pages'], 'max-pages', 1)),
    concurrency: Math.floor(num(values.concurrency, 'concurrency', 1)),
    delay: num(values.delay, 'delay', 0),
    pass,
    timeout: num(values.timeout, 'timeout', 1000),
    chrome: values.chrome,
    scope: (values.scope || '').trim(),
    scopeExclude: (values['scope-exclude'] || '').trim(),
  };
  if (values.scope !== undefined && !opts.scope) {
    console.error('--scope 不能是空字串（要掃整頁就不要加 --scope）');
    process.exit(1);
  }
  // 登入後掃描：憑證格式錯是參數錯誤（exit 1）；錯誤訊息只說哪一筆、哪個欄位，不印值
  const auth = authMethods(values);
  if (values.cookies) {
    if (!fs.existsSync(values.cookies)) {
      console.error(`--cookies 檔案不存在：${values.cookies}`);
      process.exit(1);
    }
    try {
      opts.cookies = parseCookieFile(fs.readFileSync(values.cookies, 'utf8'));
    } catch (e) {
      console.error(`--cookies：${e.message}`);
      process.exit(1);
    }
  }
  try {
    opts.headers = parseHeaders(values.header);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (values['login-url'] && !values.login) {
    console.error('--login-url 要搭配 --login');
    process.exit(1);
  }
  if (values.login && !process.stdin.isTTY) {
    console.error(
      '--login 要在互動終端機執行（登入完要按 Enter）；CI 請改用 --cookies 或 --header',
    );
    process.exit(1);
  }
  const log = values.quiet ? () => {} : (m) => console.error(m);
  const version = VERSION;
  const started = Date.now();

  // 模式判定
  const multi = !!urlList || opts.depth >= 1;

  // 啟動瀏覽器前先把「不用瀏覽器就能擋下」的錯誤擋完（清單檔不存在／為空、起始頁或
  // 清單全部被排除），免得白開一個 Chrome 又不經 finally 關閉
  let listEntries = null;
  if (urlList) {
    if (!fs.existsSync(urlList)) {
      console.error(`--url-list 檔案不存在：${urlList}`);
      process.exit(1);
    }
    listEntries = parseUrlList(urlList, (m) => console.error(`提醒：${m}`));
    if (!listEntries.length) {
      console.error(`--url-list 未解析出任何 URL：${urlList}`);
      process.exit(1);
    }
    // 全部被篩掉：過去會「掃 0 頁、exit 0」——搭配 --fail-on 的 CI 什麼都沒掃卻是綠燈
    if (!listEntries.some((e) => pass(e.url))) {
      console.error(
        `--url-list 的 ${listEntries.length} 筆全部被 --include/--exclude 排除，沒有可掃描的頁面`,
      );
      process.exit(1);
    }
  }
  if (!multi && !pass(normalizeUrl(url))) {
    console.error(`起始網址被 --include/--exclude 排除，沒有可掃描的頁面：${url}`);
    process.exit(1);
  }

  if (auth.length) {
    // 自訂標頭只送這些來源：單頁／爬掃是起始網址的來源（爬掃不出站），清單是每一筆的來源
    opts.headerOrigins = new Set(
      (listEntries ? listEntries.map((e) => e.url) : [normalizeUrl(url)])
        .map(originOf)
        .filter(Boolean),
    );
    // 跳過登出網址（起始頁照掃——是使用者自己指定的）
    const basePass = opts.pass;
    opts.pass = (u) => basePass(u) && !isLogoutUrl(u);
    if (listEntries) {
      const n = listEntries.filter((e) => basePass(e.url) && isLogoutUrl(e.url)).length;
      if (n) log(`提醒：清單裡有 ${n} 筆看起來像登出網址，已略過（登入後掃描不能把自己登出）`);
    }
  }

  // --login：先開看得見的 Chrome 讓使用者自己登入，關掉後用同一個設定檔掃
  let tempProfile = null;
  let userDataDir = values['user-data-dir'];
  if (values.login && !userDataDir) {
    tempProfile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ramp-login-'));
    userDataDir = tempProfile;
  }
  try {
    if (values.login) {
      const loginUrl =
        values['login-url'] || (listEntries ? listEntries[0].url : normalizeUrl(url));
      const visible = await puppeteer.launch({
        executablePath: findChrome(opts.chrome),
        headless: false,
        defaultViewport: null,
        userDataDir,
        args: chromeLaunchArgs(values['no-sandbox'], process.env),
      });
      try {
        const pages = await visible.pages();
        const p = pages[0] || (await visible.newPage());
        await p
          .goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: opts.timeout })
          .catch(() => {});
        console.error(
          `已開啟 Chrome：請在視窗裡登入 ${loginUrl}，完成後回到這裡按 Enter 開始掃描…`,
        );
        await new Promise((resolve) => {
          process.stdin.resume();
          process.stdin.once('data', () => {
            process.stdin.pause();
            resolve();
          });
        });
      } finally {
        await visible.close();
      }
    }
    await runWithBrowser(userDataDir);
  } finally {
    if (tempProfile) fs.rmSync(tempProfile, { recursive: true, force: true });
  }

  async function runWithBrowser(profileDir) {
    const browser = await puppeteer.launch({
      executablePath: findChrome(opts.chrome),
      headless: true,
      ...(profileDir ? { userDataDir: profileDir } : {}),
      args: chromeLaunchArgs(values['no-sandbox'], process.env),
    });

    try {
      // --scope／--scope-exclude 寫錯是參數錯誤（exit 1）：在空白頁用瀏覽器自己的解析器先驗一次，
      // 不要等每一頁都失敗才變成掃描錯誤（exit 2）
      for (const [flag, sel] of [
        ['--scope', opts.scope],
        ['--scope-exclude', opts.scopeExclude],
      ]) {
        if (!sel) continue;
        const probe = await browser.newPage();
        try {
          const ok = await probe.evaluate((s) => {
            try {
              document.querySelector(s);
              return true;
            } catch (e) {
              return false;
            }
          }, sel);
          if (!ok) {
            console.error(`${flag} 不是有效的 CSS 選擇器：${sel}`);
            process.exitCode = 1;
            return;
          }
        } finally {
          await probe.close();
        }
      }
      if (!multi) {
        // 單頁
        log(`掃描 ${url} …`);
        const { report } = await visitPage(browser, normalizeUrl(url), opts);
        const out = {
          tool: 'ramp-scan',
          version,
          scannedAt: new Date(started).toISOString(),
          targetLevel: values.level,
          ...report,
          // 登入後掃描用了哪幾種方式（只有方式，沒有任何值）；沒登入是空陣列
          auth,
          manualChecks: manualChecksReport(values.level),
        };
        const base = safeHost(out.finalUrl);
        const written = [];
        if (fmtJson) written.push(writeReport(values.out, base, out));
        if (fmtHtml) written.push(writeHtml(values.out, base, out.scannedAt, buildPageHtml(out)));
        if (!values.quiet) printPageSummary(out);
        log(`\n報告已寫入：\n  ${written.join('\n  ')}`);
        const code = singlePageExitCode(out.summary, values['fail-on'], values.level);
        if (code === 3) {
          const n = targetSplit(out.summary.byLevel, values.level).within;
          console.error(
            `✘ --fail-on violations：目標 ${values.level} 內有 ${n} 項違規（離開碼 3）`,
          );
        }
        process.exitCode = code;
        return;
      }

      // 多頁：爬蟲 或 URL 清單
      let result;
      let source;
      let mode;
      if (urlList) {
        mode = 'url-list';
        source = urlList;
        const passedCount = listEntries.filter((e) => pass(e.url)).length;
        log(
          `從清單掃描 ${Math.min(passedCount, opts.maxPages)} 個 URL（來源 ${urlList}、並行 ${opts.concurrency}）…`,
        );
        result = await scanList(browser, listEntries, opts, log);
      } else {
        mode = 'crawl';
        source = url;
        log(
          `自 ${url} 爬取（深度 ${opts.depth}、上限 ${opts.maxPages}、並行 ${opts.concurrency}）…`,
        );
        result = await crawlSite(browser, url, opts, log);
      }

      const site = {
        tool: 'ramp-scan',
        version,
        scannedAt: new Date(started).toISOString(),
        targetLevel: values.level,
        source,
        // 登入後掃描用了哪幾種方式（只有方式，沒有任何值）；沒登入是空陣列
        auth,
        // 局部掃描的範圍（每一頁都一樣；整頁是 null）
        scope:
          opts.scope || opts.scopeExclude
            ? { include: opts.scope || null, exclude: opts.scopeExclude || null }
            : null,
        crawl: {
          mode,
          pagesScanned: result.pages.filter((p) => p.ok !== false).length,
          pagesFailed: result.failed,
          maxDepth: opts.depth,
          maxPages: opts.maxPages,
          truncated: result.truncated,
        },
        siteSummary: aggregate(result.pages),
        manualChecks: manualChecksReport(values.level),
        byLanguage: aggregateByLanguage(result.pages),
        pages: result.pages,
      };
      if (!site.byLanguage) delete site.byLanguage;

      const base = mode === 'crawl' ? safeHost(source) + '-site' : 'urllist';
      const written = [];
      if (fmtJson) written.push(writeReport(values.out, base, site));
      if (fmtHtml) written.push(writeHtml(values.out, base, site.scannedAt, buildSiteHtml(site)));
      if (!values.quiet) printSiteSummary(site);
      log(`\n報告已寫入：\n  ${written.join('\n  ')}`);

      // 離開碼契約（見 --help 與 multiPageExitCode）：部分頁面失敗仍為 0（報告有記
      // pagesFailed），避免大站零星逾時把 CI 弄紅
      const code = multiPageExitCode(result.pages, values['fail-on'], values.level);
      if (code === 2) {
        console.error(
          `✘ 全部 ${result.pages.length} 頁掃描失敗（離開碼 2），請檢查網路、CSP 或 --timeout`,
        );
      } else if (code === 3) {
        const n = result.pages.filter(
          (p) => p.ok !== false && failOnTriggered(p.summary.byLevel, 'violations', values.level),
        ).length;
        console.error(`✘ --fail-on violations：${n} 頁有目標 ${values.level} 內的違規（離開碼 3）`);
      }
      process.exitCode = code;
    } finally {
      await browser.close();
    }
  }
}

// 直接執行才跑；被 require（測試）時只導出純函式，不執行 main
if (require.main === module) {
  main().catch((e) => {
    console.error('SCAN ERROR:', e.message);
    process.exit(2);
  });
}

module.exports = {
  normalizeUrl,
  isAsset,
  hostOf,
  makeFilter,
  translateRule,
  splitCsvLine,
  parseUrlList,
  aggregate,
  targetSplit,
  mapPool,
  buildSiteHtml,
  buildPageHtml,
  manualChecksReport,
  failOnTriggered,
  singlePageExitCode,
  multiPageExitCode,
  isTruthyEnv,
  chromeLaunchArgs,
  visitPage,
  scanList,
};
