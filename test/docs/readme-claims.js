/**
 * README 數字與版本字串守門（test:docs）
 *
 * 動機：README 裡有一批「機器算得出來、但人手寫」的數字與版本字串。它們不會被任何
 * 既有測試碰到，所以會靜默走鐘——實際上也真的走鐘過（test:cli 從 28 項長到 31 項，
 * 兩份 README 都還停在 28）。這支檢查把那些主張釘到真正的來源上。
 *
 * 守三類：
 *   1. 各測試套件的項目數 == 實跑出來的數字（unit／self／cli 在此實跑；
 *      e2e 太慢且需真 Chrome，改由 test/e2e/run-e2e.js 自行呼叫 assertE2eCount）
 *   2. 對應表的三個數字（皆算自 data/rules-map.json）：規則總數、涵蓋的台灣成功
 *      準則數（twGuideline 去重）、標了官方檢測碼的規則數（twCheckCodes 非空）
 *   3. axe-core 版本 == vendor/axe.min.js 內嵌的 axe.version（唯一真相源），
 *      並與 shared/report-core.js 的 AXE_VERSION、兩份 README、THIRD-PARTY-NOTICES 一致
 *
 * 刻意不守的：〈實測案例〉那段的數字。那是掃真實外部政府網站的一次性快照（已標日期
 * 與匿名），網站會改版、會擋爬蟲，拿去 CI 比對只會變成隨機紅燈。專案結構樹與 CLI
 * 選項清單同理暫不守——改動頻率低，成本效益不划算。
 *
 * 錯誤訊息一律直接寫出「哪個檔案第幾行、把 X 改成 Y」，避免這道關卡退化成
 * 「隨手把數字改到過」的儀式。
 *
 * 本檔同時被 test/e2e/run-e2e.js require（取 assertE2eCount），因此所有檢查都包在
 * main() 內，載入時不得有副作用——否則跑 e2e 會連帶重跑三支單元測試。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const DOC_PATHS = ['README.md', 'README.en.md'];

const SUITES = {
  unit: 'test/unit/run-unit.js',
  self: 'test/self-audit/popup-a11y.js',
  cli: 'test/cli/run-cli-unit.js',
};

// ===== 解析 =====

function readDoc(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8').split(/\r?\n/);
}

/** 在文件中找出第一個符合 re 的行，回傳 { line（1-based）, value }；找不到回傳 null。 */
function findClaim(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) return { line: i + 1, value: m[1] };
  }
  return null;
}

/** 產生可直接照做的修正訊息。 */
function fixHint(rel, claim, want) {
  if (!claim) return `${rel} 找不到這條敘述（是不是被改寫掉了？請同步更新本檢查）`;
  return `${rel}:${claim.line} 寫 ${claim.value}，實際是 ${want}（請把該行的 ${claim.value} 改成 ${want}）`;
}

// README 兩種寫法：中文「：47 項」、英文「: 47 checks」
const COUNT_RE = /[:：]\s*(\d+)\s*(?:項|checks)\s*$/;

/** 從 README 的指令區塊解析各套件宣稱的項目數，key 為 unit／self／cli／e2e。 */
function parseDeclaredCounts(rel) {
  const lines = readDoc(rel);
  const out = {};
  lines.forEach((line, i) => {
    const m = line.match(/^npm (?:run test:(unit|self|cli)|(test))\s/);
    if (!m) return;
    const c = line.match(COUNT_RE);
    if (c) out[m[1] || 'e2e'] = { line: i + 1, value: c[1] };
  });
  return out;
}

/** 實跑一支測試 runner，從結尾的「==== N/M PASS ====」取總數 M。 */
function runSuiteTotal(rel) {
  const r = spawnSync(process.execPath, [path.join(REPO, rel)], { encoding: 'utf8', cwd: REPO });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/====\s*(\d+)\/(\d+)\s+PASS\s*====/);
  if (!m) return { error: `${rel} 沒有輸出可解析的「==== N/M PASS ====」（結束碼 ${r.status}）` };
  if (r.status !== 0) {
    return { error: `${rel} 本身有測試失敗（${m[1]}/${m[2]}），請先修好再談數字` };
  }
  return { total: Number(m[2]) };
}

/**
 * e2e 的項目數：這裡不跑（需真 Chrome、開視窗、數十秒），改由 run-e2e.js 跑完後呼叫。
 * @returns {{ ok: boolean, detail: string }}
 */
function assertE2eCount(actualTotal) {
  const bad = [];
  for (const rel of DOC_PATHS) {
    const claim = parseDeclaredCounts(rel).e2e;
    if (!claim || Number(claim.value) !== actualTotal) bad.push(fixHint(rel, claim, actualTotal));
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join('；') : `${actualTotal} 項` };
}

