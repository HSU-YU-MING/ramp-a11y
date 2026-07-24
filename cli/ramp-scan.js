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
 * 注意：translateRule 目前與 popup.js 各持一份，M4 會抽成共用純函式模組以防漂移。
 */
'use strict';

const { parseArgs } = require('node:util');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const REPO = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 參數解析 =====
function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      depth: { type: 'string', default: '0' },
      'max-pages': { type: 'string', default: '50' },
      delay: { type: 'string', default: '0' },
      include: { type: 'string' },
      exclude: { type: 'string' },
      'url-list': { type: 'string' },
      level: { type: 'string', default: 'AA' },
      out: { type: 'string', default: './ramp-report' },
      format: { type: 'string', default: 'json' },
      chrome: { type: 'string' },
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
  --delay <ms>       每頁間隔，禮貌用（預設 0）
  --include <regex>  只爬/掃符合的 URL
  --exclude <regex>  跳過符合的 URL
  --url-list <file>  改掃清單中的 URL（.txt 每行一個，或 PolyMigrate url_inventory.csv）

輸出／執行
  --level <A|AA|AAA> 目標檢測等級（預設 AA）
  --out <dir>        報告輸出目錄（預設 ./ramp-report）
  --format <json>    輸出格式（目前 json；html 待 M3）
  --chrome <path>    指定 Chrome（等同 CHROME_PATH）
  --timeout <ms>     單頁載入逾時（預設 60000）
  --quiet            只寫檔、不印摘要
  --help             顯示此說明
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
  if (u.search) {
    const kept = [...u.searchParams.entries()].filter(
      ([k, v]) => !TRACKING_PREFIXES.some((p) => `${k}=${v}`.toLowerCase().startsWith(p)),
    );
    u.search = new URLSearchParams(kept).toString();
  }
  let s = u.toString();
  if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
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

// ===== rules-map 轉譯（與 popup.js translateRule 對齊；M4 將抽共用模組）=====
const rulesList = JSON.parse(fs.readFileSync(path.join(REPO, 'data/rules-map.json'), 'utf8'));
const rulesMap = new Map(
  (Array.isArray(rulesList) ? rulesList : Object.values(rulesList)).map((r) => [r.axeRuleId, r]),
);

function translateRule(rule) {
  const map = rulesMap.get(rule.id);
  const common = {
    axeId: rule.id,
    impact: rule.impact || null,
    nodeCount: rule.nodeCount != null ? rule.nodeCount : rule.nodes.length,
    isBestPractice: (rule.tags || []).includes('best-practice'),
    isWcag22: (rule.tags || []).some((t) => /^wcag22a{1,3}$/.test(t)),
    sampleTargets: rule.nodes.slice(0, 5).map((n) => n.target),
    sampleNvda: (rule.nodes.find((n) => n.nvda) || {}).nvda || null,
  };
  if (map) {
    return {
      ...common,
      mapped: true,
      level: map.twLevel,
      title: map.titleZh,
      guideline: map.twGuideline,
      guidelineName: map.twGuidelineName || '',
      category: map.category,
      why: map.whyZh,
      how: map.howZh,
      note: map.noteZh || null,
      checkCodes: map.twCheckCodes || [],
    };
  }
  return {
    ...common,
    mapped: false,
    level: null,
    title: rule.help,
    guideline: null,
    category: null,
    why: rule.description,
    how: null,
    note: null,
    checkCodes: [],
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
  };
}

// ===== 訪問單一頁面：載入 → 掃描 → 蒐集連結 =====
const INJECT = ['vendor/axe.min.js', 'vendor/axe-locale-zh_TW.js', 'content/scanner.js'];
async function visitPage(browser, url, opts) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (compatible; ramp-scan/0.2; +https://github.com/HSU-YU-MING/ramp-a11y)',
    );
    await page.goto(url, { waitUntil: 'networkidle2', timeout: opts.timeout });
    const title = await page.title();
    for (const f of INJECT) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
    }
    const scan = await page.evaluate(async () => await window.__rampA11yScan());
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].map((a) => a.href),
    );
    return { report: buildPageReport(url, page.url(), title, scan), links };
  } finally {
    await page.close();
  }
}

