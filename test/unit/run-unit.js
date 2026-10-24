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
eq(
  'livePoliteness aria-live 無效值 → null（視同 off）',
  I.livePoliteness(el('<div aria-live=""></div>')),
  null,
);
eq('livePoliteness output → polite', I.livePoliteness(el('<output></output>')), 'polite');

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

// ===== isPresentational／presentation 表格與清單（NVDA 不播被拔除的語義）=====
check(
  'isPresentational role=presentation',
  I.isPresentational(el('<table role="presentation"></table>')) === true,
);
check('isPresentational 無 role', I.isPresentational(el('<table></table>')) === false);
const ptbl = mount(
  '<table role="presentation"><tr><th>A</th></tr><tr><td id="pc">B</td></tr></table>',
);
eq('nvdaTableDims presentation → null', I.nvdaTableDims(ptbl), null);
eq('nvdaTableCell presentation → null', I.nvdaTableCell(doc.getElementById('pc')), null);
eq(
  'roBoundary 表格 presentation → null',
  I.roBoundary(el('<table role="presentation"><tr><td>x</td></tr></table>')),
  null,
);
eq(
  'roBoundary 清單 presentation → null',
  I.roBoundary(el('<ul role="presentation"><li>a</li></ul>')),
  null,
);

// 呈現性角色衝突解決：帶全域 ARIA 屬性時 presentation 被忽略（真 NVDA 對照證實仍念地標）
check(
  'isPresentational 帶 aria-label → 不算（衝突解決）',
  I.isPresentational(el('<nav role="presentation" aria-label="x"></nav>')) === false,
);
eq(
  'roLandmark nav presentation＋aria-label → 仍是導覽區',
  I.roLandmark(el('<nav role="presentation" aria-label="假導覽"></nav>')),
  '導覽區',
);

// 表頭列（整列都是 th）的格子不帶列標題（真 NVDA：「第 2 欄, 數量」不念「品項」）
mount(
  '<table><tr><th>品項</th><th id="h2">數量</th></tr><tr><th>一月</th><td id="d2">3</td></tr></table>',
);
eq('nvdaTableCell 表頭列不帶列標題', I.nvdaTableCell(doc.getElementById('h2')).rowHeader, null);
eq('nvdaTableCell 資料列仍帶列標題', I.nvdaTableCell(doc.getElementById('d2')).rowHeader, '一月');

// inline SVG：有名稱才是物件停點（真 NVDA：無名稱的裝飾 SVG 完全不念）
const svgNamed = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
svgNamed.setAttribute('aria-label', '營收圖表');
const svgBare = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
check('roIsObject 有名稱的 SVG（小寫 tagName）→ 停點', I.roIsObject(svgNamed) === true);
check('roIsObject 無名稱的裝飾 SVG → 非停點', I.roIsObject(svgBare) === false);

// ===== ariaListItemCount：巢狀 ARIA 清單只數直屬項目 =====
const nestedList = el(
  '<div role="list"><div role="listitem">a</div>' +
    '<div role="list"><div role="listitem">b</div><div role="listitem">c</div></div></div>',
);
eq('ariaListItemCount 巢狀只數直屬', I.ariaListItemCount(nestedList), 1);
eq('nvdaItemCount 巢狀 ARIA 清單', I.nvdaItemCount(nestedList, 'list'), '有 1 項');

// ===== nvdaPosition：radio 以所屬表單為範圍（同名群組可存在於不同 form）=====
const twoForms = mount(
  '<div><form><input type="radio" name="g" id="r1"><input type="radio" name="g"></form>' +
    '<form><input type="radio" name="g"><input type="radio" name="g"><input type="radio" name="g"></form></div>',
);
eq(
  'nvdaPosition radio 以所屬表單為範圍',
  I.nvdaPosition(twoForms.querySelector('#r1'), 'radio'),
  '2 之 1',
);

// ===== roLandmark =====
eq('roLandmark nav', I.roLandmark(el('<nav></nav>')), '導覽區');
eq('roLandmark section 無名 → null', I.roLandmark(el('<section></section>')), null);
eq(
  'roLandmark section 具名 → 區域',
  I.roLandmark(el('<section aria-label="側欄"></section>')),
  '區域',
);
eq('roLandmark role=main', I.roLandmark(el('<div role="main"></div>')), '主要內容區');
eq(
  'roLandmark nav role=presentation → null',
  I.roLandmark(el('<nav role="presentation"></nav>')),
  null,
);

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

