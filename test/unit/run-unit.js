/**
 * ramp-a11y 單元測試（純函式，不需真 Chrome）
 *
 * 用法：npm run test:unit（需 devDependency jsdom）
 *
 * 以 jsdom 載入 content/scanner.js，透過 window.__rampA11yInternals 取得內部純函式
 * （NVDA 值／位置／狀態／表格、地標判定、視覺落差偵測），對合成 DOM 逐一驗證。
 * 這些函式不依賴版面（getBoundingClientRect），因此可在 jsdom 快速測試，
 * 補足 e2e（需開真 Chrome、~30-60 秒）在純邏輯上的覆蓋與迭代速度。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
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

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
const doc = window.document;

// 載入 scanner.js：IIFE 會把內部純函式掛到 window.__rampA11yInternals
window.eval(fs.readFileSync(path.join(REPO, 'content/scanner.js'), 'utf8'));
const I = window.__rampA11yInternals;
if (!I) {
  console.error('FATAL: __rampA11yInternals 未定義（scanner.js 未正確載入）');
  process.exit(2);
}

/** 由 HTML 片段建立元素 */
function el(html) {
  const d = doc.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
}
/** 建立並掛進 document（供 getElementById 類函式使用） */
function mount(html) {
  const e = el(html);
  doc.body.appendChild(e);
  return e;
}

// ===== livePoliteness =====
eq(
  'livePoliteness role=alert → assertive',
  I.livePoliteness(el('<div role="alert"></div>')),
  'assertive',
);
eq(
  'livePoliteness aria-live=assertive',
  I.livePoliteness(el('<div aria-live="assertive"></div>')),
  'assertive',
);
eq(
  'livePoliteness aria-live=polite',
  I.livePoliteness(el('<div aria-live="polite"></div>')),
  'polite',
);
eq(
  'livePoliteness aria-live=off → null',
  I.livePoliteness(el('<div aria-live="off"></div>')),
  null,
);
eq(
  'livePoliteness role=status → polite',
  I.livePoliteness(el('<div role="status"></div>')),
  'polite',
);

// ===== nvdaValue =====
eq(
  'nvdaValue textbox 內容',
  I.nvdaValue(el('<input type="text" value="王小明">'), 'textbox'),
  '王小明',
);
eq(
  'nvdaValue password 不朗讀',
  I.nvdaValue(el('<input type="password" value="secret">'), 'textbox'),
  null,
);
eq(
  'nvdaValue select 選中項',
  I.nvdaValue(el('<select><option>甲</option><option selected>乙</option></select>'), 'combobox'),
  '乙',
);
eq(
  'nvdaValue progress → 原始值（真 NVDA 驗證）',
  I.nvdaValue(el('<progress max="100" value="75"></progress>'), 'progressbar'),
  '75',
);
eq(
  'nvdaValue slider',
  I.nvdaValue(el('<input type="range" min="0" max="100" value="30">'), 'slider'),
  '30',
);

// ===== nvdaStates =====
check('nvdaStates 勾選', I.nvdaStates(el('<input type="checkbox" checked>')).includes('勾選'));
check('nvdaStates 展開', I.nvdaStates(el('<div aria-expanded="true"></div>')).includes('展開'));
check(
  'nvdaStates 子功能表(haspopup=menu)',
  I.nvdaStates(el('<button aria-haspopup="menu"></button>')).includes('子功能表'),
);
check('nvdaStates 多行(textarea)', I.nvdaStates(el('<textarea></textarea>')).includes('多行'));
check('nvdaStates 必要的', I.nvdaStates(el('<input required>')).includes('必要的'));
check(
  'nvdaStates 遞增排序',
  I.nvdaStates(el('<div role="columnheader" aria-sort="ascending"></div>')).includes('遞增排序'),
);

