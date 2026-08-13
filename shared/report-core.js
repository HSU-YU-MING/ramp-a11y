/**
 * shared/report-core.js
 * 擴充套件（popup）與 CLI（ramp-scan）共用的純函式與常數，避免兩邊各持一份而漂移：
 *   - AXE_VERSION：打包於 vendor/ 的 axe-core 版本（報告頁腳署名用）
 *   - escapeHtml：HTML 逸出
 *   - resolveMapping：axe 規則 → 台灣「網站無障礙規範」對應（純資料，不含節點資料）
 *   - nvdaParts：NVDA 報讀預覽 → 依序的文字片段
 * 無 DOM／chrome／Node 依賴，UMD 包裝供兩種載入方式共用：
 *   - 瀏覽器：<script src="../shared/report-core.js"> → window.RampShared
 *   - Node：  const RampShared = require('.../shared/report-core.js')
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RampShared = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 打包於 vendor/axe.min.js 的 axe-core 版本。
   * 擴充套件與 CLI 的報告頁腳都署這個名，兩邊不得各寫各的——否則升級 axe 時漏改一處，
   * 報告就會對使用者謊報是哪個引擎測出來的，而且沒有任何測試會發現。
   * 真相源是 vendor/axe.min.js 內的 axe.version；test/docs/readme-claims.js 會比對這裡、
   * vendor 檔案與兩份 README／THIRD-PARTY-NOTICES 是否一致。
   */
  const AXE_VERSION = '4.10.3';

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 解析單一 axe 規則的台灣規範對應（純資料，不含每個節點資料）。
   * @param rule    axe 結果（需 id、tags、help、description、impact）
   * @param rulesMap Map<axeRuleId, 對應表項目>
   * 回傳共用欄位；各消費端再自行附加節點／樣本等專屬資料。
   */
  function resolveMapping(rule, rulesMap) {
    const map = rulesMap.get(rule.id);
    const base = {
      axeId: rule.id,
      impact: rule.impact || null,
      isBestPractice: (rule.tags || []).includes('best-practice'),
      // WCAG 2.2 新增準則：台灣規範（對齊 WCAG 2.1）尚未採用，需明確標示
      isWcag22: (rule.tags || []).some((t) => /^wcag22a{1,3}$/.test(t)),
    };
    if (map) {
      return {
        ...base,
        mapped: true,
        level: map.twLevel,
        title: map.titleZh,
        guideline: map.twGuideline,
        guidelineName: map.twGuidelineName || '',
        category: map.category,
        why: map.whyZh,
        how: map.howZh,
        note: map.noteZh || null, // 版本差異等補充說明
        checkCodes: map.twCheckCodes || [], // 官方檢測碼（附件一 C 碼）
      };
    }
    return {
      ...base,
      mapped: false,
      level: null,
      title: rule.help, // 經 zh_TW 語言包後多數已是繁中
      guideline: null,
      guidelineName: '',
      category: null,
      why: rule.description,
      how: null,
      note: null,
      checkCodes: [],
    };
  }

  /** NVDA 報讀預覽 → 依序的文字片段（各消費端自行 join／包 HTML）。 */
  function nvdaParts(nvda) {
    if (!nvda) return [];
    const p = [];
    if (nvda.name) p.push(nvda.name);
    else if (nvda.nameRequired) p.push('（無可朗讀名稱）');
    if (nvda.role) p.push(nvda.role);
    else if (nvda.roleEn) p.push(nvda.roleEn);
    if (nvda.value) p.push(nvda.value);
    if (nvda.states && nvda.states.length) p.push(nvda.states.join('　'));
    if (nvda.position) p.push(nvda.position);
    if (nvda.itemCount) p.push(nvda.itemCount);
    if (nvda.description) p.push('（' + nvda.description + '）');
    return p;
  }

  return { AXE_VERSION, escapeHtml, resolveMapping, nvdaParts };
});