// ===== 全站 BFS 爬取 =====
async function crawlSite(browser, startUrl, opts, log) {
  const startHost = hostOf(startUrl);
  const pass = makeFilter(opts.include, opts.exclude);
  const seen = new Set();
  const queue = [{ url: normalizeUrl(startUrl), depth: 0 }];
  const pages = [];
  let failed = 0;

  while (queue.length && pages.length < opts.maxPages) {
    const { url, depth } = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    if (pages.length > 0 && opts.delay) await sleep(opts.delay);

    try {
      const { report, links } = await visitPage(browser, url, opts);
      report.depth = depth;
      report.ok = true;
      pages.push(report);
      log(`[${pages.length}] ${url} — 違規 ${report.summary.violations}`);
      if (depth < opts.depth) {
        for (const raw of links) {
          const n = normalizeUrl(raw);
          if (seen.has(n) || hostOf(n) !== startHost || isAsset(n) || !pass(n)) continue;
          if (!queue.some((q) => q.url === n)) queue.push({ url: n, depth: depth + 1 });
        }
      }
    } catch (e) {
      pages.push({ url, depth, ok: false, error: e.message });
      failed += 1;
      log(`[x] ${url} — ${e.message}`);
    }
  }
  return { pages, failed, truncated: queue.length > 0 };
}

