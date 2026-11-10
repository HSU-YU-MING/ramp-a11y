/**
 * CLI 純函式單元測試（不需 Chrome）
 *
 * 用法：npm run test:cli
 *
 * require cli/ramp-scan.js（main 已以 require.main 守衛，被 require 時不執行），
 * 對其導出的純函式（URL 正規化、資產判定、清單解析、彙整）驗證。
 * 需真 Chrome 的實際掃描由 e2e／手動負責。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const cli = require(path.resolve(__dirname, '..', '..', 'cli', 'ramp-scan.js'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
function eq(name, actual, expected) {
  check(
    name,
    actual === expected,
    `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`,
  );
}

// ===== normalizeUrl（移植自作者雙語站爬蟲 norm）=====
eq('normalizeUrl 去 fragment', cli.normalizeUrl('https://x.com/a#top'), 'https://x.com/a');
eq('normalizeUrl 去尾斜線', cli.normalizeUrl('https://x.com/a/'), 'https://x.com/a');
eq('normalizeUrl 保留根斜線', cli.normalizeUrl('https://x.com/'), 'https://x.com/');
eq(
  'normalizeUrl 剝除追蹤參數、保留其他',
  cli.normalizeUrl('https://x.com/a?utm_source=fb&id=3'),
  'https://x.com/a?id=3',
);
eq(
  'normalizeUrl 尾斜線＋query 也去重',
  cli.normalizeUrl('https://x.com/a/?b=1'),
  'https://x.com/a?b=1',
);

// ===== isAsset =====
check('isAsset pdf', cli.isAsset('https://x.com/a.pdf') === true);
check('isAsset JPG（大小寫）', cli.isAsset('https://x.com/img.JPG') === true);
check('isAsset html 非資產', cli.isAsset('https://x.com/a.html') === false);
check('isAsset 無副檔名非資產', cli.isAsset('https://x.com/news') === false);

// ===== parseUrlList =====
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ramp-cli-'));
const csv = path.join(tmp, 'url_inventory.csv');
fs.writeFileSync(csv, 'source_url,lang,section\nhttps://x.com/ch/a,ch,\nhttps://x.com/en/a,en,\n');
const parsed = cli.parseUrlList(csv);
eq('parseUrlList CSV 筆數', parsed.length, 2);
eq('parseUrlList CSV 取 source_url', parsed[0].url, 'https://x.com/ch/a');
eq('parseUrlList CSV 取 lang', parsed[1].lang, 'en');

// CSV 表頭有空白（source_url, lang）也要能對到 lang 欄（否則逐語言功能靜默失效）
const csvSp = path.join(tmp, 'spaced.csv');
fs.writeFileSync(csvSp, 'source_url, lang, section\nhttps://x.com/ch/a, ch, \n');
const parsedSp = cli.parseUrlList(csvSp);
eq('parseUrlList CSV 表頭空白仍取到 lang', parsedSp[0].lang, 'ch');
eq('parseUrlList CSV 表頭空白仍取到 url', parsedSp[0].url, 'https://x.com/ch/a');

const txt = path.join(tmp, 'urls.txt');
fs.writeFileSync(txt, '# 註解\nhttps://x.com/1\nhttps://x.com/2\n');
const parsedTxt = cli.parseUrlList(txt);
eq('parseUrlList txt 略過註解、取 URL', parsedTxt.length, 2);
eq('parseUrlList txt lang 空', parsedTxt[0].lang, '');

// ===== 2026-10 稽核的「靜默掉筆」回歸 =====

// splitCsvLine：引號欄含逗號、"" 跳脫（天真 split(',') 會讓整列消失）
eq(
  'splitCsvLine 引號欄含逗號',
  cli.splitCsvLine('"Hello, world",https://x.com/a,ch').join('|'),
  'Hello, world|https://x.com/a|ch',
);
eq('splitCsvLine 雙引號跳脫', cli.splitCsvLine('"a""b",c')[0], 'a"b');

// 純 URL 清單存成 .csv（無 source_url 表頭）：過去第一行被當表頭丟掉
const noHeader = path.join(tmp, 'plain-urls.csv');
fs.writeFileSync(noHeader, 'https://x.com/1\nhttps://x.com/2\nhttps://x.com/3\n');
const warnsA = [];
const parsedNoHeader = cli.parseUrlList(noHeader, (m) => warnsA.push(m));
eq('parseUrlList 無表頭 .csv 不掉第一筆', parsedNoHeader.length, 3);
eq('parseUrlList 無表頭 .csv 第一筆正確', parsedNoHeader[0].url, 'https://x.com/1');
check('parseUrlList 無表頭 .csv 會出聲', warnsA.length >= 1, warnsA.join('；'));

// CSV 引號欄含逗號：過去欄位錯位後整列被 http 檢查靜默濾掉
const quoted = path.join(tmp, 'quoted.csv');
fs.writeFileSync(quoted, 'title,source_url,lang\n"Hello, world",https://x.com/a,ch\n');
const parsedQ = cli.parseUrlList(quoted);
eq('parseUrlList 引號欄含逗號不掉列', parsedQ.length, 1);
eq('parseUrlList 引號欄含逗號取對 url', parsedQ[0] && parsedQ[0].url, 'https://x.com/a');
eq('parseUrlList 引號欄含逗號取對 lang', parsedQ[0] && parsedQ[0].lang, 'ch');

// .txt：行首空白的註解也要略過、非 URL 行出聲略過
const txt2 = path.join(tmp, 'urls2.txt');
fs.writeFileSync(txt2, '  # 行首空白的註解\nhttps://x.com/9\nnot-a-url\n');
const warnsB = [];
const parsedTxt2 = cli.parseUrlList(txt2, (m) => warnsB.push(m));
eq('parseUrlList txt 行首空白註解＋非 URL 行', parsedTxt2.length, 1);
check('parseUrlList txt 非 URL 行會出聲', warnsB.length >= 1, warnsB.join('；'));

// makeFilter：無效 regex 必須 throw（main 在參數階段接住、exit 1）
check(
  'makeFilter 無效 regex 會 throw',
  (() => {
    try {
      cli.makeFilter('[', null);
      return false;
    } catch {
      return true;
    }
  })(),
);
const filt = cli.makeFilter('blog', 'draft');
check(
  'makeFilter include+exclude 行為',
  filt('https://x.com/blog/a') === true &&
    filt('https://x.com/blog/draft') === false &&
    filt('https://x.com/news') === false,
);

// normalizeUrl：沒剝追蹤參數就不重組 query（重組會改變原始編碼，空白→+）
eq(
  'normalizeUrl 無追蹤參數時保留原編碼',
  cli.normalizeUrl('https://x.com/a?q=a%20b'),
  'https://x.com/a?q=a%20b',
);

// ===== aggregate =====
const pages = [
  {
    ok: true,
    finalUrl: 'https://x.com/1',
    summary: { violations: 2, needsManualReview: 1, bestPractice: 0 },
    violations: [
      {
        axeId: 'image-alt',
        mapped: true,
        level: 'A',
        nodeCount: 3,
        title: 'img',
        guideline: '1.1.1',
      },
      {
        axeId: 'link-name',
        mapped: true,
        level: 'A',
        nodeCount: 1,
        title: 'link',
        guideline: '2.4.4',
      },
    ],
  },
  {
    ok: true,
    finalUrl: 'https://x.com/2',
    summary: { violations: 1, needsManualReview: 0, bestPractice: 0 },
    violations: [
      {
        axeId: 'image-alt',
        mapped: true,
        level: 'A',
        nodeCount: 2,
        title: 'img',
        guideline: '1.1.1',
      },
    ],
  },
  { ok: false, url: 'https://x.com/3', error: 'boom' },
];
const agg = cli.aggregate(pages);
eq('aggregate 掃描頁數(排除失敗)', agg.pagesScanned, 2);
eq('aggregate 不重複失敗規則', agg.uniqueRulesFailing, 2);
eq('aggregate 等級 A 計數(不重複規則)', agg.byLevel.A, 2);
eq('aggregate 受影響元素總數', agg.totalAffectedElements, 6);
eq('aggregate 需人工複核總數', agg.needsManualReviewTotal, 1);
eq('aggregate topRules 首位為 image-alt', agg.topRules[0].axeId, 'image-alt');
eq('aggregate topRules image-alt 跨頁元素數', agg.topRules[0].elements, 5);

// targetSplit：依目標等級分「目標內／超出目標」（不含 unmapped）
const bl = { A: 2, AA: 1, AAA: 3, unmapped: 1 };
eq('targetSplit A → 目標內', cli.targetSplit(bl, 'A').within, 2);
eq('targetSplit A → 超出', cli.targetSplit(bl, 'A').beyond, 4);
eq('targetSplit AA → 目標內', cli.targetSplit(bl, 'AA').within, 3);
eq('targetSplit AA → 超出', cli.targetSplit(bl, 'AA').beyond, 3);
eq('targetSplit AAA → 超出恆為 0', cli.targetSplit(bl, 'AAA').beyond, 0);

// ===== 2026-10 第二輪複驗補的回歸 =====

// normalizeUrl：剝掉追蹤參數時，其餘參數的原始編碼也要原封不動（過去 %20 → +）
eq(
  'normalizeUrl 剝追蹤參數時保留其餘參數編碼',
  cli.normalizeUrl('https://x.example/p/?utm_source=x&q=a%20b'),
  'https://x.example/p?q=a%20b',
);
eq(
  'normalizeUrl 只有追蹤參數 → 整段 query 拿掉',
  cli.normalizeUrl('https://x.example/p?utm_source=x&fbclid=1'),
  'https://x.example/p',
);

// .txt 行尾註解
const txt3 = path.join(tmp, 'urls3.txt');
fs.writeFileSync(txt3, 'https://x.com/a   # 首頁\nhttps://x.com/b#frag\n');
const parsedTxt3 = cli.parseUrlList(txt3);
eq('parseUrlList txt 行尾註解被剝掉', parsedTxt3[0] && parsedTxt3[0].url, 'https://x.com/a');
eq(
  'parseUrlList txt 網址內的 #fragment 保留',
  parsedTxt3[1] && parsedTxt3[1].url,
  'https://x.com/b#frag',
);

// --fail-on 只看「目標等級內、已對應台灣準則」的違規
const onlyAAA = { A: 0, AA: 0, AAA: 2, unmapped: 3 };
check(
  'failOnTriggered 只有 AAA／未對應、目標 A → 不觸發',
  !cli.failOnTriggered(onlyAAA, 'violations', 'A'),
);
check('failOnTriggered 目標 AAA → 觸發', cli.failOnTriggered(onlyAAA, 'violations', 'AAA'));
check('failOnTriggered none → 永不觸發', !cli.failOnTriggered({ A: 5 }, 'none', 'AA'));
eq(
  'singlePageExitCode 目標內有違規 → 3',
  cli.singlePageExitCode({ byLevel: { A: 1 } }, 'violations', 'AA'),
  3,
);

// 多頁離開碼：全部失敗 2、觸發 3、部分失敗 0、什麼都沒有 0
const okPage = (byLevel) => ({ ok: true, summary: { byLevel } });
const badPage = { ok: false, error: 'x' };
eq(
  'multiPageExitCode 全部失敗 → 2',
  cli.multiPageExitCode([badPage, badPage], 'violations', 'AA'),
  2,
);
eq(
  'multiPageExitCode 部分失敗、無目標內違規 → 0',
  cli.multiPageExitCode([badPage, okPage({ AAA: 1 })], 'violations', 'AA'),
  0,
);
eq(
  'multiPageExitCode 有目標內違規 → 3',
  cli.multiPageExitCode([badPage, okPage({ AA: 1 })], 'violations', 'AA'),
  3,
);

// Chrome 沙箱：預設保留；旗標或 CI 真值才關；CI=false／0 不算
check('chromeLaunchArgs 預設不關沙箱', !cli.chromeLaunchArgs(false, {}).includes('--no-sandbox'));
check(
  'chromeLaunchArgs --no-sandbox 旗標',
  cli.chromeLaunchArgs(true, {}).includes('--no-sandbox'),
);
check(
  'chromeLaunchArgs CI=true',
  cli.chromeLaunchArgs(false, { CI: 'true' }).includes('--no-sandbox'),
);
check(
  'chromeLaunchArgs CI=false／0 不關沙箱',
  !cli.chromeLaunchArgs(false, { CI: 'false' }).includes('--no-sandbox') &&
    !cli.chromeLaunchArgs(false, { CI: '0' }).includes('--no-sandbox'),
);

// 離開碼整合測試：實際 spawn CLI，只測「不需 Chrome 就該擋下」的參數錯誤（全部 exit 1，
// 而且都在啟動瀏覽器之前——CHROME_PATH 指到不存在的路徑，若真的走到啟動會變成 exit 2）
const { spawnSync } = require('child_process');
const CLI = path.resolve(__dirname, '..', '..', 'cli', 'ramp-scan.js');
const runCli = (args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CHROME_PATH: path.join(tmp, 'no-such-chrome.exe'), CI: '' },
    timeout: 20000,
  }).status;
const plainList = path.join(tmp, 'plain.txt');
fs.writeFileSync(plainList, 'https://x.example/a\nhttps://x.example/b\n');
const emptyList = path.join(tmp, 'empty.txt');
fs.writeFileSync(emptyList, '# 只有註解\n');
eq('CLI --help → 0', runCli(['--help']), 0);
eq('CLI 沒給網址 → 1', runCli([]), 1);
eq('CLI 不認得的旗標 → 1', runCli(['--foo', 'https://x.example/']), 1);
eq('CLI 旗標缺值 → 1', runCli(['https://x.example/', '--depth']), 1);
eq('CLI 無效 regex → 1', runCli(['https://x.example/', '--include', '[']), 1);
eq('CLI --format 不合法 → 1', runCli(['https://x.example/', '--format', 'xml']), 1);
eq('CLI --fail-on 不合法 → 1', runCli(['https://x.example/', '--fail-on', 'bogus']), 1);
eq('CLI --timeout 0 → 1（不再靜默夾成 1ms）', runCli(['https://x.example/', '--timeout', '0']), 1);
eq('CLI --max-pages 0 → 1', runCli(['https://x.example/', '--max-pages', '0']), 1);
eq('CLI 清單檔不存在 → 1', runCli(['--url-list', path.join(tmp, 'nope.csv')]), 1);
eq('CLI 清單為空 → 1', runCli(['--url-list', emptyList]), 1);
eq('CLI 清單全部被排除 → 1', runCli(['--url-list', plainList, '--exclude', '.']), 1);
eq('CLI 單頁被排除 → 1', runCli(['https://x.example/', '--exclude', 'x\\.example']), 1);

fs.rmSync(tmp, { recursive: true, force: true });

// mapPool（--concurrency 的並行池）：以假的 async 任務驗證順序保留與並行不超過上限，不需瀏覽器
(async () => {
  let activeNow = 0;
  let peak = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  const out = await cli.mapPool(items, 3, async (x) => {
    activeNow += 1;
    peak = Math.max(peak, activeNow);
    await new Promise((r) => setTimeout(r, 5));
    activeNow -= 1;
    return x * 2;
  });
  eq('mapPool 結果依輸入順序', out.join(','), items.map((x) => x * 2).join(','));
  eq('mapPool 並行峰值等於上限', peak, 3);
  const single = await cli.mapPool([1, 2, 3], 1, async (x) => x + 1);
  eq('mapPool 並行 1 = 循序', single.join(','), '2,3,4');

  // scanList 的 truncated：被 --exclude 濾掉不算截斷，真的超過 --max-pages 才算
  // （注入假的 visit，不需瀏覽器）
  const fakeReport = () => ({ report: { summary: { violations: 0, byLevel: {} } } });
  const entries3 = ['a', 'b', 'skip'].map((n) => ({ url: `https://x.example/${n}`, lang: '' }));
  const base = { pass: (u) => !u.endsWith('skip'), concurrency: 1, delay: 0, visit: fakeReport };
  const r2 = await cli.scanList(null, entries3, { ...base, maxPages: 2 }, () => {});
  check('scanList 只是被排除 → truncated=false', r2.truncated === false && r2.pages.length === 2);
  const r1 = await cli.scanList(null, entries3, { ...base, maxPages: 1 }, () => {});
  check('scanList 超過 max-pages → truncated=true', r1.truncated === true && r1.pages.length === 1);

  // visitPage 必須在 goto 之前開 setBypassCSP（否則嚴格 CSP 的網站注入必失敗）——
  // 用記錄呼叫順序的假 browser/page 驗證，不需 Chrome
  const calls = [];
  const fakePage = {
    setViewport: async () => calls.push('viewport'),
    setUserAgent: async (ua) => calls.push('ua:' + ua),
    setBypassCSP: async (v) => calls.push('csp:' + v),
    goto: async () => calls.push('goto'),
    title: async () => 't',
    addScriptTag: async () => calls.push('inject'),
    evaluate: async () =>
      calls.includes('scan') ? [] : (calls.push('scan'), { violations: [], incomplete: [] }),
    url: () => 'https://x.example/',
    close: async () => calls.push('close'),
  };
  await cli.visitPage({ newPage: async () => fakePage }, 'https://x.example/', { timeout: 5000 });
  check(
    'visitPage 在 goto 之前 setBypassCSP(true)',
    calls.indexOf('csp:true') >= 0 && calls.indexOf('csp:true') < calls.indexOf('goto'),
    calls.join(' → '),
  );
  const pkgVer = require(path.resolve(__dirname, '..', '..', 'package.json')).version;
  check(
    'visitPage 的 User-Agent 帶真實版本',
    calls.some((c) => c.startsWith('ua:') && c.includes(`ramp-scan/${pkgVer}`)),
  );

  // ===== 115 年修正版新增準則的人工檢核清單 =====
  {
    const report = cli.manualChecksReport('AA');
    check(
      '人工檢核：報告帶全部八條，並標示目標內五條',
      report.length === 8 && report.filter((c) => c.withinTarget).length === 5,
    );
    const pageHtml = cli.buildPageHtml({
      scannedAt: '2026-11-30T00:00:00.000Z',
      finalUrl: 'https://example.test/',
      version: '0.0.0',
      targetLevel: 'AA',
      summary: {
        violations: 0,
        affectedElements: 0,
        byLevel: { A: 0, AA: 0, AAA: 0, unmapped: 0 },
        bestPractice: 0,
        needsManualReview: 0,
      },
      violations: [],
    });
    check(
      '人工檢核：單頁報告列出全部，含超出目標的 AAA',
      pageHtml.includes('需人工檢核（8 項）') &&
        pageHtml.includes('HM2330800E') &&
        pageHtml.includes('GN3330900E'),
    );
    const siteHtml = cli.buildSiteHtml({
      scannedAt: '2026-11-30T00:00:00.000Z',
      source: 'https://example.test/',
      version: '0.0.0',
      targetLevel: 'AA',
      crawl: { mode: 'crawl', pagesFailed: 0, truncated: false },
      siteSummary: cli.aggregate([]),
      pages: [],
    });
    check('人工檢核：全站報告也列出', siteHtml.includes('需人工檢核（8 項）'));
    eq(
      '人工檢核：沒有違規時 --fail-on 離開碼仍是 0（清單不影響離開碼）',
      cli.singlePageExitCode({ byLevel: { A: 0, AA: 0, AAA: 0, unmapped: 0 } }, 'violations', 'AA'),
      0,
    );
  }

  // ===== 局部掃描（--scope／--scope-exclude）：報告頁首寫明範圍，標記不得注入 =====
  {
    const base = {
      scannedAt: '2026-11-30T00:00:00.000Z',
      finalUrl: 'https://example.test/',
      version: '0.0.0',
      targetLevel: 'AA',
      summary: {
        violations: 0,
        affectedElements: 0,
        byLevel: { A: 0, AA: 0, AAA: 0, unmapped: 0 },
        bestPractice: 0,
        needsManualReview: 0,
      },
      violations: [],
    };
    const whole = cli.buildPageHtml({ ...base, scope: null });
    check('局部掃描：整頁掃描的報告沒有範圍列', !whole.includes('檢測範圍'));
    const scoped = cli.buildPageHtml({
      ...base,
      scope: { include: '#main', includeCount: 1, exclude: '.ad', excludeCount: 2 },
    });
    check(
      '局部掃描：報告頁首寫明只掃描與排除',
      scoped.includes('檢測範圍：只掃描 #main、排除 .ad'),
    );
    const evil = cli.buildPageHtml({
      ...base,
      scope: { include: '<img src=x onerror=alert(1)>', includeCount: 1 },
    });
    check(
      '局部掃描：選擇器以文字逸出，不注入報告',
      !evil.includes('<img src=x') && evil.includes('&lt;img'),
    );
    const siteHtml = cli.buildSiteHtml({
      scannedAt: '2026-11-30T00:00:00.000Z',
      source: 'https://example.test/',
      version: '0.0.0',
      targetLevel: 'AA',
      scope: { include: '.modal', exclude: null },
      crawl: { mode: 'crawl', pagesFailed: 0, truncated: false },
      siteSummary: cli.aggregate([]),
      pages: [],
    });
    check('局部掃描：全站報告頁首也寫明範圍', siteHtml.includes('檢測範圍：只掃描 .modal'));
  }

  // ===== 登入後掃描（cli/auth.js）：cookie 檔、自訂標頭、登出網址、憑證不外洩 =====
  {
    const A = require(path.resolve(__dirname, '..', '..', 'cli', 'auth.js'));
    const json = A.parseCookieFile(
      JSON.stringify([
        {
          name: 'sid',
          value: 's3cret',
          domain: '.gov.test',
          path: '/',
          sameSite: 'no_restriction',
          expirationDate: 2000000000,
        },
      ]),
    );
    check(
      'cookie：Chrome 擴充匯出的 JSON（expirationDate、no_restriction）轉成 setCookie 格式',
      json[0].expires === 2000000000 &&
        json[0].sameSite === 'None' &&
        json[0].domain === '.gov.test',
      JSON.stringify(json),
    );
    eq(
      'cookie：{ cookies: [...] } 包一層也認',
      A.parseCookieFile('{"cookies":[{"name":"a","value":"b","domain":"x.test"}]}').length,
      1,
    );
    const ns = A.parseCookieFile(
      '﻿# Netscape HTTP Cookie File\n#HttpOnly_.x.test\tTRUE\t/\tTRUE\t0\tsid\tv\twith-tab\n',
    );
    check(
      'cookie：Netscape cookies.txt（BOM、#HttpOnly_、值裡有 Tab）',
      ns.length === 1 && ns[0].httpOnly && ns[0].secure && ns[0].value === 'v\twith-tab',
      JSON.stringify(ns),
    );
    const throwsMsg = (fn) => {
      try {
        fn();
        return null;
      } catch (e) {
        return e.message;
      }
    };
    const leak = throwsMsg(() => A.parseCookieFile('[{"name":"sid","value":"TOPSECRET"}]'));
    check(
      'cookie：缺 domain 是錯誤，訊息不帶 cookie 值',
      !!leak && leak.includes('domain') && !leak.includes('TOPSECRET'),
      leak,
    );
    check('cookie：壞掉的 JSON 是錯誤', !!throwsMsg(() => A.parseCookieFile('[{"name":')));
    const jsonLeak = throwsMsg(() => A.parseCookieFile('[TOPSECRET-value]'));
    check(
      'cookie：JSON 解析錯誤的訊息不引用輸入（不洩漏 cookie 值）',
      !!jsonLeak && !jsonLeak.includes('TOPSECRET'),
      jsonLeak,
    );
    check('cookie：空檔是錯誤', !!throwsMsg(() => A.parseCookieFile('  ')));
    check(
      'cookie：cookies.txt 欄位不夠是錯誤（指出第幾行）',
      /第 2 行/.test(throwsMsg(() => A.parseCookieFile('# c\nfoo\tbar'))),
    );

    const h = A.parseHeaders(['Authorization: Bearer abc', 'X-Env:  staging ']);
    check(
      '標頭：解析多個、值去頭尾空白',
      h.Authorization === 'Bearer abc' && h['X-Env'] === 'staging',
      JSON.stringify(h),
    );
    check('標頭：沒有冒號是錯誤', !!throwsMsg(() => A.parseHeaders(['Authorization Bearer'])));
    check('標頭：不能改 Host', !!throwsMsg(() => A.parseHeaders(['Host: evil.test'])));
    check(
      '標頭：Cookie 要用 --cookies（會綁網域）',
      /--cookies/.test(throwsMsg(() => A.parseHeaders(['cookie: a=b']))),
    );

    check(
      '登出網址：logout／sign-out／登出／logoff 都認得',
      [
        'https://x.test/logout',
        'https://x.test/a/Sign-Out?x=1',
        'https://x.test/%E7%99%BB%E5%87%BA',
        'https://x.test/user/logoff',
      ].every(A.isLogoutUrl),
    );
    check(
      '登出網址：一般頁面不算',
      !['https://x.test/login', 'https://x.test/blog/outline', 'https://x.test/signup'].some(
        A.isLogoutUrl,
      ),
    );
    eq(
      '報告只記方式：cookies＋header＋profile＋login',
      A.authMethods({
        cookies: 'c.json',
        header: ['A: b'],
        'user-data-dir': 'p',
        login: true,
      }).join(','),
      'cookies,header,profile,login',
    );
    eq('沒登入 → 沒有登入狀態那一行', A.authLine([]), null);

    // visitPage：cookie 在 goto 之前設好；自訂標頭只加給被掃網站的來源
    const seen = [];
    let handler = null;
    const page = {
      setViewport: async () => {},
      setUserAgent: async () => {},
      setBypassCSP: async () => {},
      setCookie: async (...c) => seen.push('cookie:' + c.map((x) => x.name).join(',')),
      setRequestInterception: async (v) => seen.push('intercept:' + v),
      on: (ev, fn) => {
        if (ev === 'request') handler = fn;
      },
      goto: async () => seen.push('goto'),
      title: async () => 't',
      addScriptTag: async () => {},
      evaluate: async () =>
        seen.includes('scan') ? [] : (seen.push('scan'), { violations: [], incomplete: [] }),
      url: () => 'https://gov.test/admin',
      close: async () => {},
    };
    await cli.visitPage({ newPage: async () => page }, 'https://gov.test/admin', {
      timeout: 5000,
      cookies: [{ name: 'sid', value: 'x', domain: 'gov.test' }],
      headers: { Authorization: 'Bearer abc' },
      headerOrigins: new Set(['https://gov.test']),
    });
    check(
      'visitPage：cookie 與攔截在 goto 之前',
      seen.indexOf('cookie:sid') >= 0 &&
        seen.indexOf('intercept:true') >= 0 &&
        seen.indexOf('cookie:sid') < seen.indexOf('goto'),
      seen.join(' → '),
    );
    const sent = [];
    const fakeReq = (url) => ({
      url: () => url,
      headers: () => ({ accept: '*/*' }),
      continue: (o) => sent.push([url, o && o.headers ? o.headers.Authorization || null : null]),
    });
    handler(fakeReq('https://gov.test/api/me'));
    handler(fakeReq('https://cdn.example/lib.js'));
    check(
      'visitPage：標頭只送被掃網站的來源，第三方資源不帶',
      sent[0][1] === 'Bearer abc' && sent[1][1] === null,
      JSON.stringify(sent),
    );
    const html = cli.buildPageHtml({
      scannedAt: '2026-11-30T00:00:00.000Z',
      finalUrl: 'https://gov.test/admin',
      version: '0.0.0',
      targetLevel: 'AA',
      auth: ['cookies', 'header'],
      summary: {
        violations: 0,
        affectedElements: 0,
        byLevel: { A: 0, AA: 0, AAA: 0, unmapped: 0 },
        bestPractice: 0,
        needsManualReview: 0,
      },
      violations: [],
    });
    check(
      '報告頁首寫明登入方式、不含憑證',
      html.includes('登入狀態：以cookie 檔＋自訂標頭掃描') && !html.includes('Bearer'),
    );
  }

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n==== ${results.length - fails}/${results.length} PASS ====`);
  process.exit(fails ? 1 : 0);
})();
