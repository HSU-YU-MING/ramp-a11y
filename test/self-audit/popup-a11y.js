/**
 * ramp-a11y popup 靜態無障礙契約測試
 *
 * 用法：npm run test:self（需 devDependency jsdom）
 *
 * 一個無障礙檢測工具，本身的介面理應無障礙。本測試以 jsdom 解析 popup/popup.html
 * 的「靜態原始碼」，驗證幾條不依賴版面即可判定的無障礙契約：
 *   - 文件語言（html[lang]）與標題
 *   - 每個按鈕都有可存取名稱（文字內容或 aria-label）
 *   - 每個表單控制項都有關聯標籤（label[for] / 包裹 label / aria-label(ledby)）
 *   - 裝飾性圖形以 aria-hidden 隱藏，不干擾報讀
 *   - id 不重複、tablist 的分頁都有 aria-selected
 *
 * 範圍聲明（避免名不副實）：
 *   - 這是「獨立手寫的靜態契約檢查」，並「不」實際載入 Ramp 的掃描引擎（axe／scanner.js）
 *     來掃自己，因此並非嚴格意義的 dogfooding，也涵蓋不到 scanner 端的迴歸。
 *   - jsdom 不執行 popup.js，只檢查簽入的 HTML 樣板；執行期由 JS 動態注入的控制項不在範圍內。
 *     為避免「元素數為 0 時無意義地通過」，下方先斷言 popup 應有的最小 UI 面向仍存在。
 *   - 版面相關規則（對比度、焦點順序等）仍由真 Chrome 的 e2e／人工驗證負責。
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

const html = fs.readFileSync(path.join(REPO, 'popup', 'popup.html'), 'utf8');
const { window } = new JSDOM(html);
const doc = window.document;

/** 元素是否具備可存取名稱（僅就靜態屬性判定，不算 CSS 隱藏） */
function hasAccessibleName(elem) {
  const aria = (elem.getAttribute('aria-label') || '').trim();
  if (aria) return true;
  const labelledby = (elem.getAttribute('aria-labelledby') || '').trim();
  if (labelledby) {
    return labelledby.split(/\s+/).some((id) => {
      const ref = doc.getElementById(id);
      return ref && ref.textContent.trim();
    });
  }
  // title 也可作為可存取名稱來源
  if ((elem.getAttribute('title') || '').trim()) return true;
  return (elem.textContent || '').trim().length > 0;
}

/** 表單控制項是否有關聯標籤 */
function hasFormLabel(elem) {
  if (elem.getAttribute('aria-label') || elem.getAttribute('aria-labelledby')) return true;
  if (elem.closest('label')) return true; // 被 <label> 包住
  const id = elem.getAttribute('id');
  if (id && doc.querySelector(`label[for="${id}"]`)) return true;
  return false;
}

// ===== 文件層級 =====
const root = doc.documentElement;
check(
  'html 有 lang',
  (root.getAttribute('lang') || '').trim().length > 0,
  root.getAttribute('lang'),
);
check(
  '有 <title>',
  !!(doc.querySelector('title') && doc.querySelector('title').textContent.trim()),
);
check('有 <main> 地標', !!doc.querySelector('main'));
check('有 <h1> 標題', !!(doc.querySelector('h1') && doc.querySelector('h1').textContent.trim()));

// ===== 最小 UI 面向存在 =====
// 「所有 X 都有 Y」的檢查在 X 數為 0 時會無意義地通過。先斷言 popup 應有的
// 主要控制項仍存在，這樣若整段 UI 被移除或改為執行期 JS 注入（jsdom 看不到），
// 測試會明確失敗，而非靜默地維持綠燈、暗中失去覆蓋。
const buttons = [...doc.querySelectorAll('button')];
const controls = [...doc.querySelectorAll('input, select, textarea')];
const tabs = [...doc.querySelectorAll('[role="tab"]')];
check(`popup 至少有 1 個按鈕（實得 ${buttons.length}）`, buttons.length >= 1);
check(`popup 至少有 1 個表單控制項（實得 ${controls.length}）`, controls.length >= 1);
check(`popup 至少有 1 個檢視模式分頁（實得 ${tabs.length}）`, tabs.length >= 1);

// ===== 按鈕可存取名稱 =====
const namelessBtn = buttons.filter((b) => !hasAccessibleName(b));
check(
  `所有按鈕都有可存取名稱（共 ${buttons.length} 個）`,
  namelessBtn.length === 0,
  namelessBtn.length ? namelessBtn.map((b) => b.outerHTML).join(' / ') : '',
);

// ===== 表單控制項標籤 =====
const unlabeled = controls.filter((c) => !hasFormLabel(c));
check(
  `所有表單控制項都有關聯標籤（共 ${controls.length} 個）`,
  unlabeled.length === 0,
  unlabeled.length ? unlabeled.map((c) => c.outerHTML).join(' / ') : '',
);

// ===== 裝飾性圖形隱藏 =====
const svgs = [...doc.querySelectorAll('svg')];
const exposedSvg = svgs.filter(
  (s) => s.getAttribute('aria-hidden') !== 'true' && !hasAccessibleName(s),
);
check(
  `裝飾性 SVG 皆以 aria-hidden 隱藏或具名（共 ${svgs.length} 個）`,
  exposedSvg.length === 0,
  exposedSvg.length ? exposedSvg.map((s) => s.outerHTML).join(' / ') : '',
);

// ===== 圖片替代文字 =====
const imgs = [...doc.querySelectorAll('img')];
const noAltImg = imgs.filter(
  (i) => i.getAttribute('alt') === null && i.getAttribute('aria-hidden') !== 'true',
);
check(`所有 <img> 皆有 alt 或隱藏（共 ${imgs.length} 個）`, noAltImg.length === 0);

// ===== id 不重複 =====
const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id);
const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
check('id 不重複', dupIds.length === 0, dupIds.length ? [...new Set(dupIds)].join(', ') : '');

// ===== tablist 內每個 tab 都有 aria-selected =====
const tabNoState = tabs.filter((t) => t.getAttribute('aria-selected') === null);
check(
  `每個 role=tab 都有 aria-selected（共 ${tabs.length} 個）`,
  tabNoState.length === 0,
  tabNoState.length ? tabNoState.map((t) => t.outerHTML).join(' / ') : '',
);

const fails = results.filter((r) => !r.ok).length;
console.log(`\n==== ${results.length - fails}/${results.length} PASS ====`);
process.exit(fails ? 1 : 0);