// ===== URL 清單解析（相容 PolyMigrate url_inventory.csv）=====
function parseUrlList(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const looksCsv = file.toLowerCase().endsWith('.csv') || /(^|,)source_url(,|$)/i.test(lines[0]);
  if (!looksCsv) {
    return lines.filter((l) => !l.startsWith('#')).map((l) => ({ url: l.trim(), lang: '' }));
  }
  // CSV：取 source_url（欄 0）與 lang（欄 1）；URL 與語言別不含逗號，簡單切分即可
  const header = lines[0].toLowerCase().split(',');
  const urlIdx = Math.max(0, header.indexOf('source_url'));
  const langIdx = header.indexOf('lang');
  return lines
    .slice(1)
    .map((l) => l.split(','))
    .filter((c) => c[urlIdx] && /^https?:\/\//i.test(c[urlIdx]))
    .map((c) => ({ url: c[urlIdx].trim(), lang: langIdx >= 0 ? (c[langIdx] || '').trim() : '' }));
}

async function scanList(browser, entries, opts, log) {
  const pass = makeFilter(opts.include, opts.exclude);
  const pages = [];
  let failed = 0;
  const targets = entries.filter((e) => pass(e.url)).slice(0, opts.maxPages);
  for (const { url, lang } of targets) {
    if (pages.length > 0 && opts.delay) await sleep(opts.delay);
    try {
      const { report } = await visitPage(browser, normalizeUrl(url), opts);
      report.lang = lang || undefined;
      report.ok = true;
      pages.push(report);
      log(
        `[${pages.length}/${targets.length}]${lang ? ` (${lang})` : ''} ${url} — 違規 ${report.summary.violations}`,
      );
    } catch (e) {
      pages.push({ url, lang: lang || undefined, ok: false, error: e.message });
      failed += 1;
      log(`[x] ${url} — ${e.message}`);
    }
  }
  return { pages, failed, truncated: entries.length > targets.length };
}

// ===== 彙整 =====
function aggregate(pages) {
  const ok = pages.filter((p) => p.ok !== false);
  const byLevel = { A: 0, AA: 0, AAA: 0, unmapped: 0 };
  const rules = new Map(); // axeId -> { title, guideline, level, pages, elements }
  let affected = 0;
  let manualReview = 0;
  let bestPractice = 0;
  ok.forEach((p) => {
    p.violations.forEach((v) => {
      if (v.mapped) byLevel[v.level] = (byLevel[v.level] || 0) + 1;
      else byLevel.unmapped += 1;
      affected += v.nodeCount;
      const r = rules.get(v.axeId) || {
        axeId: v.axeId,
        title: v.title,
        guideline: v.guideline,
        level: v.level,
        pages: 0,
        elements: 0,
      };
      r.pages += 1;
      r.elements += v.nodeCount;
      rules.set(v.axeId, r);
    });
    manualReview += p.summary.needsManualReview;
    bestPractice += p.summary.bestPractice;
  });
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
  console.log(`  最佳實務建議  ${s.bestPractice}`);
  console.log(`  需人工複核    ${s.needsManualReview}`);
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
  console.log(`  需人工複核    ${a.needsManualReviewTotal}`);
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

// ===== 輸出 =====
function writeReport(outDir, baseName, report) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = report.scannedAt.replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${baseName}-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
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
  const { values, url } = parseCliArgs(process.argv.slice(2));
  const urlList = values['url-list'];
  if (values.help || (!url && !urlList)) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  if (values.format !== 'json') {
    console.error(`目前僅支援 --format json（html 待 M3）；收到：${values.format}`);
    process.exit(1);
  }
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`--${name} 需為非負數；收到：${v}`);
      process.exit(1);
    }
    return n;
  };
  const opts = {
    depth: num(values.depth, 'depth'),
    maxPages: Math.max(1, num(values['max-pages'], 'max-pages')),
    delay: num(values.delay, 'delay'),
    include: values.include,
    exclude: values.exclude,
    timeout: Math.max(1, num(values.timeout, 'timeout')),
    chrome: values.chrome,
  };
  const log = values.quiet ? () => {} : (m) => console.error(m);
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const started = Date.now();

  const browser = await puppeteer.launch({
    executablePath: findChrome(opts.chrome),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    // 模式判定
    const multi = !!urlList || opts.depth >= 1;

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
      };
      const outFile = writeReport(values.out, safeHost(out.finalUrl), out);
      if (!values.quiet) printPageSummary(out);
      console.error(`\n報告已寫入 ${outFile}`);
      return;
    }

    // 多頁：爬蟲 或 URL 清單
    let result;
    let source;
    let mode;
    if (urlList) {
      mode = 'url-list';
      source = urlList;
      const entries = parseUrlList(urlList);
      if (!entries.length) {
        console.error(`--url-list 未解析出任何 URL：${urlList}`);
        process.exit(1);
      }
      log(`從清單掃描 ${Math.min(entries.length, opts.maxPages)} 個 URL（來源 ${urlList}）…`);
      result = await scanList(browser, entries, opts, log);
    } else {
      mode = 'crawl';
      source = url;
      log(`自 ${url} 爬取（深度 ${opts.depth}、上限 ${opts.maxPages}）…`);
      result = await crawlSite(browser, url, opts, log);
    }

    const site = {
      tool: 'ramp-scan',
      version,
      scannedAt: new Date(started).toISOString(),
      targetLevel: values.level,
      source,
      crawl: {
        mode,
        pagesScanned: result.pages.filter((p) => p.ok !== false).length,
        pagesFailed: result.failed,
        maxDepth: opts.depth,
        maxPages: opts.maxPages,
        truncated: result.truncated,
      },
      siteSummary: aggregate(result.pages),
      byLanguage: aggregateByLanguage(result.pages),
      pages: result.pages,
    };
    if (!site.byLanguage) delete site.byLanguage;

    const base = mode === 'crawl' ? safeHost(source) + '-site' : 'urllist';
    const outFile = writeReport(values.out, base, site);
    if (!values.quiet) printSiteSummary(site);
    console.error(`\n報告已寫入 ${outFile}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('SCAN ERROR:', e.message);
  process.exit(2);
});