// ===================================================================================
// 2026-10 第二輪：對抗式審查的變異測試顯示以下行為「改壞了也沒有測試會紅」，逐一釘住。
// 涉及 NVDA 行為的預期值都來自真 NVDA 對照（test/nvda/README.md 的 2026-10 結果表）。
// ===================================================================================

// ----- presentation 衝突解決：完整的全域屬性、空值、可聚焦 -----
check(
  'isPresentational aria-description 也觸發衝突解決',
  I.isPresentational(el('<nav role="none" aria-description="x"></nav>')) === false,
);
check(
  'isPresentational aria-current 也觸發',
  I.isPresentational(el('<nav role="none" aria-current="page"></nav>')) === false,
);
check(
  'isPresentational tabindex（可聚焦）也觸發',
  I.isPresentational(el('<table role="presentation" tabindex="-1"></table>')) === false,
);
check(
  'isPresentational contenteditable 也觸發',
  I.isPresentational(el('<div role="presentation" contenteditable="true"></div>')) === false,
);
check(
  'isPresentational 空值的 aria-label 視同沒寫',
  I.isPresentational(el('<table role="presentation" aria-label=""></table>')) === true,
);

// ----- 朗讀順序：presentation 清單／表格的語義全部拔除（含「li 裡只有連結」的選單）-----
/** 在「只有這段 HTML」的 body 上線性化（先把前面測試掛上去的元素暫時移走再放回） */
function roStops(html) {
  const parked = Array.from(doc.body.childNodes);
  parked.forEach((n) => n.remove());
  const host = mount(`<div>${html}</div>`);
  const ro = window.__rampA11yReadingOrder();
  host.remove();
  parked.forEach((n) => doc.body.appendChild(n));
  return ro.stops;
}
const menuStops = roStops(
  '<ul role="presentation"><li><a href="#1">選單一</a></li><li><a href="#2">選單二</a></li></ul>',
);
const menuLink = menuStops.find(
  (s) => s.name === '選單一' || s.role === 'a' || s.kind === 'object',
);
check(
  '朗讀順序 presentation 選單的連結不帶「N 之 M」（真 NVDA 證實）',
  !!menuLink && !menuLink.position,
  JSON.stringify(menuLink),
);
const plainMenuLink = roStops(
  '<ul><li><a href="#1">一</a></li><li><a href="#2">二</a></li></ul>',
).find((s) => s.kind === 'object');
eq('朗讀順序 一般清單的連結仍帶位置（對照組）', plainMenuLink && plainMenuLink.position, '2 之 1');
const pLi = roStops('<ul role="presentation"><li>排版甲</li></ul>').find(
  (s) => s.text === '排版甲',
);
eq('朗讀順序 presentation 清單的 li → 「文字」而非清單項目', pLi && pLi.role, '文字');
const pLis = roStops('<ul role="presentation"><li>排版甲</li><li>排版乙</li></ul>');
check(
  '朗讀順序 presentation 清單的純文字 li 不帶「N 之 M」',
  pLis.filter((s) => /排版/.test(s.text || '')).every((s) => !s.position),
  JSON.stringify(pLis.map((s) => s.position)),
);
const nLis = roStops('<ul><li>一般甲</li><li>一般乙</li></ul>');
eq(
  '朗讀順序 一般清單的純文字 li 仍帶位置（對照組）',
  (nLis.find((s) => s.text === '一般甲') || {}).position,
  '2 之 1',
);

const pTd = roStops('<table role="presentation"><tr><td>格子</td></tr></table>').find(
  (s) => s.text === '格子',
);
eq('朗讀順序 presentation 表格的 td → 「文字」而非儲存格', pTd && pTd.role, '文字');
check('朗讀順序 presentation 表格的 td 沒有座標', pTd && !pTd.position);

