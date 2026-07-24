#!/usr/bin/env node
/**
 * ramp-scan — 全站爬掃 CLI（M1：單一 URL）
 *
 * 用法：node cli/ramp-scan.js <url> [options]
 *   --level <A|AA|AAA>  目標檢測等級（預設 AA，僅記錄於輸出，M1 不做過濾）
 *   --out <dir>         JSON 報告輸出目錄（預設 ./ramp-report）
 *   --format <json>     輸出格式（M1 僅支援 json；html 待 M3）
 *   --chrome <path>     指定 Chrome 執行檔（等同 CHROME_PATH）
 *   --timeout <ms>      單頁載入逾時（預設 60000）
 *   --quiet             不印主控台摘要，只寫檔
 *   --help              顯示說明
 *
 * 以 headless Chrome 導覽目標網址，注入 repo 內真正的 vendor/axe.min.js、
 * vendor/axe-locale-zh_TW.js 與 content/scanner.js，呼叫 window.__rampA11yScan()
 * （與擴充套件 popup 相同的程式路徑），再用 data/rules-map.json 轉譯為台灣規範。
 *
 * 產出的 JSON 即「逐頁報告單元」，M2 的爬蟲會蒐集多頁此結構後彙整。
 * 注意：translateRule 目前與 popup.js 各持一份，M4 會抽成共用純函式模組以防漂移。
 */
'use strict';

const { parseArgs } = require('node:util');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const REPO = path.resolve(__dirname, '..');

// ===== 參數解析 =====
function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
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

const HELP = `ramp-scan — 全站爬掃 CLI（M1：單一 URL）

用法：node cli/ramp-scan.js <url> [options]

  --level <A|AA|AAA>  目標檢測等級（預設 AA）
  --out <dir>         JSON 報告輸出目錄（預設 ./ramp-report）
  --format <json>     輸出格式（M1 僅 json）
  --chrome <path>     指定 Chrome 執行檔（等同 CHROME_PATH）
  --timeout <ms>      單頁載入逾時（預設 60000）
  --quiet             只寫檔、不印摘要
  --help              顯示此說明
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
    // 逐頁報告只保留少量代表元素，避免 JSON 過大（掃描端已上限 20 個）
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

// ===== 掃描單一頁面 =====
async function scanUrl(url, opts) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(opts.chrome),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (compatible; ramp-scan/0.1; +https://github.com/HSU-YU-MING/ramp-a11y)',
    );
    await page.goto(url, { waitUntil: 'networkidle2', timeout: opts.timeout });
    const title = await page.title();

    for (const f of ['vendor/axe.min.js', 'vendor/axe-locale-zh_TW.js', 'content/scanner.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
    }
    const scan = await page.evaluate(async () => await window.__rampA11yScan());

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
      finalUrl: page.url(),
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
  } finally {
    await browser.close();
  }
}

// ===== 主控台摘要 =====
function printSummary(report) {
  const s = report.summary;
  const line = (label, val) => console.log('  ' + label.padEnd(14) + val);
  console.log('\n── Ramp 檢測摘要 ──');
  console.log('  ' + report.title);
  console.log('  ' + report.finalUrl + '\n');
  line('違規規則', `${s.violations}（受影響元素 ${s.affectedElements}）`);
  line(
    '  依等級',
    `A ${s.byLevel.A} · AA ${s.byLevel.AA} · AAA ${s.byLevel.AAA}` +
      (s.byLevel.unmapped ? ` · 其他 ${s.byLevel.unmapped}` : ''),
  );
  line('最佳實務建議', String(s.bestPractice));
  line('需人工複核', String(s.needsManualReview));
  if (report.violations.length) {
    console.log('\n  前幾大違規：');
    report.violations.slice(0, 8).forEach((v) => {
      console.log(
        `    • ${v.title}（${v.guideline || '未對應'}/${v.level || '—'}/${v.impact}）× ${v.nodeCount}`,
      );
    });
  }
}

// ===== 進入點 =====
async function main() {
  const { values, url } = parseCliArgs(process.argv.slice(2));
  if (values.help || !url) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  if (values.format !== 'json') {
    console.error(`M1 僅支援 --format json（html 待 M3）；收到：${values.format}`);
    process.exit(1);
  }
  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    console.error(`--timeout 需為正整數毫秒；收到：${values.timeout}`);
    process.exit(1);
  }

  const started = Date.now();
  if (!values.quiet) console.error(`掃描 ${url} …`);
  const page = await scanUrl(url, { chrome: values.chrome, timeout });

  const report = {
    tool: 'ramp-scan',
    version: JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version,
    scannedAt: new Date(started).toISOString(),
    targetLevel: values.level,
    ...page,
  };

  fs.mkdirSync(values.out, { recursive: true });
  const host = (() => {
    try {
      return new URL(report.finalUrl).hostname;
    } catch {
      return 'page';
    }
  })();
  const stamp = report.scannedAt.replace(/[:.]/g, '-');
  const outFile = path.join(values.out, `${host}-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  if (!values.quiet) printSummary(report);
  console.error(`\n報告已寫入 ${outFile}`);
}

main().catch((e) => {
  console.error('SCAN ERROR:', e.message);
  process.exit(2);
});
