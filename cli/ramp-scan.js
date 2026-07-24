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
const { escapeHtml, resolveMapping, nvdaParts } = require('../shared/report-core.js');

const REPO = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// page.evaluate 沒有 Puppeteer 逾時；掃描/腳本卡住會拖死整個爬蟲，故自行加逾時。
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 逾時（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ===== 參數解析 =====
function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      depth: { type: 'string', default: '0' },
      'max-pages': { type: 'string', default: '50' },
      delay: { type: 'string', default: '250' },
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
  --delay <ms>       每頁間隔，禮貌用（預設 250；設 0 關閉）
  --include <regex>  只爬/掃符合的 URL
  --exclude <regex>  跳過符合的 URL
  --url-list <file>  改掃清單中的 URL（.txt 每行一個，或 PolyMigrate url_inventory.csv）

輸出／執行
  --level <A|AA|AAA> 目標檢測等級（預設 AA）
  --out <dir>        報告輸出目錄（預設 ./ramp-report）
  --format <fmt>     輸出格式 json｜html｜both（預設 json）
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
  // 先正規化 pathname 的尾斜線（含有 query 的網址也才能正確去重）
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  if (u.search) {
    const kept = [...u.searchParams.entries()].filter(
      ([k, v]) => !TRACKING_PREFIXES.some((p) => `${k}=${v}`.toLowerCase().startsWith(p)),
    );
    u.search = new URLSearchParams(kept).toString();
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
    const scan = await withTimeout(
      page.evaluate(async () => await window.__rampA11yScan()),
      opts.timeout,
      '掃描',
    );
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
  const pass = makeFilter(opts.include, opts.exclude);
  const seen = new Set();
  const start = normalizeUrl(startUrl);
  const enqueued = new Set([start]); // 已排入佇列（含未取出者），O(1) 去重
  const queue = [{ url: start, depth: 0 }];
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
          if (enqueued.has(n) || hostOf(n) !== startHost || isAsset(n) || !pass(n)) continue;
          enqueued.add(n);
          queue.push({ url: n, depth: depth + 1 });
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
  // CSV：取 source_url 與 lang 欄。每格先 trim 並去除包住的雙引號——真實盤點常見
  // 「source_url, lang」逗號後帶空白，若不 trim 會使 lang 欄對不到而讓逐語言功能靜默失效。
  const cell = (s) =>
    s == null
      ? ''
      : s
          .trim()
          .replace(/^"(.*)"$/, '$1')
          .trim();
  const header = lines[0].split(',').map((h) => cell(h).toLowerCase());
  const urlIdx = Math.max(0, header.indexOf('source_url'));
  const langIdx = header.indexOf('lang');
  return lines
    .slice(1)
    .map((l) => l.split(',').map(cell))
    .filter((c) => /^https?:\/\//i.test(c[urlIdx] || ''))
    .map((c) => ({ url: c[urlIdx], lang: langIdx >= 0 ? c[langIdx] || '' : '' }));
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
    : `${r.isBestPractice ? '最佳實務建議（非規範必要）' : r.isWcag22 ? 'WCAG 2.2 新增（台灣尚未採用）' : '未對應台灣準則'}・axe ${escapeHtml(r.axeId)}`;
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

function reportHeader(title, lines) {
  return `<header><h1>${escapeHtml(title)}</h1><p class="info">${lines.map(escapeHtml).join('<br>')}</p></header>`;
}

function buildSiteHtml(site) {
  const a = site.siteSummary;
  const time = new Date(site.scannedAt).toLocaleString('zh-TW');
  const tsp = targetSplit(a.byLevel, site.targetLevel);
  const header = reportHeader('Ramp 全站無障礙檢測報告', [
    `檢測來源：${site.source}`,
    `檢測時間：${time}`,
    `模式：${site.crawl.mode}・掃描 ${a.pagesScanned} 頁（失敗 ${site.crawl.pagesFailed}${site.crawl.truncated ? '，達上限截斷' : ''}）`,
    `工具：Ramp（ramp-a11y）v${site.version}・檢測引擎 axe-core 4.10.3`,
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
    `${stats}${langHtml}${topRules}${worst}${perPage}`,
  );
}

function buildPageHtml(out) {
  const time = new Date(out.scannedAt).toLocaleString('zh-TW');
  const s = out.summary;
  const tsp = targetSplit(s.byLevel, out.targetLevel);
  const header = reportHeader('Ramp 無障礙檢測報告', [
    `檢測網址：${out.finalUrl}`,
    `檢測時間：${time}`,
    `工具：Ramp（ramp-a11y）v${out.version}・檢測引擎 axe-core 4.10.3`,
    `目標等級 ${out.targetLevel}：目標內 ${tsp.within} 項・超出目標 ${tsp.beyond} 項（報告仍列出全部）`,
  ]);
  const stats = `<table class="stats">
    <tr><th>違規規則</th><th>受影響元素</th><th>A</th><th>AA</th><th>AAA</th><th>其他</th><th>最佳實務建議</th><th>需人工複核</th></tr>
    <tr><td>${s.violations}</td><td>${s.affectedElements}</td><td>${s.byLevel.A}</td><td>${s.byLevel.AA}</td><td>${s.byLevel.AAA}</td><td>${s.byLevel.unmapped}</td><td>${s.bestPractice}</td><td>${s.needsManualReview}</td></tr>
  </table>`;
  const rulesHtml = out.violations.length
    ? out.violations.map((v) => ruleDetailHtml({ ...v, elements: v.nodeCount })).join('')
    : '<p>未發現自動化可偵測的違規。</p>';
  return docShell(`Ramp 報告 — ${out.finalUrl}`, header, `${stats}<h2>違規明細</h2>${rulesHtml}`);
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
  const { values, url } = parseCliArgs(process.argv.slice(2));
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
  if (urlList && url) {
    console.error(`提醒：已指定 --url-list，位置參數網址 ${url} 將被忽略`);
  }
  const fmtJson = values.format === 'json' || values.format === 'both';
  const fmtHtml = values.format === 'html' || values.format === 'both';
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`--${name} 需為非負數；收到：${v}`);
      process.exit(1);
    }
    return n;
  };
  const opts = {
    depth: Math.floor(num(values.depth, 'depth')),
    maxPages: Math.max(1, Math.floor(num(values['max-pages'], 'max-pages'))),
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
    headless: true,
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
      const base = safeHost(out.finalUrl);
      const written = [];
      if (fmtJson) written.push(writeReport(values.out, base, out));
      if (fmtHtml) written.push(writeHtml(values.out, base, out.scannedAt, buildPageHtml(out)));
      if (!values.quiet) printPageSummary(out);
      console.error(`\n報告已寫入：\n  ${written.join('\n  ')}`);
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
    const written = [];
    if (fmtJson) written.push(writeReport(values.out, base, site));
    if (fmtHtml) written.push(writeHtml(values.out, base, site.scannedAt, buildSiteHtml(site)));
    if (!values.quiet) printSiteSummary(site);
    console.error(`\n報告已寫入：\n  ${written.join('\n  ')}`);
  } finally {
    await browser.close();
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
  parseUrlList,
  aggregate,
  buildSiteHtml,
  buildPageHtml,
};