// ----- SVG：命名來源與「無名稱裝飾 SVG 不念」（真 NVDA 證實）-----
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(build) {
  const s = doc.createElementNS(SVGNS, 'svg');
  build(s);
  doc.body.appendChild(s);
  return s;
}
const svgTitle = svg((s) => {
  const t = doc.createElementNS(SVGNS, 'title');
  t.textContent = '標題命名的圖';
  s.appendChild(t);
});
eq('roSvgName 直屬 <title>', I.roSvgName(svgTitle), '標題命名的圖');
mount('<span id="svglbl">參照命名的圖</span>');
const svgRef = svg((s) => s.setAttribute('aria-labelledby', 'svglbl'));
eq('roSvgName aria-labelledby 參照的文字', I.roSvgName(svgRef), '參照命名的圖');
const svgText = svg((s) => {
  const t = doc.createElementNS(SVGNS, 'text');
  t.textContent = '裝飾內文';
  s.appendChild(t);
});
eq('roSvgName 內含 <text> → 內文成為名稱', I.roSvgName(svgText), '裝飾內文');
check('roIsObject 內含 <text> 的 SVG 是物件停點', I.roIsObject(svgText) === true);
const svgStops = (() => {
  const ro = window.__rampA11yReadingOrder();
  return ro.stops.filter((s) => s.kind === 'object' && s.role === '圖片');
})();
check(
  '朗讀順序 裸 SVG 角色為「圖片」且帶名稱（真 NVDA：圖片, 標題命名的圖）',
  svgStops.some((s) => s.name === '標題命名的圖') && svgStops.some((s) => s.name === '裝飾內文'),
  svgStops.map((s) => s.name).join('、'),
);
[svgTitle, svgRef, svgText].forEach((s) => s.remove());

// ----- 表格格點快取：每次掃描／線性化都要重建（頁面表格變動後不能拿舊格點）-----
const gridTbl = mount('<table><tr><td>a</td></tr><tr><td id="gcell">b</td></tr></table>');
eq('tableGrid 初始列數', I.tableGrid(gridTbl).rowCount, 2);
gridTbl.insertRow(0).insertCell(0).textContent = 'new';
window.__rampA11yReadingOrder();
eq('__rampA11yReadingOrder 會重建格點快取', I.tableGrid(gridTbl).rowCount, 3);
gridTbl.insertRow(0).insertCell(0).textContent = 'new2';
window.axe = {
  run: async () => ({ violations: [], incomplete: [] }),
  setup: () => {},
  teardown: () => {},
};
const scanDone = window.__rampA11yScan().then(() => {
  eq('__rampA11yScan 會重建格點快取', I.tableGrid(gridTbl).rowCount, 4);
  delete window.axe;
  gridTbl.remove();
});

// ----- checkVisibility：兩個同義選項名都要傳（Chrome 105–120 只認 checkVisibilityCSS）-----
const cvEl = doc.createElement('div');
let cvOpts = null;
cvEl.checkVisibility = (o) => {
  cvOpts = o;
  return true;
};
doc.body.appendChild(cvEl);
I.roIsHidden(cvEl);
check(
  'roIsHidden 同時傳 checkVisibilityCSS 與 visibilityProperty',
  !!cvOpts && cvOpts.checkVisibilityCSS === true && cvOpts.visibilityProperty === true,
  JSON.stringify(cvOpts),
);
cvEl.remove();

// ----- radio：表單外的同名 radio 自成一組 -----
const rWrap = mount(
  '<div><form><input type="radio" name="rg"><input type="radio" name="rg"></form>' +
    '<input type="radio" name="rg" id="rOut"></div>',
);
eq(
  'nvdaPosition 表單外的 radio 自成一組',
  I.nvdaPosition(rWrap.querySelector('#rOut'), 'radio'),
  '1 之 1',
);
rWrap.remove();

// ----- 動態播報 liveAtomic：status／alert 隱含整區播報（真 NVDA：念整區）-----
check('liveAtomic role=status 隱含 true', I.liveAtomic(el('<div role="status"></div>')) === true);
check('liveAtomic role=log 預設 false', I.liveAtomic(el('<div role="log"></div>')) === false);
check(
  'liveAtomic 明寫 aria-atomic=false 優先',
  I.liveAtomic(el('<div role="status" aria-atomic="false"></div>')) === false,
);