// ===== 檢查本體 =====

function main() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  // --- 1. 測試套件項目數 ---
  const declared = Object.fromEntries(DOC_PATHS.map((rel) => [rel, parseDeclaredCounts(rel)]));
  for (const [key, runner] of Object.entries(SUITES)) {
    const actual = runSuiteTotal(runner);
    if (actual.error) {
      check(`測試數（${key}）`, false, actual.error);
      continue;
    }
    for (const rel of DOC_PATHS) {
      const claim = declared[rel][key];
      const ok = Boolean(claim) && Number(claim.value) === actual.total;
      check(
        `測試數（${key} / ${rel}）`,
        ok,
        ok ? `${actual.total} 項` : fixHint(rel, claim, actual.total),
      );
    }
  }

  // --- 2. 對應表的三個數字 ---
  // 全部算自 data/rules-map.json：改對應表就一定會動到這些數字，而 README 不會
  // 自己跟上。三個都是「加一條規則就可能失準」的類型，所以一起釘住。
  const rulesMap = JSON.parse(fs.readFileSync(path.join(REPO, 'data/rules-map.json'), 'utf8'));
  const zh = readDoc('README.md');
  const en = readDoc('README.en.md');
  const mapClaims = [
    {
      label: '對應表條目總數',
      actual: rulesMap.length,
      found: [
        ['README.md', findClaim(zh, /對應表收錄\s*\*\*(\d+)\s*條\*\*對應條目/)],
        ['README.en.md', findClaim(en, /\*\*(\d+)\s+entries\*\*/)],
      ],
    },
    {
      label: '涵蓋的台灣成功準則數',
      actual: new Set(rulesMap.map((r) => r.twGuideline).filter(Boolean)).size,
      found: [
        ['README.md', findClaim(zh, /成功準則\s*\*\*(\d+)\s*條\*\*/)],
        ['README.en.md', findClaim(en, /across \*\*(\d+)\s+criteria\*\*/)],
      ],
    },
    {
      // 2.4.7（focus-visible）是文件性條目（docOnly），axe 沒有對應的自動化規則——
      // 「可自動化」的準則數必須排除它，否則 README 會把人工項目灌進自動化涵蓋率
      label: '可自動化檢測的準則數（排除 docOnly）',
      actual: new Set(rulesMap.filter((r) => !r.docOnly).map((r) => r.twGuideline)).size,
      found: [
        ['README.md', findClaim(zh, /可自動化檢測的\s*\*{0,2}(\d+)\s*條/)],
        ['README.en.md', findClaim(en, /\*\*(\d+)\s+auto-detectable\*\*/)],
      ],
    },
    {
      label: '標了官方檢測碼的規則數',
      actual: rulesMap.filter((r) => r.twCheckCodes && r.twCheckCodes.length).length,
      found: [
        ['README.md', findClaim(zh, /[:：]\s*(\d+)\s*條規則標示/)],
        ['README.en.md', findClaim(en, /for (\d+) rules — the official inspection code/)],
      ],
    },
  ];
  for (const { label, actual, found } of mapClaims) {
    for (const [rel, claim] of found) {
      const ok = Boolean(claim) && Number(claim.value) === actual;
      check(`${label}（${rel}）`, ok, ok ? `${actual}` : fixHint(rel, claim, actual));
    }
  }

  // --- 2.5 對應表的規則必須真的存在於打包的 axe ---
  // 幽靈規則（對應表有、axe 沒有）永遠不會觸發，README 的涵蓋宣稱會靜默灌水。
  // 文件性條目（docOnly: true，如 2.4.7 focus-visible）是刻意保留的規範對照，豁免。
  // 用 jsdom 真的載入 vendor 的 axe、取 axe.getRules() 的規則集合——過去用字串比對，
  // 「heading」「table」這類常見字在 axe.min.js 裡到處都是，幽靈規則取這種名字就測不出來。
  // jsdom 只在 main() 內載入：本檔被 run-e2e.js require 時不得有副作用
  const axeSrcEarly = fs.readFileSync(path.join(REPO, 'vendor/axe.min.js'), 'utf8');
  const { JSDOM } = require('jsdom');
  const axeDom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  axeDom.window.eval(axeSrcEarly);
  const realRuleIds = new Set(axeDom.window.axe.getRules().map((r) => r.ruleId));
  axeDom.window.close();
  const ghosts = rulesMap
    .filter((r) => !r.docOnly && !realRuleIds.has(r.axeRuleId))
    .map((r) => r.axeRuleId);
  check(
    '對應表規則皆存在於 vendor axe（docOnly 除外）',
    ghosts.length === 0,
    ghosts.length
      ? `vendor/axe.min.js 找不到：${ghosts.join('、')}（移除條目，或確為文件性對照就標 docOnly: true）`
      : `${rulesMap.filter((r) => !r.docOnly).length} 條皆存在`,
  );

  // --- 2.6 engines 宣稱不得低於 puppeteer-core 的實際需求 ---
  // 1.1.0 之後 puppeteer-core 25.x 把下限抬到 Node 22.12，而 engines 還留在 18.17——
  // 使用者裝得起來（EBADENGINE 只是警告）、跑起來才炸。釘住兩者的下限關係。
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const puppeteerPkgPath = path.join(REPO, 'node_modules/puppeteer-core/package.json');
  if (fs.existsSync(puppeteerPkgPath)) {
    const gte = (a, b) =>
      a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
    // 範圍的「最低可裝版本」：取範圍裡所有版本號的最小值（`^20.19 || >=22.12` → 20.19；
    // `>=18` 這種省略寫法補 0）
    const minOf = (range) => {
      const vs = [...String(range || '').matchAll(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/g)].map((m) => [
        Number(m[1]),
        Number(m[2] || 0),
        Number(m[3] || 0),
      ]);
      return vs.length ? vs.reduce((lo, v) => (gte(lo, v) ? v : lo)) : null;
    };
    const ours = minOf(pkg.engines && pkg.engines.node);
    const theirs = minOf(JSON.parse(fs.readFileSync(puppeteerPkgPath, 'utf8')).engines?.node);
    check(
      'engines.node 下限 ≥ puppeteer-core 的需求',
      Boolean(ours && theirs && gte(ours, theirs)),
      ours && theirs
        ? `package.json ${ours.join('.')} vs puppeteer-core ${theirs.join('.')}` +
            (gte(ours, theirs) ? '' : '（請把 package.json 的 engines.node 抬到不低於後者）')
        : '解析不到 engines 範圍，請人工檢查',
    );
  } else {
    check('engines.node 下限 ≥ puppeteer-core 的需求', false, '未安裝 node_modules，請先 npm ci');
  }

  // --- 3. axe-core 版本 ---
  // 真相源：vendor/axe.min.js 內嵌的 axe.version="X.Y.Z"
  const axeSrc = axeSrcEarly;
  const axeMatch = axeSrc.match(/axe\.version\s*=\s*["'](\d+\.\d+\.\d+)["']/);
  const trueAxe = axeMatch ? axeMatch[1] : null;
  check('vendor/axe.min.js 可讀出 axe.version', Boolean(trueAxe), trueAxe || '找不到版本字串');

  if (trueAxe) {
    const { AXE_VERSION } = require(path.join(REPO, 'shared/report-core.js'));
    check(
      'shared/report-core.js 的 AXE_VERSION 與 vendor 一致',
      AXE_VERSION === trueAxe,
      AXE_VERSION === trueAxe
        ? trueAxe
        : `AXE_VERSION 寫 ${AXE_VERSION}，vendor 實際是 ${trueAxe}（報告頁腳會謊報引擎版本）`,
    );

    // 文件內的 axe 版本：只抓明確掛在 axe-core 旁邊的版本號，避免誤抓 WCAG 準則編號
    // （README 裡滿是 1.3.2、4.1.1 這種三段式數字）。
    // 只驗「有寫出來的都要對」，不驗「一定要寫幾次」——措辭改寫不該弄紅 CI。
    const patterns = [
      /axe-core@(\d+\.\d+\.\d+)/g,
      /axe-core[^\n]{0,60}?\bv(\d+\.\d+\.\d+)/g,
      /Version:\s*(\d+\.\d+\.\d+)/g,
    ];
    for (const rel of [...DOC_PATHS, 'THIRD-PARTY-NOTICES.md']) {
      const wrong = [];
      let found = 0;
      readDoc(rel).forEach((line, i) => {
        for (const re of patterns) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(line)) !== null) {
            found++;
            if (m[1] !== trueAxe) wrong.push(`${rel}:${i + 1} 寫 ${m[1]}`);
          }
        }
      });
      check(
        `axe 版本一致（${rel}）`,
        found > 0 && wrong.length === 0,
        found === 0
          ? `${rel} 完全沒提到 axe 版本（是不是被刪掉了？請同步更新本檢查）`
          : wrong.length
            ? `${wrong.join('、')}，實際是 ${trueAxe}`
            : `${found} 處皆為 ${trueAxe}`,
      );
    }
  }

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n==== ${results.length - fails}/${results.length} PASS ====`);
  process.exit(fails ? 1 : 0);
}

module.exports = { assertE2eCount };

if (require.main === module) main();
