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

  // ===== NVDA 報讀預覽 =====
  // 讓看得見的開發者「看見」NVDA（盲用視窗資訊系統）會怎麼念出這個元素。
  // 角色與狀態的中文用詞取自 NVDA 官方正體中文翻譯（zh_TW），逐條核對自：
  //   github.com/nvaccess/nvda → source/locale/zh_TW/LC_MESSAGES/nvda.po
  // 只收錄已在該檔核對過的用詞；未收錄的角色改以原始 ARIA role 英文呈現，不自行杜撰。

  // ARIA role → NVDA 正體中文角色名（heading 另計階層，見 nvdaPreview）
  const NVDA_ROLE_ZH = {
    button: '按鈕',
    link: '連結',
    checkbox: '核取方塊',
    radio: '選擇鈕',
    textbox: '編輯',
    searchbox: '編輯',
    combobox: '下拉式方塊',
    listbox: '清單',
    list: '清單',
    listitem: '清單項目',
    img: '圖片',
    table: '表格',
    grid: '表格',
    cell: '儲存格',
    gridcell: '儲存格',
    dialog: '對話方塊',
    alertdialog: '對話方塊',
    alert: '請注意',
    switch: '切換',
    menu: '功能表',
    menuitem: '功能表項目',
    menubar: '功能表列',
    tab: '索引標籤',
    slider: '滑桿',
    progressbar: '進度列',
    tree: '樹狀檢視',
    treeitem: '樹狀檢視項目',
    document: '文件',
    paragraph: '段落',
    blockquote: '引述',
    separator: '分隔線',
    spinbutton: '微調按鈕',
    group: '群組',
    region: '區域',
    form: '表單',
    status: '狀態列',
    toolbar: '工具列',
    banner: '橫幅區',
    navigation: '導覽區',
    main: '主要內容區',
    complementary: '補充區',
    contentinfo: '資訊區',
  };

  // NVDA 不會把這些角色當成獨立物件朗讀（純結構／被隱藏），只依閱讀順序讀內文；
  // 這類元素顯示「NVDA 朗讀」會誤導，故一律略過預覽。
  const NVDA_SILENT_ROLES = { generic: 1, presentation: 1, none: 1 };

  // 「必須有可朗讀名稱」的角色：這些角色缺名稱才是真正的障礙，才顯示「（無可朗讀名稱）」。
  // 清單／表格／地標等結構角色本就不需要名稱，缺名稱屬正常，不加醒目提示。
  const NVDA_NAME_REQUIRED = {
    button: 1, link: 1, checkbox: 1, radio: 1, textbox: 1, searchbox: 1,
    combobox: 1, listbox: 1, switch: 1, menuitem: 1, tab: 1, slider: 1,
    spinbutton: 1, progressbar: 1, img: 1, treeitem: 1,
  };

  /**
   * 讀取元素的常見狀態，回傳 NVDA 正體中文狀態詞陣列。
   * 僅在屬性「實際存在」時才列出——例如缺 aria-checked 的 role=checkbox
   * 不會被杜撰成「勾選」，這種缺漏本身正是要呈現給開發者看的。
   */
  function nvdaStates(el) {
    const states = [];
    const attr = (n) => el.getAttribute(n);
    const truthy = (v) => v != null && v !== 'false';

    // 停用（unavailable）
    if (el.disabled || truthy(attr('aria-disabled'))) states.push('無法使用');
    // 勾選（checkbox / radio / switch）
    const ariaChecked = attr('aria-checked');
    if (ariaChecked != null) {
      states.push(ariaChecked === 'mixed' ? '部分勾選' : ariaChecked === 'true' ? '勾選' : '沒勾選');
    } else if (typeof el.checked === 'boolean' && (el.type === 'checkbox' || el.type === 'radio')) {
      states.push(el.checked ? '勾選' : '沒勾選');
    }
    // 按下（toggle button）
    const pressed = attr('aria-pressed');
    if (pressed != null && pressed !== 'mixed') states.push(pressed === 'true' ? '按下' : '沒按下');
    // 展開／折疊
    const expanded = attr('aria-expanded');
    if (expanded != null) states.push(expanded === 'true' ? '展開' : '折疊');
    // 已選取
    if (truthy(attr('aria-selected'))) states.push('已選取');
    // 必填
    if (el.required || truthy(attr('aria-required'))) states.push('必要的');
    // 唯讀
    if (el.readOnly || truthy(attr('aria-readonly'))) states.push('唯讀');
    // 輸入無效
    if (truthy(attr('aria-invalid'))) states.push('無效的輸入');
    // 目前項目（aria-current）
    if (truthy(attr('aria-current'))) states.push('目前');
    return states;
  }

  /**
   * 計算單一元素的 NVDA 報讀預覽 { name, role, roleEn, states }。
   * 依賴 axe.commons（vendor/axe.min.js 注入後可用）；不可用或計算失敗時
   * 回傳 null，UI 直接略過不顯示，不影響其他結果。
   */
  function nvdaPreview(el) {
    const commons = window.axe && window.axe.commons;
    if (!el || !commons || !commons.text || !commons.aria) return null;

    // aria-hidden="true"（含任一祖先）的元素被排除在無障礙樹外，NVDA 完全不朗讀，
    // 顯示報讀預覽會誤導。注意 aria-hidden=""（空字串、無效值）不符此選擇器，維持顯示。
    if (el.closest && el.closest('[aria-hidden="true"]')) return null;

    let name = '';
    let roleEn = null;
    try { name = (commons.text.accessibleText(el) || '').trim(); } catch (e) { /* 保底 */ }
    try { roleEn = commons.aria.getRole(el); } catch (e) { /* 保底 */ }

    // NVDA 不朗讀的純結構角色（generic 等）→ 直接略過，避免把整個容器的內文
    // 誤當成「名稱」念出來（例如未加地標的 <section> 會回傳一大段子孫文字）。
    const announcedRoleEn = roleEn && !NVDA_SILENT_ROLES[roleEn] ? roleEn : null;

    let roleZh = null;
    let nameRequired = false;
    if (announcedRoleEn === 'heading') {
      const lvl =
        Number(el.getAttribute('aria-level')) ||
        ({ H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 }[el.tagName] || 0);
      roleZh = lvl ? `標題第 ${lvl} 級` : '標題';
      nameRequired = true;
    } else if (announcedRoleEn) {
      roleZh = NVDA_ROLE_ZH[announcedRoleEn] || null;
      nameRequired = !!NVDA_NAME_REQUIRED[announcedRoleEn];
    }

    // 沒有可朗讀角色時（generic／null），NVDA 只讀內文、不當成獨立物件，
    // 顯示「NVDA 朗讀」反而誤導，略過不顯示。
    if (!roleZh && !announcedRoleEn) return null;

    return {
      name: name || null,                     // null 表示無可朗讀名稱
      role: roleZh,                           // 已核對的中文角色（含標題階層）；null 表示未收錄
      roleEn: roleZh ? null : announcedRoleEn, // 未收錄時保留英文 role 供 UI 標示，不杜撰中文
      nameRequired,                           // 此角色是否必須有名稱（決定是否顯示「無可朗讀名稱」）
      states: nvdaStates(el),
    };
  }

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
      // 讓每個結果 node 帶上 live DOM 元素（node.element），供 NVDA 報讀預覽計算；
      // 這些元素參照只在頁面端使用，不會進入回傳給 popup 的序列化資料
      elementRef: true,
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
          // 模擬 NVDA 報讀（可序列化的 { name, role, roleEn, states }；算不出時為 null）
          nvda: nvdaPreview(node.element),
        })),
      }));

    // axe.run 完成後會拆掉內部的虛擬 DOM 樹，使 commons.text/aria 無法運作
    // （呼叫會丟 "Cannot read properties of null"）。這裡重新 setup 重建樹，
    // 算完每個元素的 NVDA 報讀預覽後再 teardown，把頁面狀態還原乾淨。
    let didSetup = false;
    try {
      if (typeof window.axe.setup === 'function') {
        window.axe.setup(document);
        didSetup = true;
      }
    } catch (e) {
      // setup 失敗就略過預覽（nvdaPreview 內部會再保底回 null），不影響掃描結果
    }

    let serialized;
    try {
      serialized = {
        url: location.href,
        violations: pick(results.violations),
        incomplete: pick(results.incomplete),
      };
    } finally {
      if (didSetup) {
        try { window.axe.teardown(); } catch (e) { /* 還原失敗不影響已算好的結果 */ }
      }
    }
    return serialized;
  };
})();
