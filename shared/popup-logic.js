/**
 * shared/popup-logic.js
 * popup 的純邏輯（無 DOM／chrome 依賴），抽出來讓 test/unit 能直接 require 驗證——
 * popup.js 本身綁著 chrome.* 與 DOM，過去完全沒有單元測試（2026-10 稽核的變異測試
 * 顯示：把這些判斷改壞，沒有任何測試會紅）。
 *   - isRestrictedUrl：受保護頁面（無法注入）的判定
 *   - liveSignature：動態播報輪詢的「內容是否變了」簽章
 *   - countByLevel：違規依等級計數（popup 統計列與匯出報告共用）
 *   - reviewPersistPlan／reviewKeysToPrune／REVIEW_*：人工複核自評的存檔決策與上限
 * UMD 包裝，與 shared/report-core.js 同樣式：瀏覽器 → window.RampPopupLogic，Node → require。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RampPopupLogic = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RESTRICTED_SCHEMES = [
    'chrome://',
    'chrome-extension://',
    'chrome-search://',
    'chrome-devtools://',
    'chrome-untrusted://',
    'edge://',
    'extension://',
    'devtools://',
    'about:',
    'view-source:',
    'data:',
    'filesystem:',
    // file:// 刻意不擋：使用者勾了「允許存取檔案網址」後掃本機檔案是合法情境，
    // 沒勾時注入會失敗、由錯誤訊息轉譯分流。
    // blob: 也不擋：同源的 blob: 頁面有機會注入成功，失敗時同樣由錯誤訊息轉譯分流
  ];
  // 擴充功能商店頁面同樣禁止注入
  const RESTRICTED_HOSTS = [
    'chromewebstore.google.com',
    'chrome.google.com',
    'microsoftedge.microsoft.com',
  ];

  /** 判斷是否為無法注入腳本的受保護頁面 */
  function isRestrictedUrl(url) {
    if (!url) return true;
    if (RESTRICTED_SCHEMES.some((s) => url.startsWith(s))) return true;
    try {
      const host = new URL(url).hostname;
      return RESTRICTED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    } catch {
      return true;
    }
  }

  /** 播報緩衝的簽章（筆數＋最後一筆時間戳）——相同就代表內容沒變、不必重繪。
   *  緩衝滿 100 則 shift 時長度不變但最後一筆 ts 會變；清除後變 "0:0"，皆能偵測 */
  function liveSignature(log) {
    const l = log || [];
    return `${l.length}:${l.length ? l[l.length - 1].ts : 0}`;
  }

  /** 違規依等級計數；未對應台灣準則的另計。twLevel 出現髒值時不會產生 NaN */
  function countByLevel(violations) {
    const levelCounts = { A: 0, AA: 0, AAA: 0 };
    let unmapped = 0;
    (violations || []).forEach((v) => {
      if (v.mapped) levelCounts[v.level] = (levelCounts[v.level] || 0) + 1;
      else unmapped += 1;
    });
    return { levelCounts, unmapped };
  }

  const REVIEW_PREFIX = 'review::';
  const REVIEW_TS = '__ts'; // 存檔時附上的最後修改時間（供上限淘汰用；不是 axe 規則 id）
  const REVIEW_CAP = 200; // 最多保留幾個網址的自評，超過淘汰最舊的

  /** 自評的存檔決策：全部清回「未確認」→ 整鍵移除（不留空物件）；否則附時間戳寫入 */
  function reviewPersistPlan(state, now) {
    const entries = Object.entries(state || {}).filter(([k]) => k !== REVIEW_TS);
    if (entries.length === 0) return { action: 'remove' };
    return { action: 'set', value: { ...Object.fromEntries(entries), [REVIEW_TS]: now } };
  }

  /** 從存檔值取回自評狀態（拿掉時間戳欄位） */
  function reviewStateFromStored(stored) {
    const out = { ...(stored || {}) };
    delete out[REVIEW_TS];
    return out;
  }

  /**
   * 超過上限時該淘汰哪些 review 鍵（最舊的先走；目前這一筆永遠保留）。
   * @param all storage.local 全部內容（{key: value}）
   * @param keepKey 本次剛寫入的鍵
   */
  function reviewKeysToPrune(all, keepKey, cap = REVIEW_CAP) {
    const items = Object.entries(all || {})
      .filter(([k]) => k.startsWith(REVIEW_PREFIX) && k !== keepKey)
      .map(([k, v]) => [k, (v && v[REVIEW_TS]) || 0]);
    const excess = items.length + 1 - cap;
    if (excess <= 0) return [];
    return items
      .sort((a, b) => a[1] - b[1])
      .slice(0, excess)
      .map(([k]) => k);
  }

  return {
    isRestrictedUrl,
    liveSignature,
    countByLevel,
    REVIEW_PREFIX,
    REVIEW_CAP,
    reviewPersistPlan,
    reviewStateFromStored,
    reviewKeysToPrune,
  };
});
