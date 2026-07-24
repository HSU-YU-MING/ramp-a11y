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

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n==== ${results.length - fails}/${results.length} PASS ====`);
  process.exit(fails ? 1 : 0);
})();