// ===== nvdaPosition =====
eq(
  'nvdaPosition aria-posinset/setsize',
  I.nvdaPosition(el('<div aria-posinset="2" aria-setsize="6"></div>'), 'tab'),
  '6 之 2',
);
const ul = el('<ul><li>a</li><li id="t">b</li><li>c</li></ul>');
eq('nvdaPosition 原生 li 計算', I.nvdaPosition(ul.querySelector('#t'), 'listitem'), '3 之 2');

// ===== nvdaItemCount =====
eq(
  'nvdaItemCount list',
  I.nvdaItemCount(el('<ul><li>a</li><li>b</li><li>c</li></ul>'), 'list'),
  '有 3 項',
);
eq(
  'nvdaItemCount listbox 不念（真 NVDA 驗證）',
  I.nvdaItemCount(el('<select multiple><option>a</option></select>'), 'listbox'),
  null,
);

// ===== nvdaDescription =====
const f = mount(
  '<div><input id="f" aria-describedby="h"><span id="h">說明文字</span></div>',
).querySelector('#f');
eq('nvdaDescription aria-describedby', I.nvdaDescription(f, '欄位'), '說明文字');

// ===== nvdaTableCell / nvdaTableDims =====
const tbl = mount(
  '<table><thead><tr><th>月份</th><th>金額</th></tr></thead><tbody><tr><th>一月</th><td id="c">1000</td></tr></tbody></table>',
);
const cell = I.nvdaTableCell(doc.getElementById('c'));
eq('nvdaTableCell 座標', cell && cell.coord, '第 2 列 第 2 欄');
eq('nvdaTableCell 欄標題', cell && cell.colHeader, '金額');
eq('nvdaTableCell 列標題', cell && cell.rowHeader, '一月');
eq('nvdaTableDims（列先欄後）', I.nvdaTableDims(tbl), '表格有 2 列 2 欄'); // 1 表頭列 + 1 資料列

// colspan / rowspan：格點模型應算對座標與維度
const span = mount(
  '<table>' +
    '<tr><th>A</th><th colspan="2">BC</th></tr>' + // row1: A(1,1), BC 跨 (1,2)(1,3)
    '<tr><td rowspan="2">X</td><td>Y</td><td>Z</td></tr>' + // row2: X 跨 (2,1)(3,1), Y(2,2), Z(2,3)
    '<tr><td id="q">Q</td><td>R</td></tr>' + // row3: X 佔 (3,1) → Q(3,2), R(3,3)
    '</table>',
);
eq(
  'nvdaTableCell colspan/rowspan 座標',
  I.nvdaTableCell(doc.getElementById('q')).coord,
  '第 3 列 第 2 欄',
);
eq('nvdaTableDims 含 colspan 欄數', I.nvdaTableDims(span), '表格有 3 列 3 欄');

// ===== roLandmark =====
eq('roLandmark nav', I.roLandmark(el('<nav></nav>')), '導覽區');
eq('roLandmark section 無名 → null', I.roLandmark(el('<section></section>')), null);
eq(
  'roLandmark section 具名 → 區域',
  I.roLandmark(el('<section aria-label="側欄"></section>')),
  '區域',
);
eq('roLandmark role=main', I.roLandmark(el('<div role="main"></div>')), '主要內容區');

// roBoundary：清單邊界
const ub = I.roBoundary(el('<ul><li>a</li><li>b</li></ul>'));
eq('roBoundary 清單 enter', ub && ub.kind === 'list' && ub.enter, '清單 有 2 項');
eq('roBoundary 清單 exit', ub && ub.exit, '離開清單');
// roBoundary：地標含「地標」後綴（真 NVDA 播報格式）、listbox 不當清單邊界
const nb = I.roBoundary(el('<nav aria-label="主選單"></nav>'));
eq('roBoundary 地標 enter（含後綴）', nb && nb.enter, '主選單 導覽區 地標');
eq(
  'roBoundary select 非邊界',
  I.roBoundary(el('<select multiple><option>a</option></select>')),
  null,
);

