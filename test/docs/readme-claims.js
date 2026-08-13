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
 *   2. 官方檢測碼規則數 == data/rules-map.json 裡 twCheckCodes 非空的條數
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

  // --- 2. 官方檢測碼規則數 ---
  const rulesMap = JSON.parse(fs.readFileSync(path.join(REPO, 'data/rules-map.json'), 'utf8'));
  const withCode = rulesMap.filter((r) => r.twCheckCodes && r.twCheckCodes.length).length;
  const codeClaims = [
    ['README.md', findClaim(readDoc('README.md'), /[:：]\s*(\d+)\s*條規則標示/)],
    [
      'README.en.md',
      findClaim(readDoc('README.en.md'), /for (\d+) rules — the official inspection code/),
    ],
  ];
  for (const [rel, claim] of codeClaims) {
    const ok = Boolean(claim) && Number(claim.value) === withCode;
    check(`官方檢測碼規則數（${rel}）`, ok, ok ? `${withCode} 條` : fixHint(rel, claim, withCode));
  }

  // --- 3. axe-core 版本 ---
  // 真相源：vendor/axe.min.js 內嵌的 axe.version="X.Y.Z"
  const axeSrc = fs.readFileSync(path.join(REPO, 'vendor/axe.min.js'), 'utf8');
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