// ----- shared/popup-logic.js（popup 的純邏輯，過去 popup 完全沒有單元測試）-----
const PL = require(path.join(REPO, 'shared/popup-logic.js'));
check('isRestrictedUrl chrome://', PL.isRestrictedUrl('chrome://settings') === true);
check('isRestrictedUrl data:', PL.isRestrictedUrl('data:text/html,x') === true);
check('isRestrictedUrl chrome-untrusted://', PL.isRestrictedUrl('chrome-untrusted://x') === true);
check(
  'isRestrictedUrl 商店子網域',
  PL.isRestrictedUrl('https://chromewebstore.google.com/x') === true,
);
check('isRestrictedUrl 一般網頁不擋', PL.isRestrictedUrl('https://example.com/') === false);
check(
  'isRestrictedUrl blob: 不擋（同源可能注入成功）',
  PL.isRestrictedUrl('blob:https://a/1') === false,
);
check(
  'isRestrictedUrl file:// 不擋（使用者可授權）',
  PL.isRestrictedUrl('file:///C:/a.html') === false,
);
check(
  'liveSignature 內容變了簽章就變（含 shift 後長度不變）',
  PL.liveSignature([{ ts: 1 }, { ts: 2 }]) !== PL.liveSignature([{ ts: 2 }, { ts: 3 }]) &&
    PL.liveSignature([]) === '0:0',
);
const cbl = PL.countByLevel([
  { mapped: true, level: 'A' },
  { mapped: true, level: 'BOGUS' },
  { mapped: false },
]);
check(
  'countByLevel 髒值不產生 NaN',
  cbl.levelCounts.A === 1 && cbl.unmapped === 1 && !Number.isNaN(cbl.levelCounts.BOGUS),
);
eq('reviewPersistPlan 全清 → remove', PL.reviewPersistPlan({}, 1).action, 'remove');
eq('reviewPersistPlan 只剩時間戳也算全清', PL.reviewPersistPlan({ __ts: 9 }, 1).action, 'remove');
const plan = PL.reviewPersistPlan({ 'color-contrast': 'pass' }, 42);
check('reviewPersistPlan 有值 → set 並附時間戳', plan.action === 'set' && plan.value.__ts === 42);
check(
  'reviewStateFromStored 拿掉時間戳',
  !('__ts' in PL.reviewStateFromStored({ a: 'pass', __ts: 1 })),
);
const store = { prefs: {} };
for (let i = 0; i < PL.REVIEW_CAP + 3; i++) store[`review::u${i}`] = { a: 'pass', __ts: 1000 + i };
const pruned = PL.reviewKeysToPrune(store, 'review::u0');
check(
  'reviewKeysToPrune 超過上限淘汰最舊的、保留剛寫入的',
  pruned.length === 3 && !pruned.includes('review::u0') && pruned.includes('review::u1'),
  pruned.join(','),
);

// ----- background/service-worker.js：關分頁要清掉該分頁的掃描快取 -----
{
  const listeners = {};
  const removed = [];
  const fakeChrome = {
    runtime: { onInstalled: { addListener: (f) => (listeners.installed = f) } },
    tabs: { onRemoved: { addListener: (f) => (listeners.removed = f) } },
    storage: {
      session: { remove: (k) => (removed.push(k), Promise.resolve()) },
    },
  };
  new Function('chrome', fs.readFileSync(path.join(REPO, 'background/service-worker.js'), 'utf8'))(
    fakeChrome,
  );
  if (listeners.removed) listeners.removed(42, {});
  eq('service worker 關分頁時清 scan_<tabId>', removed.join(','), 'scan_42');
}