// ===== roComputeFlags（視覺落差：同列反序）=====
const swapped = [
  { rect: { top: 0, left: 100, w: 50, h: 20 }, flagged: false }, // read 0，視覺在右
  { rect: { top: 0, left: 0, w: 50, h: 20 }, flagged: false }, // read 1，視覺在左 → 反序
  { rect: { top: 40, left: 0, w: 50, h: 20 }, flagged: false }, // read 2，另一列
];
const fc = I.roComputeFlags(swapped);
check(
  'roComputeFlags 同列反序 → 標記兩個',
  fc === 2 && swapped[0].flagged && swapped[1].flagged && !swapped[2].flagged,
  'flaggedCount=' + fc,
);
const ordered = [
  { rect: { top: 0, left: 0, w: 50, h: 20 }, flagged: false },
  { rect: { top: 0, left: 100, w: 50, h: 20 }, flagged: false },
];
check('roComputeFlags 正常順序 → 不標記', I.roComputeFlags(ordered) === 0);

// ===== 共用模組 shared/report-core.js（擴充套件與 CLI 共用，防漂移）=====
const RampShared = require(path.join(REPO, 'shared/report-core.js'));
const rmap = new Map(
  JSON.parse(fs.readFileSync(path.join(REPO, 'data/rules-map.json'), 'utf8')).map((r) => [
    r.axeRuleId,
    r,
  ]),
);
const mappedRule = RampShared.resolveMapping(
  { id: 'image-alt', tags: ['wcag2a'], help: 'h', description: 'd' },
  rmap,
);
eq('resolveMapping 對應規則 → 台灣準則', mappedRule.guideline, '1.1.1');
eq('resolveMapping 對應規則 → 等級', mappedRule.level, 'A');
check('resolveMapping 對應規則 mapped=true', mappedRule.mapped === true);
const unmappedRule = RampShared.resolveMapping(
  { id: 'no-such-rule', tags: [], help: 'H', description: 'D' },
  rmap,
);
check(
  'resolveMapping 未對應 → mapped=false、title 用 help',
  unmappedRule.mapped === false && unmappedRule.title === 'H',
);
check(
  'resolveMapping best-practice 標記',
  RampShared.resolveMapping({ id: 'x', tags: ['best-practice'], help: '', description: '' }, rmap)
    .isBestPractice === true,
);
check(
  'resolveMapping wcag22 標記',
  RampShared.resolveMapping(
    { id: 'target-size', tags: ['wcag22aa'], help: '', description: '' },
    rmap,
  ).isWcag22 === true,
);
eq(
  'nvdaParts 組合順序',
  RampShared.nvdaParts({ name: '帳號', role: '編輯區', value: 'user', states: ['必要的'] }).join(
    '/',
  ),
  '帳號/編輯區/user/必要的',
);
eq('nvdaParts null → 空陣列', RampShared.nvdaParts(null).length, 0);

// ===== 版本一致性（manifest 與 package 不得漂移）=====
const mf = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
eq('版本一致（manifest === package）', mf.version, pkg.version);

// ===== rules-map 資料完整性：twLevel 只能是 A/AA/AAA =====
// CLI 的全站彙整以「不重複規則依等級」計數，並要求 A+AA+AAA+unmapped === 失敗規則總數；
// 若某條 twLevel 出現髒值（如 "AA " 或 "1"），統計會與規則數靜默對不上，故在此把關。
const rmapList = JSON.parse(fs.readFileSync(path.join(REPO, 'data/rules-map.json'), 'utf8'));
const badLevels = rmapList.filter((r) => !['A', 'AA', 'AAA'].includes(r.twLevel));
check(
  'rules-map twLevel 皆為 A/AA/AAA',
  badLevels.length === 0,
  badLevels.map((r) => `${r.axeRuleId}:${JSON.stringify(r.twLevel)}`).join(', '),
);

const fails = results.filter((r) => !r.ok).length;
console.log(`\n==== ${results.length - fails}/${results.length} PASS ====`);
process.exit(fails ? 1 : 0);
