/**
 * content/scanner.js
 * 以 chrome.scripting.executeScript 注入到當前分頁（isolated world）。
 * 依賴：vendor/axe.min.js 需先注入，讓此環境有全域 axe 可用。
 *
 * 對外（popup）暴露三個函式，掛在 window 上供後續 executeScript 呼叫：
 *   window.__rampA11yScan()               → 執行 axe 掃描，回傳可序列化的純資料
 *   window.__rampA11yHighlight(selector)  → 高亮指定元素並捲動過去
 *   window.__rampA11yClear()              → 清除所有高亮
 */
(() => {
  // 避免重複注入時重複定義
  if (window.__rampA11yScan) return;

  const HIGHLIGHT_CLASS = 'ramp-a11y-highlight';
  const STYLE_ID = 'ramp-a11y-style';

  /** 確保高亮樣式已插入頁面 */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        outline: 3px solid #E11D48 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(225, 29, 72, 0.25) !important;
        transition: outline 0.15s ease !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  /** 清除頁面上所有 Ramp 高亮 */
  window.__rampA11yClear = function () {
    document
      .querySelectorAll('.' + HIGHLIGHT_CLASS)
      .forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
  };

  /**
   * 高亮指定 selector 的元素並捲動至可視範圍。
   * 回傳 true/false 表示是否成功找到元素。
   */
  window.__rampA11yHighlight = function (selector) {
    try {
      window.__rampA11yClear();
      ensureStyle();
      const el = document.querySelector(selector);
      if (!el) return false;
      el.classList.add(HIGHLIGHT_CLASS);
      // 使用者若設定減少動態效果，改用瞬間捲動（工具自身遵守 a11y）
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      return true;
    } catch (e) {
      // selector 可能包含 shadow DOM 或 iframe 路徑而無法直接查詢
      return false;
    }
  };

  /**
   * 執行 axe 掃描（JavaScript 執行後的實際 DOM），
   * 只回傳可序列化的純資料（executeScript 的結果必須可 JSON 化）。
   */
  window.__rampA11yScan = async function () {
    // 掃描前先清掉舊高亮，避免高亮樣式影響結果
    window.__rampA11yClear();

    const results = await window.axe.run(document, {
      // MVP 僅掃描主頁面；跨來源 iframe 無法注入 axe，開啟會導致逾時
      iframes: false,
      resultTypes: ['violations', 'incomplete'],
      rules: {
        // axe 4.10 起 duplicate-id 因 WCAG 2.2 移除 4.1.1 而預設停用；
        // 台灣規範 110.07 版（適用至 115.11.29）仍包含 4.1.1，故明確啟用
        'duplicate-id': { enabled: true },
        // 115 年修正版新增 2.5.8 目標尺寸(最小)（WCAG 2.2），
        // axe 4.10 預設停用此規則，明確啟用使對應生效
        'target-size': { enabled: true },
      },
    });

    // 每條規則最多回傳的元素數：大型頁面單一規則可能有上千個元素，
    // 全數回傳會拖垮 popup 渲染與 session 快取
    const MAX_NODES = 20;

    /** 將 axe 結果轉為精簡、可序列化的資料 */
    const pick = (list) =>
      list.map((rule) => ({
        id: rule.id,
        impact: rule.impact || null,
        tags: rule.tags || [],
        help: rule.help,
        description: rule.description,
        helpUrl: rule.helpUrl,
        nodeCount: rule.nodes.length,
        nodes: rule.nodes.slice(0, MAX_NODES).map((node) => ({
          // target 為 selector 陣列（iframe/shadow DOM 時為巢狀），MVP 攤平成字串
          target: Array.isArray(node.target)
            ? node.target.flat().map(String).join(' ')
            : String(node.target),
          // HTML 片段截斷，避免 popup 渲染過長
          html: (node.html || '').slice(0, 300),
        })),
      }));

    return {
      url: location.href,
      violations: pick(results.violations),
      incomplete: pick(results.incomplete),
    };
  };
})();