// ----- manifest 安全基準線（CLAUDE.md 第 1–4 條：擴充套件對使用者最重要的承諾）-----
eq(
  'manifest permissions 只有 activeTab／scripting／storage',
  JSON.stringify(mf.permissions),
  '["activeTab","scripting","storage"]',
);
check(
  'manifest 沒有 host_permissions／optional_host_permissions／content_scripts',
  !('host_permissions' in mf) && !('optional_host_permissions' in mf) && !('content_scripts' in mf),
);
check(
  'manifest minimum_chrome_version ≥ 102（storage.session 需求）',
  Number(mf.minimum_chrome_version) >= 102,
);
{
  // 擴充端（非 vendor）不得有對外請求；唯一允許的 fetch 是讀自家打包的 rules-map.json
  const extFiles = [];
  const walkJs = (d) =>
    fs.readdirSync(path.join(REPO, d), { withFileTypes: true }).forEach((e) => {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walkJs(rel);
      else if (/\.(js|html)$/.test(e.name)) extFiles.push(rel);
    });
  ['popup', 'content', 'background', 'shared'].forEach(walkJs);
  const offenders = [];
  for (const f of extFiles) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      const bad =
        /XMLHttpRequest|new WebSocket|sendBeacon|EventSource\(/.test(line) ||
        (/\bfetch\(/.test(line) && !/fetch\(chrome\.runtime\.getURL\(/.test(line)) ||
        /<script[^>]+src=["']https?:/i.test(line);
      if (bad) offenders.push(`${f}:${i + 1}`);
    });
  }
  check('擴充端沒有對外請求或遠端 script', offenders.length === 0, offenders.join('、'));
}

// ----- 打包清單（scripts/ext-files.js）：每項都存在，且涵蓋 manifest 與 popup.html 引用的路徑 -----
{
  const extList = require(path.join(REPO, 'scripts/ext-files.js'));
  const missing = extList.filter((p) => !fs.existsSync(path.join(REPO, p)));
  check('ext-files 每一項都存在', missing.length === 0, missing.join('、'));
  const covered = (p) => extList.some((top) => p === top || p.startsWith(top + '/'));
  const refs = [
    mf.action.default_popup,
    mf.background.service_worker,
    ...Object.values(mf.icons),
    ...Object.values(mf.action.default_icon),
  ];
  const popupHtml = fs.readFileSync(path.join(REPO, 'popup/popup.html'), 'utf8');
  for (const m of popupHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
    refs.push(path.posix.normalize(path.posix.join('popup', m[1])));
  }
  const injected = fs
    .readFileSync(path.join(REPO, 'popup/popup.js'), 'utf8')
    .match(/'(?:vendor|content)\/[^']+\.js'/g)
    .map((s) => s.slice(1, -1));
  const uncovered = [...refs, ...injected].filter((p) => !covered(p));
  check(
    'ext-files 涵蓋 manifest／popup.html／注入檔引用的所有路徑',
    uncovered.length === 0,
    uncovered.join('、'),
  );
  check(
    'ext-files 含授權文件（MPL-2.0 的 vendor 須附聲明）',
    extList.includes('LICENSE') && extList.includes('THIRD-PARTY-NOTICES.md'),
  );
  check('npm files 含 THIRD-PARTY-NOTICES.md', pkg.files.includes('THIRD-PARTY-NOTICES.md'));
  check(
    'vendor/axe-locale-zh_TW.js 檔頭帶 Deque 著作權與 MPL-2.0 聲明',
    /Deque Systems[\s\S]{0,300}Mozilla Public/.test(
      fs.readFileSync(path.join(REPO, 'vendor/axe-locale-zh_TW.js'), 'utf8').slice(0, 600),
    ),
  );
}

// ----- scripts/release-prep.js：manifest 版本取代只能改到頂層欄位 -----
{
  const { bumpManifestVersion } = require(path.join(REPO, 'scripts/release-prep.js'));
  const nested = '{\n  "a": {\n    "version": "0.0.1"\n  },\n  "version": "1.1.0"\n}\n';
  const bumped = JSON.parse(bumpManifestVersion(nested, '2.0.0'));
  check(
    'bumpManifestVersion 不改到排在前面的巢狀 version',
    bumped.version === '2.0.0' && bumped.a.version === '0.0.1',
  );
  const realBumped = bumpManifestVersion(
    fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'),
    '9.9.9',
  );
  check(
    'bumpManifestVersion 真實 manifest 只改一行',
    JSON.parse(realBumped).version === '9.9.9' &&
      realBumped.split('\n').length ===
        fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8').split('\n').length,
  );
}

// ----- workflows：release 等的 check-run 名稱必須等於 ci.yml 的 job id；CI 必須有 audit 關卡 -----
{
  const ciYml = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
  const relYml = fs.readFileSync(path.join(REPO, '.github/workflows/release.yml'), 'utf8');
  const jobsBlock = ciYml.split(/^jobs:\s*$/m)[1] || '';
  const ciJobs = [...jobsBlock.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]).sort();
  const awaited = ((relYml.match(/for NAME in ([^;]+);/) || [])[1] || '')
    .trim()
    .split(/\s+/)
    .sort();
  eq('release.yml 等待的 check-run ＝ ci.yml 的 job id', awaited.join(','), ciJobs.join(','));
  check('ci.yml 有 npm audit --omit=dev 關卡', /npm audit --omit=dev/.test(ciYml));
  // npm 只走 OIDC 信任發布：workflow 不得引用長效 token，且要有「出現 token 就失敗」的守門
  //（v2.0.0 首次發佈就是被殘留的 NPM_TOKEN 搶先、npm 收緊規定後 404）
  check(
    'release.yml 不引用 NPM_TOKEN／NODE_AUTH_TOKEN secret',
    !/secrets\.(NPM_TOKEN|NODE_AUTH_TOKEN)/.test(relYml),
  );
  check('release.yml 有 npm token 守門', /compgen -e/.test(relYml) && /_auth/.test(relYml));
  check('release.yml 有 id-token: write（OIDC）', /id-token:\s*write/.test(relYml));
}

scanDone.then(async () => {
  // ----- 動態播報監看：插入行為（真 NVDA 對照定出的規則）-----
  const tick = () => new Promise((r) => setTimeout(r, 20));
  window.__rampA11yLiveStart();
  const host = mount('<div id="liveHost"></div>');
  const politeHost = mount('<div role="status" id="liveStatus">已儲存</div>');
  await tick();
  async function liveCase(mutate) {
    window.__rampA11yLiveClear();
    mutate();
    await tick();
    return window.__rampA11yLiveGet().log;
  }
  const addTo = (parent, html) => {
    const w = doc.createElement('div');
    w.innerHTML = html;
    while (w.firstChild) parent.appendChild(w.firstChild);
  };
  let log = await liveCase(() => addTo(host, '<div role="alert">表單有錯誤</div>'));
  check(
    '插入整個 role=alert → 記 1 筆 assertive',
    log.length === 1 && log[0].politeness === 'assertive',
    JSON.stringify(log),
  );
  log = await liveCase(() => addTo(host, '<div><div role="alert">巢狀錯誤</div></div>'));
  check('插入包著 alert 的外層 → 記 1 筆', log.length === 1, JSON.stringify(log));
  log = await liveCase(() =>
    addTo(host, '<div role="alert">外層<div role="alert">內層</div></div>'),
  );
  check('alert 內含 alert → 只記最外層 1 筆', log.length === 1, JSON.stringify(log));
  log = await liveCase(() => addTo(politeHost, '<div role="alert">區域內的警告</div>'));
  check(
    'alert 插進既有 role=status → 只記 1 筆、念整區（真 NVDA：已儲存區域內的警告）',
    log.length === 1 && log[0].text === '已儲存區域內的警告',
    JSON.stringify(log),
  );
  log = await liveCase(() => addTo(host, '<div aria-live="assertive">緊急區域文字</div>'));
  check(
    '插入整個 aria-live=assertive 節點 → 不記（真 NVDA 不念）',
    log.length === 0,
    JSON.stringify(log),
  );
  log = await liveCase(() => addTo(host, '<div role="status">新狀態列</div>'));
  check('插入已帶文字的新 role=status → 不記', log.length === 0, JSON.stringify(log));
  log = await liveCase(() =>
    addTo(host, '<div role="alert" style="display:none">隱藏的警告</div>'),
  );
  check('插入 display:none 的 alert → 不記', log.length === 0, JSON.stringify(log));
  log = await liveCase(() => addTo(host, '<div role="alert" hidden>屬性隱藏的警告</div>'));
  check('插入 hidden 的 alert → 不記', log.length === 0, JSON.stringify(log));
  window.__rampA11yLiveStop();
  host.remove();
  politeHost.remove();

  // 放最後：重新載入掃描器會換掉閉包，之後再用舊的 __rampA11yInternals 會對不上
  // 擴充更新後已開分頁殘留舊版掃描器：版本不同就必須重新定義（同版本才跳過）
  {
    const scannerSrc = fs.readFileSync(path.join(REPO, 'content/scanner.js'), 'utf8');
    const before = window.__rampA11yReadingOrder;
    window.eval(scannerSrc);
    check('同版本重複注入 → 不重新定義', window.__rampA11yReadingOrder === before);
    window.__rampA11yVer = '0.0.1-舊版';
    window.eval(scannerSrc);
    check(
      '版本不同的重複注入 → 重新定義並更新版本',
      window.__rampA11yReadingOrder !== before && window.__rampA11yVer === 'cli',
    );
  }

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n==== ${results.length - fails}/${results.length} PASS ====`);
  process.exit(fails ? 1 : 0);
});
