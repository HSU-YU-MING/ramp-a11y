/**
 * shared/manual-checks.js
 * 115 年修正版新增、但 axe 無法自動判定的成功準則（人工檢核清單）。
 * 新增的九條裡，2.5.8 有 axe 的 target-size 可以自動測，其餘八條都在這裡。
 * 沒有這份清單，這八條在結果裡完全不會出現，使用者會誤以為沒有問題。
 *
 * 準則名稱、等級與檢測碼的真相源是 docs/tw-web-accessibility-spec-115.pdf
 * （準則全文第 35–44 頁，檢測碼見附件）。「適用情況／怎麼檢查／如何修正」是本工具的整理，
 * 不是官方文字。
 *
 * 放在 shared/ 而不是 data/：擴充端除了 rules-map.json 之外不得再有 fetch
 * （CLAUDE.md 安全基準線第 4 條），而 rules-map.json 的每一筆都必須對應 axe 規則。
 *
 * 無 DOM／chrome／Node 依賴，UMD 包裝供兩種載入方式共用：
 *   - 瀏覽器：<script src="../shared/manual-checks.js"> → window.RampManualChecks
 *   - Node：  const RampManualChecks = require('.../shared/manual-checks.js')
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RampManualChecks = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEVEL_ORDER = ['A', 'AA', 'AAA'];

  /** 自評選項（比一般複核多一個「不適用」：沒有拖曳或登入的頁面，這些準則本來就不適用） */
  const MANUAL_RESULT_ZH = { pass: '通過', fail: '不通過', na: '不適用' };

  const MANUAL_CHECKS = [
    {
      id: 'manual:2.4.11',
      guideline: '2.4.11',
      guidelineName: '焦點不遮蔽(最小)',
      level: 'AA',
      category: '可操作',
      title: '鍵盤焦點不可被完全遮住',
      appliesWhen: '頁面有固定頁首、固定頁尾、浮動按鈕或 Cookie 橫幅等會蓋住內容的元素。',
      check: '按 Tab 逐一移動焦點，確認取得焦點的元件不會被這些內容完全蓋住。',
      how: '以 CSS scroll-padding 預留空間，或調整蓋住內容的元素位置。',
      checkCodes: ['FA2241100E'],
    },
    {
      id: 'manual:2.4.12',
      guideline: '2.4.12',
      guidelineName: '焦點不遮蔽(加強)',
      level: 'AAA',
      category: '可操作',
      title: '鍵盤焦點不可被遮住任何一部分',
      appliesWhen: '頁面有固定頁首、固定頁尾、浮動按鈕或 Cookie 橫幅等會蓋住內容的元素。',
      check: '按 Tab 逐一移動焦點，確認取得焦點的元件沒有任何一部分被蓋住。',
      how: '以 CSS scroll-padding 預留足夠空間。',
      checkCodes: ['CS3241200E'],
    },
    {
      id: 'manual:2.4.13',
      guideline: '2.4.13',
      guidelineName: '焦點外觀',
      level: 'AAA',
      category: '可操作',
      title: '焦點框線要夠大，對比要夠高',
      appliesWhen: '所有可取得鍵盤焦點的元件。框線由瀏覽器決定且作者無法調整時例外。',
      check:
        '焦點框線的面積至少等於 2 CSS 像素邊框的周長，且同一像素在聚焦與未聚焦狀態間的對比至少 3:1。',
      how: '自訂明顯的焦點框線；背景顏色不固定時可用雙色框線。',
      checkCodes: ['CS3241300E', 'CS3241301E', 'GN3241302E'],
    },
    {
      id: 'manual:2.5.7',
      guideline: '2.5.7',
      guidelineName: '拖曳動作',
      level: 'AA',
      category: '可操作',
      title: '拖曳功能要有不用拖曳的操作方式',
      appliesWhen: '頁面有排序清單、滑桿、看板或地圖等需要拖曳的功能。',
      check:
        '確認不拖曳、只用單一指標（例如點擊）也能完成同樣操作。拖曳是必要的，或由瀏覽器決定且未被修改時例外。',
      how: '加上上移、下移按鈕，或提供點選與輸入的替代方式。',
      checkCodes: ['FA2250700E'],
    },
    {
      id: 'manual:3.2.6',
      guideline: '3.2.6',
      guidelineName: '一致性幫助',
      level: 'A',
      category: '可理解',
      title: '幫助機制在各頁的相對順序要一致',
      appliesWhen:
        '多個頁面都放了人員聯繫方式、人機聯繫機制、自助選項或全自動聯繫機制（例如聊天機器人）。',
      check: '比對多個頁面，確認這些幫助機制相對於其他內容的順序相同。只掃一頁看不出來。',
      how: '把幫助機制放在共用的頁首或頁尾。',
      checkCodes: ['GN1320600E'],
    },
    {
      id: 'manual:3.3.7',
      guideline: '3.3.7',
      guidelineName: '冗餘輸入',
      level: 'A',
      category: '可理解',
      title: '同一流程不要求重複輸入',
      appliesWhen: '頁面屬於多步驟表單、申請或結帳流程。',
      check:
        '先前填過或提供過的資料，再次需要時應自動填入或可供選擇。重新輸入是必須的、為了確保安全，或舊資料已失效時例外。',
      how: '帶入上一步的資料，或提供「同上」之類的選項。',
      checkCodes: ['GN1330700E'],
    },
    {
      id: 'manual:3.3.8',
      guideline: '3.3.8',
      guidelineName: '無障礙認證(最小)',
      level: 'AA',
      category: '可理解',
      title: '登入不可只靠認知測試',
      appliesWhen: '頁面有登入、驗證碼或其他認證步驟。',
      check:
        '認證不可要求記住密碼或解謎，除非提供替代方案、協助機制，或測試內容屬於物件識別或個人內容。',
      how: '正確標記電子郵件與密碼欄位，並且不要阻擋貼上或密碼管理工具。',
      checkCodes: ['HM2330800E', 'FA2330801E'],
    },
    {
      id: 'manual:3.3.9',
      guideline: '3.3.9',
      guidelineName: '無障礙認證(加強)',
      level: 'AAA',
      category: '可理解',
      title: '登入不可靠認知測試，物件識別也不例外',
      appliesWhen: '頁面有登入、驗證碼或其他認證步驟。',
      check: '只有提供替代方案或協助機制才算符合；物件識別與個人內容的例外在這一級不適用。',
      how: '提供不需認知測試的方式，例如電子郵件連結驗證。',
      checkCodes: ['GN3330900E'],
    },
  ];

  /**
   * 目標等級內要顯示哪些項目，以及有幾條因超出目標而未列出。
   * 等級無法辨識時全部列出：寧可多列，不要讓使用者少看到一條而不自知。
   */
  function manualChecksForLevel(targetLevel) {
    const idx = LEVEL_ORDER.indexOf(targetLevel);
    if (idx < 0) return { shown: MANUAL_CHECKS.slice(), hiddenCount: 0 };
    const shown = MANUAL_CHECKS.filter((c) => LEVEL_ORDER.indexOf(c.level) <= idx);
    return { shown, hiddenCount: MANUAL_CHECKS.length - shown.length };
  }

  /** 統計自評結果。無法辨識的值一律算未確認，不可以被當成已檢核。 */
  function summarizeManualChecks(items, reviewState) {
    const counts = { pass: 0, fail: 0, na: 0, none: 0 };
    items.forEach((item) => {
      const value = (reviewState || {})[item.id];
      if (value === 'pass' || value === 'fail' || value === 'na') counts[value] += 1;
      else counts.none += 1;
    });
    return counts;
  }

  /** 自評值 → 顯示文字；無法辨識的值（含 constructor 這類原型鍵）一律是未確認 */
  function manualResultLabel(value) {
    return Object.prototype.hasOwnProperty.call(MANUAL_RESULT_ZH, value)
      ? MANUAL_RESULT_ZH[value]
      : '未確認';
  }

  return {
    MANUAL_CHECKS,
    MANUAL_RESULT_ZH,
    manualChecksForLevel,
    summarizeManualChecks,
    manualResultLabel,
  };
});
