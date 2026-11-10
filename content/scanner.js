/**
 * content/scanner.js
 * 以 chrome.scripting.executeScript 注入到當前分頁（isolated world）。
 * 依賴：vendor/axe.min.js 需先注入，讓此環境有全域 axe 可用（scan／朗讀順序的角色
 *      與名稱計算依賴 axe.commons，且 axe.run 後需 axe.setup() 重建虛擬樹才可用）。
 *
 * 對外（popup）掛在 window 上的 API（供後續 executeScript 呼叫）：
 *   __rampA11yScan()              → axe 掃描 + 每個違規元素的 NVDA 報讀預覽（純資料）
 *   __rampA11yReadingOrder()      → 整頁線性化成 NVDA 朗讀順序 + 視覺落差 + 地標/表格/清單邊界
 *   __rampA11yHighlight(sel)      → 依 selector 高亮並捲動
 *   __rampA11yHighlightRO(i)      → 依朗讀順序索引高亮
 *   __rampA11yClear()             → 清除高亮
 *   __rampA11yLiveStart/Stop/Get/Clear() → 即時區域（aria-live）動態播報監看
 *   __rampA11yInternals           → 內部純函式的測試掛勾（test/unit 用）
 *
 * 檔案分節（依序）：
 *   高亮／樣式 → NVDA 報讀預覽（角色/值/狀態/位置/表格 對照與計算）
 *   → 朗讀順序（線性化、地標/表格/清單邊界、視覺落差 roComputeFlags）
 *   → 動態播報監看 → axe 掃描主流程 → 測試掛勾
 * 純函式（值/位置/狀態/表格/地標/落差偵測）皆有 test/unit 覆蓋，可秒級迭代。
 */
(() => {
  // 本檔的版本：擴充端取 manifest 版本（isolated world 可用 chrome.runtime）；
  // CLI 以 addScriptTag 注入主 world，沒有 chrome.runtime → 'cli'
  const VER =
    typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
      ? chrome.runtime.getManifest().version
      : 'cli';
  // 避免重複注入時重複定義；但版本不同（擴充更新後，已開分頁裡殘留舊版）要蓋過去
  if (window.__rampA11yScan && window.__rampA11yVer === VER) return;
  window.__rampA11yVer = VER;

  const HIGHLIGHT_CLASS = 'ramp-a11y-highlight';
  const PICK_CLASS = 'ramp-a11y-pick'; // 點選掃描範圍時的虛線外框
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
      .${PICK_CLASS} {
        outline: 3px dashed #0F766E !important;
        outline-offset: 2px !important;
        cursor: crosshair !important;
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
   * 內建對比檢查器的量測準備（popup 接著呼叫 captureVisibleTab 截圖）：把元素捲進視窗、清掉高亮
   * （高亮的外框會被截進去），等兩個畫格讓畫面穩定，回傳這個元素每一行文字的行框（CSS px，相對視窗）
   * 與字色。行框取自元素底下所有看得見的文字節點（Range.getClientRects），只留跟視窗有交集的。
   * @returns {Promise<null | {rects, viewportW, viewportH, color, fontSize, fontWeight}>}
   */
  window.__rampA11yContrastPrep = async function (selector) {
    let el;
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return null;
    }
    if (!el) return null;
    window.__rampA11yClear();
    if (window.__rampA11yTabOverlay) window.__rampA11yTabOverlay(false);
    el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rects = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
        rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }
    const cs = getComputedStyle(el);
    return {
      rects,
      viewportW: innerWidth,
      viewportH: innerHeight,
      color: cs.color,
      fontSize: parseFloat(cs.fontSize) || 0,
      fontWeight: cs.fontWeight,
    };
  };

  /**
   * 局部掃描的 axe context。include 對到的每一個元素都掃（可以是一組彈窗），exclude 從裡面挖掉。
   * @returns {{context, info} | {error: 'invalid-selector'|'no-match', selector}}
   */
  function scopeContext(opts) {
    const include = typeof opts.include === 'string' ? opts.include.trim() : '';
    const exclude = typeof opts.exclude === 'string' ? opts.exclude.trim() : '';
    if (!include && !exclude) return { context: document, info: null };
    const count = (sel) => {
      try {
        return document.querySelectorAll(sel).length;
      } catch (e) {
        return -1;
      }
    };
    const inc = include ? count(include) : null;
    const exc = exclude ? count(exclude) : null;
    if (inc === -1) return { error: 'invalid-selector', selector: include };
    if (exc === -1) return { error: 'invalid-selector', selector: exclude };
    if (inc === 0) return { error: 'no-match', selector: include };
    const context = {};
    if (include) context.include = [include];
    if (exclude) context.exclude = [exclude];
    return {
      context,
      info: {
        include: include || null,
        includeCount: inc,
        exclude: exclude || null,
        excludeCount: exc,
      },
    };
  }

  // ===== 在頁面上點選掃描範圍 =====
  // popup 一失焦就關，沒辦法邊開著邊點頁面：popup 開始點選後自己關掉，使用者點一個元素，
  // 選擇器存在頁面端（window.__rampA11yPicked），再按一次工具列圖示，popup 讀回來填進「掃描範圍」。
  const PICK_TOAST_ID = 'ramp-a11y-pick-toast';
  let pickState = null;

  function pickToast(text) {
    let t = document.getElementById(PICK_TOAST_ID);
    if (!t) {
      t = document.createElement('div');
      t.id = PICK_TOAST_ID;
      t.setAttribute('role', 'status');
      t.style.cssText =
        'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'max-width:90vw;padding:8px 14px;border-radius:8px;background:#0F766E;color:#fff;' +
        'font:14px/1.5 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
      document.documentElement.appendChild(t);
    }
    t.textContent = text; // 頁面來源的選擇器只走 textContent，不進 innerHTML
    return t;
  }

  /**
   * 點到的元素 → 選擇器。先用 axe 自己的 getSelector（跟掃描結果的 target 同一套寫法）；
   * 它要 axe.setup() 建好的選擇器資料，用完 teardown。axe 不在或失敗時退回：有 id 用 id，
   * 否則從最近一個有 id 的祖先（或 html）一路寫 nth-of-type。
   */
  function pickSelector(el) {
    if (window.axe && window.axe.utils && typeof window.axe.setup === 'function') {
      try {
        window.axe.setup(document);
        try {
          const s = window.axe.utils.getSelector(el);
          if (s && document.querySelector(s) === el) return s;
        } finally {
          window.axe.teardown();
        }
      } catch (err) {
        /* 退回自己算 */
      }
    }
    const esc = (v) =>
      window.CSS && typeof window.CSS.escape === 'function'
        ? window.CSS.escape(v)
        : String(v).replace(/[^\w-]/g, (c) => '\\' + c);
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + esc(n.id)).length === 1) {
        parts.unshift('#' + esc(n.id));
        break;
      }
      const tag = n.localName;
      if (n === document.documentElement) {
        parts.unshift(tag);
        break;
      }
      let i = 1;
      for (let p = n.previousElementSibling; p; p = p.previousElementSibling)
        if (p.localName === tag) i++;
      parts.unshift(`${tag}:nth-of-type(${i})`);
    }
    const s = parts.join(' > ');
    return s && document.querySelector(s) === el ? s : null;
  }

  window.__rampA11yPickStop = function () {
    if (!pickState) return;
    document.removeEventListener('mouseover', pickState.over, true);
    document.removeEventListener('click', pickState.click, true);
    document.removeEventListener('keydown', pickState.key, true);
    document.querySelectorAll('.' + PICK_CLASS).forEach((el) => el.classList.remove(PICK_CLASS));
    pickState = null;
  };

  window.__rampA11yPickStart = function () {
    window.__rampA11yPickStop();
    window.__rampA11yClear();
    ensureStyle();
    const done = (msg) => {
      window.__rampA11yPickStop();
      const t = pickToast(msg);
      setTimeout(() => t.remove(), 6000);
    };
    const over = (e) => {
      document.querySelectorAll('.' + PICK_CLASS).forEach((el) => el.classList.remove(PICK_CLASS));
      if (e.target && e.target.classList) e.target.classList.add(PICK_CLASS);
    };
    const click = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target;
      // 先拿掉點選外框的 class，不然 getSelector 可能把 .ramp-a11y-pick 寫進選擇器
      document.querySelectorAll('.' + PICK_CLASS).forEach((x) => x.classList.remove(PICK_CLASS));
      const sel = pickSelector(el);
      if (!sel) {
        done('無法為這個元素產生選擇器，請改用手動輸入');
        return;
      }
      window.__rampA11yPicked = sel;
      done(`已選取 ${sel}——再按一次 Ramp 圖示即可只掃這一塊`);
    };
    const key = (e) => {
      if (e.key === 'Escape') done('已取消點選');
    };
    pickState = { over, click, key };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    pickToast('點選要掃描的區塊（Esc 取消）');
    return true;
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
    textbox: '編輯區',
    searchbox: '編輯區',
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
    button: 1,
    link: 1,
    checkbox: 1,
    radio: 1,
    textbox: 1,
    searchbox: 1,
    combobox: 1,
    listbox: 1,
    switch: 1,
    menuitem: 1,
    tab: 1,
    slider: 1,
    spinbutton: 1,
    progressbar: 1,
    img: 1,
    treeitem: 1,
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
      states.push(
        ariaChecked === 'mixed' ? '部分勾選' : ariaChecked === 'true' ? '勾選' : '沒勾選',
      );
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
    // 多行編輯區
    if (el.tagName === 'TEXTAREA' || attr('aria-multiline') === 'true') states.push('多行');
    // 自動完成
    const ac = attr('aria-autocomplete');
    if (ac && ac !== 'none') states.push('有自動完成');
    // 有子選單／彈出（僅 menu／true 用「子功能表」，其他 popup 型別不臆測）
    const hp = attr('aria-haspopup');
    if (hp === 'true' || hp === 'menu') states.push('子功能表');
    // 欄標題排序狀態
    const sort = attr('aria-sort');
    if (sort === 'ascending') states.push('遞增排序');
    else if (sort === 'descending') states.push('遞減排序');
    else if (sort === 'other') states.push('已排序');
    // 忙碌
    if (attr('aria-busy') === 'true') states.push('忙碌中');
    // 目前項目（aria-current）
    if (truthy(attr('aria-current'))) states.push('目前');
    return states;
  }

  /**
   * 元素的「值」——NVDA 會念出的目前內容：
   * 編輯區的輸入內容、下拉的選中項、滑桿/微調的數值、進度列的百分比。
   */
  function nvdaValue(el, roleEn) {
    const attr = (n) => el.getAttribute(n);
    if (
      roleEn === 'progressbar' ||
      roleEn === 'meter' ||
      el.tagName === 'PROGRESS' ||
      el.tagName === 'METER'
    ) {
      // 經真 NVDA 對照驗證：靜態讀出的是原始值（如「75」），不換算成「百分之 N」
      //（「百分之 %d」是進度「更新時」的播報用語，非靜態快照）
      const vt = attr('aria-valuetext');
      if (vt) return vt.trim();
      const now = attr('aria-valuenow');
      if (now != null) return now.trim();
      return el.value != null && el.value !== '' ? String(el.value) : null;
    }
    if (roleEn === 'slider' || roleEn === 'spinbutton') {
      const vt = attr('aria-valuetext');
      if (vt) return vt.trim();
      const now = attr('aria-valuenow');
      if (now != null) return now.trim();
      return el.value != null && el.value !== '' ? String(el.value) : null;
    }
    if (el.tagName === 'SELECT') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      return opt ? (opt.textContent || '').trim() || null : null;
    }
    if (roleEn === 'combobox') {
      const vt = attr('aria-valuetext');
      if (vt) return vt.trim();
      return el.value != null && String(el.value).trim() ? String(el.value).trim() : null;
    }
    if (roleEn === 'textbox' || roleEn === 'searchbox') {
      if (el.type === 'password') return null; // 密碼欄不朗讀內容
      const v = (el.value != null ? String(el.value) : '').trim();
      return v || null;
    }
    return null;
  }

  /** role 的第一個 token 是否為 presentation/none，且沒有觸發 ARIA 的「呈現性角色衝突
   *  解決」——這類元素被拔除語義，NVDA 不念表格座標、地標或清單邊界（排版表格的補救手段）。
   *  衝突解決：元素帶全域 ARIA 屬性（aria-label 等）或可聚焦時，瀏覽器會忽略
   *  presentation、保留原生語義（真 NVDA 對照證實：<nav role=presentation aria-label>
   *  仍念地標）。 */
  // ARIA 1.2 的全域狀態／屬性（含已標 deprecated 但瀏覽器仍認的幾個）
  const PRESENTATION_OVERRIDES = [
    'aria-atomic',
    'aria-busy',
    'aria-controls',
    'aria-current',
    'aria-describedby',
    'aria-description',
    'aria-details',
    'aria-disabled',
    'aria-dropeffect',
    'aria-errormessage',
    'aria-flowto',
    'aria-grabbed',
    'aria-haspopup',
    'aria-invalid',
    'aria-keyshortcuts',
    'aria-label',
    'aria-labelledby',
    'aria-live',
    'aria-owns',
    'aria-relevant',
    'aria-roledescription',
  ];
  // 可聚焦也會觸發衝突解決（presentation 被忽略）
  const PRESENTATION_FOCUSABLE =
    'a[href],area[href],button,input,select,textarea,iframe,[tabindex],[contenteditable]:not([contenteditable="false"])';
  function isPresentational(el) {
    const r = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (r !== 'presentation' && r !== 'none') return false;
    // 空值的屬性視同沒寫（瀏覽器對空字串的 ARIA 屬性一律當未設定）
    if (PRESENTATION_OVERRIDES.some((a) => (el.getAttribute(a) || '').trim())) return false;
    return !(el.matches && el.matches(PRESENTATION_FOCUSABLE));
  }

  /** 集合位置「{總數} 之 {序位}」（aria-posinset/setsize，或原生 li/option/radio 計算） */
  function nvdaPosition(el, roleEn) {
    const pos = parseInt(el.getAttribute('aria-posinset'), 10);
    const size = parseInt(el.getAttribute('aria-setsize'), 10);
    if (!isNaN(pos) && !isNaN(size) && size > 0) return size + ' 之 ' + pos;
    const parent = el.parentElement;
    if (el.tagName === 'LI' && parent && /^(UL|OL|MENU)$/.test(parent.tagName)) {
      const items = Array.prototype.filter.call(parent.children, (c) => c.tagName === 'LI');
      const i = items.indexOf(el);
      if (i >= 0) return items.length + ' 之 ' + (i + 1);
    }
    if (el.tagName === 'OPTION') {
      const sel = el.closest('select');
      if (sel) {
        const opts = Array.prototype.slice.call(sel.querySelectorAll('option'));
        const i = opts.indexOf(el);
        if (i >= 0) return opts.length + ' 之 ' + (i + 1);
      }
    }
    if (roleEn === 'radio' && el.name) {
      const nm = window.CSS && CSS.escape ? CSS.escape(el.name) : el.name;
      // 以所屬表單為群組範圍——同名 radio group 可以存在於不同 form；表單外的同名 radio
      // 自成一組（el.form 為 null）。用 r.form 比對才涵蓋以 form= 屬性關聯到表單的 radio
      const radios = Array.prototype.filter.call(
        document.querySelectorAll('input[type="radio"][name="' + nm + '"]'),
        (r) => r.form === el.form,
      );
      const i = radios.indexOf(el);
      if (i >= 0) return radios.length + ' 之 ' + (i + 1);
    }
    return null;
  }

  /** ARIA 清單的「直屬」項目數——巢狀清單的 listitem 屬於內層清單，
   *  不能用 querySelectorAll 全撈（會把內層項目算進外層）。 */
  function ariaListItemCount(el) {
    return Array.prototype.filter.call(
      el.querySelectorAll('[role="listitem"]'),
      (li) => li.parentElement && li.parentElement.closest('[role="list"],ul,ol,menu') === el,
    ).length;
  }

  /** 清單的項目數「有 N 項」——僅真清單（ul/ol/role=list）；
   *  經真 NVDA 對照驗證：清單方塊（listbox／select multiple）不念項目數 */
  function nvdaItemCount(el, roleEn) {
    if (roleEn !== 'list') return null;
    const n =
      el.tagName === 'UL' || el.tagName === 'OL' || el.tagName === 'MENU'
        ? Array.prototype.filter.call(el.children, (c) => c.tagName === 'LI').length
        : ariaListItemCount(el);
    return n > 0 ? '有 ' + n + ' 項' : null;
  }

  /** 描述——NVDA 會在名稱／角色之後補念的說明（aria-describedby，或 title） */
  function nvdaDescription(el, name) {
    const ref = el.getAttribute('aria-describedby');
    if (ref) {
      const txt = ref
        .trim()
        .split(/\s+/)
        .map((id) => {
          const t = document.getElementById(id);
          return t ? (t.textContent || '').trim() : '';
        })
        .filter(Boolean)
        .join(' ');
      if (txt) return txt.slice(0, 100);
    }
    const title = (el.getAttribute('title') || '').trim();
    if (title && title !== name) return title.slice(0, 100); // title 非名稱來源時作描述
    return null;
  }

  /**
   * 表格儲存格：座標「第 N 列 第 N 欄」與關聯的欄/列標題（NVDA 進入儲存格會念）。
   * 僅支援原生 <table>（cellIndex/rowIndex）；ARIA 網格暫不計算。
   */
  // 表格格點模型：正確處理 colspan/rowspan——把每個儲存格攤到它實際佔用的
  // 列×欄格點，才能算對「第 N 列 第 N 欄」與欄/列標題。以 WeakMap 快取整張表的
  // 格點（同一張表的多個儲存格共用，避免每格重算）。
  // 每次掃描/線性化進入時重建（__rampA11yScan／__rampA11yReadingOrder 開頭）——
  // scanner 注入一次後常駐 isolated world，跨掃描留著快取會讓「頁面表格變動後重掃」
  // 拿到舊格點：座標整排錯位、欄/列標題對錯格
  let tableGridCache = new WeakMap();
  function tableGrid(table) {
    let g = tableGridCache.get(table);
    if (g) return g;
    const rows = table.rows; // 全表 <tr>，文件順序
    const occ = []; // occ[r][c] = 佔用該格點的儲存格
    const coords = new Map(); // 儲存格 → { row, col }（1-based，左上格）
    let colCount = 0;
    for (let r = 0; r < rows.length; r++) {
      if (!occ[r]) occ[r] = [];
      let c = 0;
      const cells = rows[r].cells;
      for (let i = 0; i < cells.length; i++) {
        const cellEl = cells[i];
        while (occ[r][c]) c++; // 跳過被上方 rowspan 佔用的欄
        const colspan = Math.max(1, cellEl.colSpan || 1);
        const rowspan = Math.max(1, cellEl.rowSpan || 1);
        coords.set(cellEl, { row: r + 1, col: c + 1 });
        for (let dr = 0; dr < rowspan; dr++) {
          for (let dc = 0; dc < colspan; dc++) {
            const rr = r + dr,
              cc = c + dc;
            if (!occ[rr]) occ[rr] = [];
            occ[rr][cc] = cellEl;
          }
        }
        c += colspan;
        if (c > colCount) colCount = c;
      }
    }
    g = { coords, occ, colCount, rowCount: rows.length };
    tableGridCache.set(table, g);
    return g;
  }

  /** 儲存格座標「第 N 列 第 N 欄」與關聯欄/列標題（正確處理 colspan/rowspan） */
  function nvdaTableCell(el) {
    if (el.tagName !== 'TD' && el.tagName !== 'TH') return null;
    const table = el.closest('table');
    if (!table || isPresentational(table)) return null; // 排版表格不念座標

    const grid = tableGrid(table);
    const pos = grid.coords.get(el);
    if (!pos) return null;
    const coord = '第 ' + pos.row + ' 列 第 ' + pos.col + ' 欄';
    // 欄標題＝該欄第一列的格（若為 th）；列標題＝該列第一欄的格（若為 th）
    let colHeader = null,
      rowHeader = null;
    const topCell = grid.occ[0] && grid.occ[0][pos.col - 1];
    if (topCell && topCell.tagName === 'TH' && topCell !== el)
      colHeader = (topCell.textContent || '').trim() || null;
    // 列標題＝該列第一欄的 th；但「整列都是 th」的表頭列裡，左邊那格是欄標題而非
    // 列標題——真 NVDA 對表頭列的「數量」只念「第 2 欄, 數量」，不帶「品項」
    const rowCells = grid.occ[pos.row - 1] || [];
    const isHeaderRow = rowCells.length > 0 && rowCells.every((c) => c && c.tagName === 'TH');
    const leftCell = rowCells[0];
    if (!isHeaderRow && leftCell && leftCell.tagName === 'TH' && leftCell !== el)
      rowHeader = (leftCell.textContent || '').trim() || null;
    return { coord, colHeader, rowHeader };
  }

  /** 表格維度「表格有 N 列 M 欄」（列先欄後——經真 NVDA 對照驗證的實際語序） */
  function nvdaTableDims(el) {
    if (el.tagName !== 'TABLE' || isPresentational(el)) return null;
    const grid = tableGrid(el);
    return grid.rowCount && grid.colCount
      ? '表格有 ' + grid.rowCount + ' 列 ' + grid.colCount + ' 欄'
      : null;
  }

  /**
   * 計算單一元素的 NVDA 報讀預覽
   * { name, role, roleEn, nameRequired, value, states, position, itemCount, description }。
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
    try {
      name = (commons.text.accessibleText(el) || '').trim();
    } catch (e) {
      /* 保底 */
    }
    try {
      roleEn = commons.aria.getRole(el);
    } catch (e) {
      /* 保底 */
    }

    // NVDA 不朗讀的純結構角色（generic 等）→ 直接略過，避免把整個容器的內文
    // 誤當成「名稱」念出來（例如未加地標的 <section> 會回傳一大段子孫文字）。
    const announcedRoleEn = roleEn && !NVDA_SILENT_ROLES[roleEn] ? roleEn : null;

    let roleZh = null;
    let nameRequired = false;
    if (announcedRoleEn === 'heading') {
      const lvl =
        Number(el.getAttribute('aria-level')) ||
        { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 }[el.tagName] ||
        0;
      roleZh = lvl ? `標題第 ${lvl} 級` : '標題';
      nameRequired = true;
    } else if (announcedRoleEn) {
      roleZh = NVDA_ROLE_ZH[announcedRoleEn] || null;
      nameRequired = !!NVDA_NAME_REQUIRED[announcedRoleEn];
      // 帶 aria-haspopup 的按鈕，真實 NVDA 念「功能表按鈕」（經真 NVDA 對照驗證）
      if (announcedRoleEn === 'button') {
        const hp = el.getAttribute('aria-haspopup');
        if (hp === 'true' || hp === 'menu') roleZh = '功能表按鈕';
      }
    }

    // 沒有可朗讀角色時（generic／null），NVDA 只讀內文、不當成獨立物件，
    // 顯示「NVDA 朗讀」反而誤導，略過不顯示。
    if (!roleZh && !announcedRoleEn) return null;

    const value = nvdaValue(el, announcedRoleEn);
    let position = nvdaPosition(el, announcedRoleEn);
    let itemCount = nvdaItemCount(el, announcedRoleEn);
    let description = nvdaDescription(el, name);
    // 表格：儲存格座標＋標題、表格維度
    const cell = nvdaTableCell(el);
    if (cell) {
      position = position || cell.coord;
      const heads = [cell.colHeader, cell.rowHeader].filter(Boolean).join('・');
      if (heads) description = description ? description + '・' + heads : heads;
    }
    const dims = nvdaTableDims(el);
    if (dims) itemCount = itemCount || dims;
    return {
      name: name || null, // null 表示無可朗讀名稱
      role: roleZh, // 已核對的中文角色（含標題階層）；null 表示未收錄
      roleEn: roleZh ? null : announcedRoleEn, // 未收錄時保留英文 role 供 UI 標示，不杜撰中文
      nameRequired, // 此角色是否必須有名稱（決定是否顯示「無可朗讀名稱」）
      value: value ? value.slice(0, 60) : null, // 目前值／內容（編輯區、下拉、滑桿、進度）
      states: nvdaStates(el),
      position, // 集合位置「N 之 M」或儲存格座標「第 N 列 第 N 欄」
      itemCount, // 清單項目數「有 N 項」或表格維度「表格有 N 欄 M 列」
      description, // aria-describedby／title 描述，或儲存格的欄/列標題
    };
  }

  // ===== 朗讀順序預覽（第二階段）=====
  // 把整頁「線性化」成螢幕報讀軟體實際念出的順序（NVDA 瀏覽模式依 DOM 順序走），
  // 再比對視覺順序：標出同一視覺列上「畫面由左到右」與「朗讀先後」相反的落差
  // （flex order、float:right、RTL 等造成的 WCAG 1.3.2「有意義順序」問題）。

  const RO_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'LINK', 'META']);
  const RO_OBJECT_TAGS = new Set([
    'A',
    'BUTTON',
    'INPUT',
    'SELECT',
    'TEXTAREA',
    'IMG',
    'SVG',
    'IFRAME',
    'AUDIO',
    'VIDEO',
    'SUMMARY',
    'AREA',
    'CANVAS',
    'PROGRESS',
    'METER',
  ]);
  const RO_WIDGET_ROLES = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'slider',
    'spinbutton',
    'combobox',
    'textbox',
    'searchbox',
    'option',
    'img',
    'progressbar',
    'treeitem',
  ]);
  const RO_OBJ_FALLBACK = {
    IFRAME: '框架',
    SVG: '圖形',
    AUDIO: '音訊',
    VIDEO: '視訊',
    SUMMARY: '摘要',
    CANVAS: '畫布',
    AREA: '熱區',
  };

  function roIsHidden(el) {
    if (el.closest && el.closest('[aria-hidden="true"]')) return true;
    if (typeof el.checkVisibility === 'function') {
      // checkVisibilityCSS 是 Chrome 105 起的原始選項名，visibilityProperty 是
      // 約 121 起的規範別名——兩個都傳，否則 105–120 會忽略未知選項、
      // 漏掉 visibility:hidden 的排除（規範允許同義並存）
      return !el.checkVisibility({
        checkVisibilityCSS: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
      });
    }
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse';
  }
  // tagName 的大小寫陷阱：HTML 元素回大寫，SVG 等外來命名空間保留原字（inline <svg>
  // 是小寫 'svg'）。所有 tagName 查表一律先 toUpperCase，否則 SVG 永遠對不上
  // RO_OBJECT_TAGS 而被走訪進子樹（aria-label 遺失、<text> 內文變一般文字停點）。
  function roTag(el) {
    return el.tagName.toUpperCase();
  }
  /**
   * inline SVG 的可朗讀名稱，依序：aria-labelledby 參照的文字 → aria-label → 直屬 <title>
   * → 內含 <text> 的文字。最後一項是真 NVDA 對照（2026-10）的結果：沒有名稱但內含
   * <text> 的 SVG，NVDA 念「圖片, 裝飾內文」——內文成了圖片的名稱，不是一般文字。
   * axe 對裸 SVG 常算不出 accessible name，所以這裡自己補。
   */
  function roSvgName(el) {
    const ref = (el.getAttribute('aria-labelledby') || '').trim();
    if (ref) {
      const t = ref
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? (n.textContent || '').trim() : '';
        })
        .filter(Boolean)
        .join(' ');
      if (t) return t;
    }
    const label = (el.getAttribute('aria-label') || '').trim();
    if (label) return label;
    const title = Array.prototype.find.call(el.children, (c) => roTag(c) === 'TITLE');
    if (title && (title.textContent || '').trim()) return title.textContent.trim();
    const texts = Array.prototype.map
      .call(el.getElementsByTagName('text'), (t) => (t.textContent || '').trim())
      .filter(Boolean)
      .join(' ');
    return texts || null;
  }
  function roIsObject(el) {
    const t = roTag(el);
    // 無 href 的 <a> 不是連結（NVDA 不當成獨立物件）
    if (t === 'A' && !el.getAttribute('href') && !el.getAttribute('role')) return false;
    // 無名稱、無 role 的 inline SVG（純裝飾圖示）：真 NVDA 對照（2026-10）完全不念，
    // 不當成物件停點
    if (t === 'SVG' && !el.getAttribute('role') && !roSvgName(el)) return false;
    if (RO_OBJECT_TAGS.has(t)) return true;
    const r = el.getAttribute('role');
    return !!(r && RO_WIDGET_ROLES.has(r.trim().split(/\s+/)[0]));
  }
  function roIsBlock(el) {
    const d = getComputedStyle(el).display;
    return (
      d &&
      d !== 'inline' &&
      d !== 'inline-block' &&
      d !== 'inline-flex' &&
      d !== 'inline-grid' &&
      d !== 'contents'
    );
  }
  function roBlockRole(el) {
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) return '標題第 ' + t[1] + ' 級';
    if (t === 'LI') {
      // 被拔除語義的清單（role=presentation）裡的項目不再是清單項目
      const list = el.closest('ul,ol,menu,[role]');
      return list && isPresentational(list) ? '文字' : '清單項目';
    }
    if (t === 'TH' || t === 'TD') {
      const tb = el.closest('table');
      if (tb && isPresentational(tb)) return '文字'; // 排版表格的格子只是文字
      return t === 'TH' ? '表頭儲存格' : '儲存格';
    }
    if (t === 'BLOCKQUOTE') return '引述';
    if (t === 'FIGCAPTION') return '圖說';
    if (t === 'DT') return '詞彙';
    if (t === 'DD') return '釋義';
    return '文字';
  }

  // 地標名稱（校對自 NVDA 官方 zh_TW）
  const RO_LANDMARK_ZH = {
    banner: '橫幅區',
    navigation: '導覽區',
    main: '主要內容區',
    complementary: '補充區',
    contentinfo: '資訊區',
    region: '區域',
    search: '搜尋區',
    form: '表單區',
  };
  function roHasName(el) {
    return !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'));
  }
  /** 元素是否為地標（含隱含地標的 HTML 元素）→ 回傳地標中文名，否則 null */
  function roLandmark(el) {
    if (isPresentational(el)) return null; // <nav role="presentation"> 等被拔除語義
    const roleAttr = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (roleAttr && RO_LANDMARK_ZH[roleAttr]) {
      if ((roleAttr === 'region' || roleAttr === 'form') && !roHasName(el)) return null;
      return RO_LANDMARK_ZH[roleAttr];
    }
    switch (el.tagName) {
      case 'NAV':
        return '導覽區';
      case 'MAIN':
        return '主要內容區';
      case 'ASIDE':
        return '補充區';
      // header/footer 僅在非巢狀於 article/section 等時才是地標
      case 'HEADER':
        return el.closest('article,aside,main,nav,section') ? null : '橫幅區';
      case 'FOOTER':
        return el.closest('article,aside,main,nav,section') ? null : '資訊區';
      case 'SECTION':
        return roHasName(el) ? '區域' : null; // 具名 section 才是地標
      case 'FORM':
        return roHasName(el) ? '表單區' : null;
      default:
        return null;
    }
  }
  /** 需在朗讀順序中標示邊界的區域（地標／表格），含進入與離開的朗讀文字 */
  function roBoundary(el) {
    const lm = roLandmark(el);
    if (lm) {
      // 「地標」後綴為真 NVDA 實際播報格式（如「主要選單, 導覽區 地標」）
      const label = (el.getAttribute('aria-label') || '').trim();
      return {
        kind: 'landmark',
        enter: (label ? label + ' ' : '') + lm + ' 地標',
        exit: '離開' + lm,
      };
    }
    // role=presentation/none 的表格與清單被拔除語義，NVDA 不播邊界
    if (el.tagName === 'TABLE' && !isPresentational(el)) {
      return { kind: 'table', enter: nvdaTableDims(el) || '表格', exit: '離開表格' };
    }
    // 真清單（ul/ol/role=list）念「清單 有 N 項」；listbox 不念項目數（經真 NVDA 驗證）
    const roleAttr = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    const isNativeList = el.tagName === 'UL' || el.tagName === 'OL' || el.tagName === 'MENU';
    if ((isNativeList && !isPresentational(el)) || roleAttr === 'list') {
      // 原生清單數 <li> 子元素（<ul role="list"> 的 li 是隱含 listitem，撈屬性會數到 0）；
      // 純 ARIA 清單數「直屬」的 [role=listitem]
      const n = isNativeList
        ? Array.prototype.filter.call(el.children, (c) => c.tagName === 'LI').length
        : ariaListItemCount(el);
      if (n > 0) return { kind: 'list', enter: '清單 有 ' + n + ' 項', exit: '離開清單' };
    }
    return null;
  }

  function roRect(el) {
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, left: r.left + window.scrollX, w: r.width, h: r.height };
  }
  function roRangeRect(nodes) {
    try {
      const range = document.createRange();
      range.setStartBefore(nodes[0]);
      range.setEndAfter(nodes[nodes.length - 1]);
      const r = range.getBoundingClientRect();
      if (r.width || r.height)
        return {
          top: r.top + window.scrollY,
          left: r.left + window.scrollX,
          w: r.width,
          h: r.height,
        };
    } catch (e) {
      /* 保底 */
    }
    return null;
  }

  // 純函式：依幾何範圍偵測「同一視覺列上朗讀順序反序」的落差，標記 flagged 並回傳筆數。
  // 抽出為獨立純函式以便單元測試（輸入為帶 rect 的停點陣列，不依賴 DOM／版面）。
  const RO_ROW_TOL = 14; // 視覺「同列」的 top 容差（px）
  function roComputeFlags(stops) {
    const R = stops.filter((s) => s.rect && s.rect.w > 0 && s.rect.h > 0);
    R.forEach((s, k) => {
      s._read = k;
    });
    const sorted = R.slice().sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const rows = [];
    let cur = null;
    for (const s of sorted) {
      if (!cur || s.rect.top - cur.top0 > RO_ROW_TOL) {
        cur = { top0: s.rect.top, items: [s] };
        rows.push(cur);
      } else cur.items.push(s);
    }
    let flaggedCount = 0;
    for (const r of rows) {
      r.items.sort((a, b) => a.rect.left - b.rect.left);
      for (let j = 0; j < r.items.length - 1; j++) {
        if (r.items[j]._read > r.items[j + 1]._read) {
          if (!r.items[j].flagged) {
            r.items[j].flagged = true;
            flaggedCount++;
          }
          if (!r.items[j + 1].flagged) {
            r.items[j + 1].flagged = true;
            flaggedCount++;
          }
        }
      }
    }
    return flaggedCount;
  }

  window.__rampA11yReadingOrder = function () {
    tableGridCache = new WeakMap(); // 頁面可能已變動，格點快取只在單次線性化內有效
    // 清掉上次留下的定位屬性，避免索引錯亂
    document.querySelectorAll('[data-ramp-ro]').forEach((e) => e.removeAttribute('data-ramp-ro'));

    const MAX = 500;
    const stops = [];
    // nvdaPreview 依賴 axe 虛擬樹（getRole／accessibleText），需先 setup 重建
    let didSetup = false;
    try {
      if (window.axe && typeof window.axe.setup === 'function') {
        window.axe.setup(document);
        didSetup = true;
      }
    } catch (e) {
      /* setup 失敗仍可線性化，物件名稱改用保底 */
    }

    let buf = '',
      bufNodes = [],
      bufEl = null;
    function flush() {
      const text = buf.replace(/\s+/g, ' ').trim();
      const nodes = bufNodes,
        el = bufEl;
      buf = '';
      bufNodes = [];
      bufEl = null;
      if (!text || !el || stops.length >= MAX) return;
      const roIndex = stops.length;
      try {
        el.setAttribute('data-ramp-ro', roIndex);
      } catch (e) {
        /* 忽略 */
      }
      const stop = {
        roIndex,
        kind: 'text',
        role: roBlockRole(el),
        text: text.slice(0, 140),
        name: null,
        nameRequired: false,
        states: [],
        value: null,
        position: null,
        itemCount: null,
        description: null,
        flagged: false,
        rect: roRangeRect(nodes) || roRect(el),
      };
      // 表格儲存格：補座標與欄/列標題
      if (el.tagName === 'TD' || el.tagName === 'TH') {
        const cell = nvdaTableCell(el);
        if (cell) {
          stop.position = cell.coord;
          const h = [cell.colHeader, cell.rowHeader].filter(Boolean).join('・');
          if (h) stop.description = h;
        }
      } else if (el.tagName === 'LI') {
        // 清單項目：補集合位置「N 之 M」（NVDA 會念）；被拔除語義的清單不念
        if (!(el.parentElement && isPresentational(el.parentElement))) {
          const pos = nvdaPosition(el, 'listitem');
          if (pos) stop.position = pos;
        }
      }
      stops.push(stop);
    }
    // 地標／表格的進入‧離開邊界標記（無幾何範圍，不參與視覺落差判定）
    function pushBoundary(kind, text, dir) {
      if (stops.length >= MAX) return;
      stops.push({
        roIndex: stops.length,
        kind,
        boundary: dir,
        role: null,
        text,
        name: null,
        nameRequired: false,
        states: [],
        value: null,
        position: null,
        itemCount: null,
        description: null,
        flagged: false,
        rect: null,
      });
    }
    function pushObject(c) {
      if (stops.length >= MAX) return;
      flush(); // 物件前的文字先斷句，維持朗讀先後
      const roIndex = stops.length;
      let name = null,
        role = null,
        states = [],
        nameRequired = false;
      let value = null,
        position = null,
        itemCount = null,
        description = null;
      const nv = nvdaPreview(c);
      if (nv) {
        name = nv.name;
        role = nv.role || nv.roleEn;
        states = nv.states;
        nameRequired = nv.nameRequired;
        value = nv.value;
        position = nv.position;
        itemCount = nv.itemCount;
        description = nv.description;
      } else {
        role = RO_OBJ_FALLBACK[roTag(c)] || c.tagName.toLowerCase();
      } // getRole 無角色時的保底
      // 無 role 屬性的裸 inline SVG：axe 的 getRole 可能回 null 或 graphics-document
      // 這類 NVDA 翻譯未收錄的角色。真 NVDA 對照（2026-10）念的是「圖片, 營收圖表」——
      // 用 NVDA 的 img 用詞；名稱保底走 roSvgName（axe 對裸 SVG 常算不出 preview）
      if (roTag(c) === 'SVG') {
        if (!(nv && nv.role)) role = NVDA_ROLE_ZH.img;
        if (!name) name = roSvgName(c);
      }
      // 若物件是清單項目的唯一內容（li 無自身文字，如 <li><a>選單</a></li>），
      // 把清單位置掛到物件上——NVDA 會在念出該連結時一併報位置。
      // 被拔除語義的清單（<ul role="presentation">，選單最常見的寫法）不報位置
      //（真 NVDA 對照：只念「同頁, 連結, 選單一」）
      if (!position && c.closest) {
        const li = c.closest('li');
        if (
          li &&
          li.parentElement &&
          /^(UL|OL|MENU)$/.test(li.parentElement.tagName) &&
          !isPresentational(li.parentElement)
        ) {
          const hasOwnText = Array.prototype.some.call(
            li.childNodes,
            (n) => n.nodeType === 3 && n.nodeValue.trim(),
          );
          if (!hasOwnText) {
            const lp = nvdaPosition(li, 'listitem');
            if (lp) position = lp;
          }
        }
      }
      try {
        c.setAttribute('data-ramp-ro', roIndex);
      } catch (e) {
        /* 忽略 */
      }
      stops.push({
        roIndex,
        kind: 'object',
        role,
        text: null,
        name,
        nameRequired,
        states,
        value,
        position,
        itemCount,
        description,
        flagged: false,
        rect: roRect(c),
      });
    }
    function walk(el, blockEl) {
      for (let c = el.firstChild; c && stops.length < MAX; c = c.nextSibling) {
        if (c.nodeType === 3) {
          // 文字節點：累積到目前區塊的朗讀緩衝
          if (c.nodeValue && c.nodeValue.trim()) {
            if (!bufEl) bufEl = blockEl;
            bufNodes.push(c);
            buf += c.nodeValue;
          }
          continue;
        }
        if (c.nodeType !== 1) continue;
        if (RO_SKIP_TAGS.has(roTag(c)) || roIsHidden(c)) continue;
        if (roIsObject(c)) {
          pushObject(c);
          continue;
        } // 物件為獨立停點，不深入其子樹
        const bd = roBoundary(c); // 地標／表格邊界
        const blk = roIsBlock(c);
        if (blk || bd) flush(); // 進入區塊/邊界前先斷句
        if (bd) pushBoundary(bd.kind, bd.enter, 'enter');
        walk(c, blk || bd ? c : blockEl);
        if (blk || bd) flush(); // 離開區塊/邊界後再斷句
        if (bd) pushBoundary(bd.kind, bd.exit, 'exit');
      }
    }
    try {
      walk(document.body, document.body);
      flush();
    } finally {
      if (didSetup) {
        try {
          window.axe.teardown();
        } catch (e) {
          /* 忽略 */
        }
      }
    }

    // 視覺順序比對：標記同一視覺列上朗讀順序反序的落差（抽為純函式 roComputeFlags）
    const flaggedCount = roComputeFlags(stops);

    return {
      url: location.href,
      total: stops.length,
      truncated: stops.length >= MAX,
      flaggedCount,
      stops: stops.map((s) => ({
        roIndex: s.roIndex,
        kind: s.kind,
        role: s.role,
        name: s.name != null ? s.name : null,
        nameRequired: !!s.nameRequired,
        text: s.text != null ? s.text : null,
        states: s.states || [],
        flagged: !!s.flagged,
        value: s.value != null ? s.value : null,
        position: s.position != null ? s.position : null,
        itemCount: s.itemCount != null ? s.itemCount : null,
        description: s.description != null ? s.description : null,
        boundary: s.boundary || null,
      })),
    };
  };

  // 依朗讀順序索引高亮頁面上的對應元素（沿用高亮樣式與捲動行為）
  window.__rampA11yHighlightRO = function (roIndex) {
    try {
      window.__rampA11yClear();
      ensureStyle();
      const el = document.querySelector('[data-ramp-ro="' + roIndex + '"]');
      if (!el) return false;
      el.classList.add(HIGHLIGHT_CLASS);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      return true;
    } catch (e) {
      return false;
    }
  };

  // ===== 鍵盤 Tab 走訪 =====
  // axe 的規則碰不到「按 Tab 實際會怎麼走」。這裡不按鍵（那要 debugger 權限，違反安全基準線）：
  // 照瀏覽器的循序焦點規則排出 Tab 停點（正 tabindex 先、依值由小到大，再來是 tabindex 0／原生可聚焦
  // 依 DOM 順序；同名單選鈕只有一站），再逐一程式化 focus() 檢查：聚焦後看不看得到、看不看得出焦點。
  // 另外列出「看起來能操作、鍵盤卻到不了」的元素（有互動 role 或 onclick，但不可聚焦）。
  // ⚠ focus() 會觸發頁面自己的 focus 事件（有的選單聚焦就展開），走完會把焦點還回去。

  const KB_MAX = 500;
  const KB_OVERLAY_ID = 'ramp-a11y-kb-overlay';
  // 看起來是控制項的 role：有這些 role、卻不可聚焦（也不在 aria-activedescendant 管理的容器裡）＝鍵盤到不了
  const KB_INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'slider',
    'spinbutton',
    'textbox',
    'searchbox',
    'combobox',
    'option',
    'treeitem',
  ]);

  function kbVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
    }
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  /** 照瀏覽器的循序焦點規則排出 Tab 停點（只看主文件的 light DOM） */
  function kbTabStops(root) {
    const all = Array.from((root || document).querySelectorAll('*'));
    const cand = [];
    const radioSeen = new Map(); // 同一表單、同名的單選鈕群組只有一站
    all.forEach((el, dom) => {
      if (el.id === KB_OVERLAY_ID || el.closest('#' + KB_OVERLAY_ID)) return;
      if (!(el.tabIndex >= 0)) return;
      if (el.disabled) return;
      if (el.closest('[inert]')) return;
      if (!kbVisible(el)) return;
      if (el.localName === 'input' && el.type === 'hidden') return;
      if (el.localName === 'input' && el.type === 'radio' && el.name) {
        const key = (el.form ? 'f' : 'd') + '|' + el.name;
        const prev = radioSeen.get(key);
        if (prev) {
          // 群組裡有勾選的，那一顆才是停點
          if (el.checked && !prev.el.checked) prev.el = el;
          return;
        }
        const entry = { el, dom };
        radioSeen.set(key, entry);
        cand.push(entry);
        return;
      }
      cand.push({ el, dom });
    });
    const items = cand.map((c) => ({ el: c.el, dom: c.dom, ti: c.el.tabIndex }));
    items.sort((a, b) => {
      const ap = a.ti > 0;
      const bp = b.ti > 0;
      if (ap && bp) return a.ti - b.ti || a.dom - b.dom;
      if (ap !== bp) return ap ? -1 : 1;
      return a.dom - b.dom;
    });
    return items;
  }

  // 焦點樣式比對的屬性：任何一個在聚焦前後不同，就看得出焦點
  const KB_STYLE_PROPS = [
    'outlineStyle',
    'outlineWidth',
    'outlineColor',
    'boxShadow',
    'borderTopColor',
    'borderBottomColor',
    'borderTopWidth',
    'borderBottomWidth',
    'backgroundColor',
    'backgroundImage',
    'color',
    'textDecorationLine',
  ];
  function kbSnapshot(el) {
    const s = getComputedStyle(el);
    const o = {};
    KB_STYLE_PROPS.forEach((p) => {
      o[p] = s[p];
    });
    return o;
  }
  function kbHasOutline(snap) {
    return snap.outlineStyle !== 'none' && parseFloat(snap.outlineWidth) > 0;
  }

  /**
   * 作者樣式表裡跟這個元素有關的焦點規則（同源樣式表才讀得到）。
   *
   * ⚠ 不能靠 :focus 在執行期比對：popup 開著時頁面視窗沒有焦點，Chrome 的 :focus／:focus-visible
   *   一律不成立（activeElement 會變、樣式不會套）——實測「聚焦會移進畫面的跳到主要內容」被誤報看不到、
   *   「:focus{outline:none}」被放過。所以把選擇器裡的焦點偽類拿掉再 matches：
   *   :focus／:focus-visible 比對元素本身，:focus-within 比對元素與祖先。
   *   :not(:focus-visible) 的規則（只給滑鼠焦點用，鍵盤焦點不套）略過。
   * @returns {{indicator, removed, revealed, unreadable}} revealed：聚焦時會移進畫面／顯示出來
   */
  function kbFocusRules(el) {
    const out = { indicator: false, removed: false, revealed: false, unreadable: false };
    const strip = (sel) =>
      sel
        .replace(/(^|[\s>+~,(]):focus(?:-visible|-within)?/g, '$1*')
        .replace(/:focus(?:-visible|-within)?/g, '');
    const visit = (rules) => {
      for (const r of rules) {
        if (r.cssRules && !r.selectorText) {
          visit(r.cssRules); // @media、@supports、@layer
          continue;
        }
        if (!r.selectorText || !r.style) continue;
        const text = r.selectorText;
        if (/:not\(\s*:focus-visible\s*\)/.test(text)) continue;
        const focusRule = /:focus/.test(text);
        let hit = false;
        try {
          const stripped = strip(text);
          hit =
            el.matches(stripped) ||
            (/:focus-within/.test(text) &&
              !!(el.parentElement && el.parentElement.closest(stripped)));
        } catch (e) {
          hit = false;
        }
        if (!hit) continue;
        // getPropertyValue 用連字號名稱：比 camelCase 屬性穩（jsdom 的 cssstyle 沒有 boxShadow 這類屬性）
        const g = (p) => (r.style.getPropertyValue(p) || '').trim();
        const outline = g('outline');
        const outlineStyle = g('outline-style');
        const kills =
          outlineStyle === 'none' ||
          outline === 'none' ||
          outline === '0' ||
          /^0(px)?\b/.test(outline);
        if (kills) out.removed = true;
        if (!focusRule) continue;
        const shadow = g('box-shadow');
        const shows =
          (!kills &&
            (outline || (outlineStyle && outlineStyle !== 'none') || g('outline-color'))) ||
          (shadow && shadow !== 'none') ||
          [
            'border-color',
            'border-top-color',
            'border-bottom-color',
            'background-color',
            'background',
            'color',
            'text-decoration',
            'text-decoration-line',
          ].some((p) => g(p));
        if (shows) out.indicator = true;
        if (
          [
            'left',
            'top',
            'right',
            'bottom',
            'transform',
            'clip',
            'clip-path',
            'width',
            'height',
            'position',
            'margin',
            'opacity',
            'visibility',
          ].some((p) => g(p))
        ) {
          out.revealed = true;
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        out.unreadable = true; // 跨來源樣式表讀不到
        continue;
      }
      if (rules) visit(rules);
    }
    return out;
  }

  /**
   * 一個停點：能不能聚焦、聚焦後看不看得到、看不看得出焦點。
   * 回傳 { focusable, hidden, indicator: 'ok'|'none'|'unknown', how, rect }。
   * 看得到與焦點樣式以樣式表為準（理由見 kbFocusRules）；頁面剛好有焦點、樣式真的變了也算看得出來。
   */
  function kbProbe(el) {
    const before = kbSnapshot(el);
    const r = el.getBoundingClientRect();
    const docX = r.left + scrollX;
    const docY = r.top + scrollY;
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      /* 擋 focus 的頁面腳本 */
    }
    if (document.activeElement !== el) return { focusable: false };
    const after = kbSnapshot(el);
    const rules = kbFocusRules(el);
    const opaque =
      typeof el.checkVisibility === 'function'
        ? el.checkVisibility({ opacityProperty: true })
        : true;
    const offscreen =
      r.width <= 1 || r.height <= 1 || docX + r.width <= 0 || docY + r.height <= 0 || !opaque;
    const hidden = offscreen && !rules.revealed; // 有 :focus 規則把它移進畫面就不算
    let indicator;
    let how;
    const changed = KB_STYLE_PROPS.filter((p) => before[p] !== after[p]);
    if (rules.indicator) {
      indicator = 'ok';
      how = 'focus-rule';
    } else if ((kbHasOutline(after) && !kbHasOutline(before)) || changed.length) {
      indicator = 'ok'; // 頁面剛好有焦點時，樣式真的變了
      how = kbHasOutline(after) ? 'outline' : changed[0];
    } else if (rules.removed) {
      indicator = 'none'; // 拿掉了瀏覽器的焦點框，又沒有替代樣式
      how = 'outline-removed';
    } else if (rules.unreadable) {
      indicator = 'unknown'; // 有跨來源樣式表讀不到，不下結論
      how = 'cross-origin-css';
    } else {
      indicator = 'ok'; // 沒有人拿掉：鍵盤聚焦時會有瀏覽器預設的焦點框
      how = 'browser-default';
    }
    return {
      focusable: true,
      hidden,
      indicator,
      how,
      rect: { x: docX, y: docY, w: r.width, h: r.height },
    };
  }

  /** 看起來能操作、鍵盤卻到不了 */
  function kbUnreachable(root) {
    const out = [];
    for (const el of Array.from((root || document).querySelectorAll('[role], [onclick]'))) {
      if (out.length >= 100) break;
      if (el.closest('#' + KB_OVERLAY_ID)) continue;
      if (el.tabIndex >= 0 || el.hasAttribute('tabindex')) continue; // 可聚焦（-1 是刻意的程式化焦點）
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.closest('[inert]') || !kbVisible(el)) continue;
      const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
      const byRole = KB_INTERACTIVE_ROLES.has(role);
      if (!byRole && !el.hasAttribute('onclick')) continue;
      // 由 aria-activedescendant 管理焦點的複合元件（listbox、tree、grid…）：子項本來就不可聚焦
      if (el.closest('[aria-activedescendant]')) continue;
      // 原生可聚焦的元素包在裡面（<div onclick><button>）：鍵盤到得了裡面那一個
      if (el.querySelector('a[href], button, input, select, textarea, [tabindex]')) continue;
      out.push({ el, reason: byRole ? 'role' : 'onclick', role: role || null });
    }
    return out;
  }

  window.__rampA11yTabOrder = function () {
    document.querySelectorAll('[data-ramp-kb]').forEach((e) => e.removeAttribute('data-ramp-kb'));
    window.__rampA11yTabOverlay(false);
    const prevActive = document.activeElement;
    const sx = scrollX;
    const sy = scrollY;
    let didSetup = false;
    try {
      if (window.axe && typeof window.axe.setup === 'function') {
        window.axe.setup(document);
        didSetup = true;
      }
    } catch (e) {
      /* 名稱改用保底 */
    }
    const items = kbTabStops(document);
    const stops = [];
    try {
      for (const it of items.slice(0, KB_MAX)) {
        const i = stops.length;
        it.el.setAttribute('data-ramp-kb', i);
        const probe = kbProbe(it.el);
        let nvda = null;
        try {
          nvda = nvdaPreview(it.el);
        } catch (e) {
          nvda = null;
        }
        stops.push({
          kbIndex: i,
          tag: it.el.localName,
          tabindex: it.ti,
          name:
            nvda && nvda.name
              ? nvda.name
              : (it.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
          role: nvda ? nvda.role : null,
          focusable: probe.focusable,
          hidden: !!probe.hidden,
          indicator: probe.indicator || null,
          how: probe.how || null,
          rect: probe.rect || null,
          positive: it.ti > 0,
        });
      }
    } finally {
      // 還原焦點與捲動位置
      try {
        if (prevActive && prevActive !== document.body && typeof prevActive.focus === 'function') {
          prevActive.focus({ preventScroll: true });
        } else if (document.activeElement && document.activeElement.blur) {
          document.activeElement.blur();
        }
      } catch (e) {
        /* 忽略 */
      }
      scrollTo(sx, sy);
    }
    // 同列反序：roComputeFlags 會在傳進去的物件上標 flagged，對回 stops
    const flagHolders = stops.map((s) => ({
      rect:
        s.rect && s.focusable ? { top: s.rect.y, left: s.rect.x, w: s.rect.w, h: s.rect.h } : null,
    }));
    roComputeFlags(flagHolders);
    stops.forEach((s, k) => {
      s.orderFlag = !!flagHolders[k].flagged;
    });
    const unreachable = kbUnreachable(document).map((u) => {
      let target = null;
      try {
        target = window.axe && window.axe.utils ? window.axe.utils.getSelector(u.el) : null;
      } catch (e) {
        target = null;
      }
      return {
        target,
        reason: u.reason,
        role: u.role,
        text: (u.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
      };
    });
    if (didSetup) {
      try {
        window.axe.teardown();
      } catch (e) {
        /* 忽略 */
      }
    }
    const count = (f) => stops.filter(f).length;
    return {
      url: location.href,
      total: items.length,
      truncated: items.length > KB_MAX,
      counts: {
        positive: count((s) => s.positive),
        hidden: count((s) => s.focusable && s.hidden),
        noIndicator: count((s) => s.indicator === 'none'),
        unknownIndicator: count((s) => s.indicator === 'unknown'),
        order: count((s) => s.orderFlag),
        unreachable: unreachable.length,
      },
      stops: stops.map((s) => ({
        kbIndex: s.kbIndex,
        tag: s.tag,
        tabindex: s.tabindex,
        name: s.name,
        role: s.role,
        focusable: s.focusable,
        hidden: s.hidden,
        indicator: s.indicator,
        how: s.how,
        positive: s.positive,
        orderFlag: s.orderFlag,
      })),
      unreachable,
    };
  };

  /** 在頁面上標出 Tab 停點的號碼與走向（再呼叫一次 false 拿掉）。標號層 aria-hidden、不攔滑鼠 */
  window.__rampA11yTabOverlay = function (on) {
    const old = document.getElementById(KB_OVERLAY_ID);
    if (old) old.remove();
    if (!on) return true;
    const els = Array.from(document.querySelectorAll('[data-ramp-kb]')).sort(
      (a, b) => Number(a.getAttribute('data-ramp-kb')) - Number(b.getAttribute('data-ramp-kb')),
    );
    if (!els.length) return false;
    const layer = document.createElement('div');
    layer.id = KB_OVERLAY_ID;
    layer.setAttribute('aria-hidden', 'true');
    const docW = Math.max(document.documentElement.scrollWidth, innerWidth);
    const docH = Math.max(document.documentElement.scrollHeight, innerHeight);
    layer.style.cssText = `position:absolute;left:0;top:0;width:${docW}px;height:${docH}px;pointer-events:none;z-index:2147483646`;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', docW);
    svg.setAttribute('height', docH);
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
    const pts = [];
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const x = r.left + scrollX;
      const y = r.top + scrollY;
      pts.push(`${x + r.width / 2},${y + r.height / 2}`);
      const badge = document.createElement('div');
      badge.textContent = String(Number(el.getAttribute('data-ramp-kb')) + 1);
      badge.style.cssText =
        `position:absolute;left:${Math.max(0, x - 10)}px;top:${Math.max(0, y - 10)}px;min-width:20px;height:20px;` +
        'padding:0 4px;border-radius:10px;background:#7C3AED;color:#fff;font:bold 12px/20px system-ui,sans-serif;' +
        'text-align:center;box-shadow:0 0 0 2px #fff';
      layer.appendChild(badge);
    });
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#7C3AED');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-dasharray', '6 4');
    line.setAttribute('opacity', '0.7');
    svg.appendChild(line);
    layer.insertBefore(svg, layer.firstChild);
    document.body.appendChild(layer);
    return true;
  };

  /** 依 Tab 停點索引高亮頁面上的元素 */
  window.__rampA11yHighlightKB = function (kbIndex) {
    try {
      window.__rampA11yClear();
      ensureStyle();
      const el = document.querySelector('[data-ramp-kb="' + kbIndex + '"]');
      if (!el) return false;
      el.classList.add(HIGHLIGHT_CLASS);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      return true;
    } catch (e) {
      return false;
    }
  };

  // ===== 動態播報監看（即時區域 aria-live / role=alert 等）=====
  // NVDA 對「即時區域」的內容變動會自動播報：assertive／role=alert 立即打斷念出；
  // polite／role=status 等目前這句念完再念。以 MutationObserver 監看這些區域的變化，
  // 把 NVDA 會播報的內容與時機累積到緩衝區，供 popup 呈現成時間軸（動態模擬）。

  const LIVE_SEL =
    '[aria-live], [role="alert"], [role="status"], [role="log"], [role="timer"], [role="marquee"], output';
  const LIVE_ALERT_SEL = '[role="alert"]';

  // 監看狀態掛在 window 上，跨多次注入與 popup 開關持續累積（頁面重整才清空）
  window.__rampA11yLive = window.__rampA11yLive || {
    log: [],
    observer: null,
    on: false,
    timer: null,
  };

  // popup 失焦關閉後無法主動停止觀察者；以「keepalive」綁定生命週期：
  // popup 每次輪詢（__rampA11yLiveGet）會重設計時器，停止輪詢逾時即自動斷開，
  // 避免觀察者在使用者離開後仍無限監看整頁 DOM。
  const LIVE_KEEPALIVE_MS = 180000; // 3 分鐘無輪詢即自停
  function liveKeepalive() {
    const s = window.__rampA11yLive;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      if (window.__rampA11yLiveStop) window.__rampA11yLiveStop();
    }, LIVE_KEEPALIVE_MS);
  }

  /** 解析即時區域的播報優先度：assertive（立即）／polite（依序）／null（不播報） */
  function livePoliteness(region) {
    const al = (region.getAttribute('aria-live') || '').toLowerCase();
    if (al === 'off') return null;
    if (al === 'assertive') return 'assertive';
    if (al === 'polite') return 'polite';
    const role = (region.getAttribute('role') || '').toLowerCase();
    if (role === 'alert') return 'assertive';
    if (role === 'status' || role === 'log' || role === 'timer' || role === 'marquee')
      return 'polite';
    // 走到這裡的只有 <output>（隱含 polite）與「aria-live 值無效」的元素——
    // 無效值等同 off，NVDA 不播報
    return region.tagName === 'OUTPUT' ? 'polite' : null;
  }

  /** 區域變動時是否整區播報：明寫的 aria-atomic 優先；否則 alert／status 依 ARIA 規範
   *  隱含 aria-atomic=true（真 NVDA 對照：alert 插進既有 role=status，念的是整區
   *  「已儲存區域內的警告」而不是只有新增的那段） */
  function liveAtomic(region) {
    const a = (region.getAttribute('aria-atomic') || '').toLowerCase();
    if (a === 'true') return true;
    if (a === 'false') return false;
    const role = (region.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    return role === 'alert' || role === 'status';
  }

  /** 記錄一筆播報（去重、去空白、限長） */
  function liveRecord(region, text) {
    // 隱藏區域不播報：aria-hidden、display:none、hidden 屬性、visibility:hidden
    //（真 NVDA 對照：插入隱藏的 role=alert 不念——預渲染的 toast 模板很常見）
    if (roIsHidden(region)) return;
    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const pol = livePoliteness(region);
    if (!pol) return;
    const buf = window.__rampA11yLive.log;
    const last = buf[buf.length - 1];
    if (last && last.text === t && last.politeness === pol) return; // 連續同內容不重複
    const src =
      region.getAttribute('role') ||
      (region.getAttribute('aria-live')
        ? 'aria-live=' + region.getAttribute('aria-live')
        : region.tagName.toLowerCase());
    buf.push({ ts: Date.now(), politeness: pol, text: t.slice(0, 200), source: src });
    if (buf.length > 100) buf.shift(); // 上限，避免無限成長
  }

  /** 開始監看（冪等）；回傳目前是否監看中 */
  window.__rampA11yLiveStart = function () {
    const state = window.__rampA11yLive;
    if (state.on) return true;
    try {
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          const node =
            m.target && m.target.nodeType === 1 ? m.target : m.target && m.target.parentElement;
          const region = node && node.closest ? node.closest(LIVE_SEL) : null;
          if (region) {
            if (liveAtomic(region)) {
              liveRecord(region, region.textContent); // 整區播報
            } else if (m.type === 'characterData') {
              liveRecord(region, m.target.nodeValue);
            } else if (m.type === 'childList' && m.addedNodes.length) {
              let added = '';
              m.addedNodes.forEach((n) => {
                added += ' ' + (n.textContent != null ? n.textContent : n.nodeValue || '');
              });
              liveRecord(region, added || region.textContent);
            }
          }
          // 「整個 role=alert 節點被插入」——toast／表單錯誤的最主流寫法。m.target 是
          // 插入點的父節點，上面的 closest 永遠找不到新節點，必須另掃 addedNodes 自身與
          // 子樹。真 NVDA 對照（2026-10，test/nvda/live.js）定出的規則：
          //   - 只有 role=alert 插入即播（alert 角色的定義行為）；插入 aria-live=assertive
          //     或 role=status 等節點，NVDA 都不念——區域須先存在，其後的變動才播
          //   - 插進「既有」live region 裡的 alert 由外層區域記一次（上方已處理），
          //     巢狀在另一個 alert 裡的也只記最外層——兩者都只有「沒有 live region 祖先」
          //     的 alert 才記，否則同一則會記兩筆
          if (m.type === 'childList' && m.addedNodes.length) {
            m.addedNodes.forEach((n) => {
              if (n.nodeType !== 1) return;
              const alerts = [];
              if (n.matches && n.matches(LIVE_ALERT_SEL)) alerts.push(n);
              if (n.querySelectorAll) alerts.push(...n.querySelectorAll(LIVE_ALERT_SEL));
              alerts.forEach((rg) => {
                const outer = rg.parentElement && rg.parentElement.closest(LIVE_SEL);
                if (!outer && livePoliteness(rg) === 'assertive') liveRecord(rg, rg.textContent);
              });
            });
          }
        }
      });
      obs.observe(document.body, { subtree: true, childList: true, characterData: true });
      state.observer = obs;
      state.on = true;
      liveKeepalive();
    } catch (e) {
      state.on = false;
    }
    return state.on;
  };

  /** 停止監看（緩衝區保留） */
  window.__rampA11yLiveStop = function () {
    const s = window.__rampA11yLive;
    if (s.observer) {
      try {
        s.observer.disconnect();
      } catch (e) {
        /* 忽略 */
      }
      s.observer = null;
    }
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    s.on = false;
    return true;
  };

  /** 取得緩衝區（可序列化陣列的副本）；每次取用視為 popup 仍在監看，延續 keepalive */
  window.__rampA11yLiveGet = function () {
    if (window.__rampA11yLive.on) liveKeepalive();
    return { on: window.__rampA11yLive.on, log: (window.__rampA11yLive.log || []).slice() };
  };

  /** 清空緩衝區 */
  window.__rampA11yLiveClear = function () {
    window.__rampA11yLive.log = [];
    return true;
  };

  /**
   * 執行 axe 掃描（JavaScript 執行後的實際 DOM），
   * 只回傳可序列化的純資料（executeScript 的結果必須可 JSON 化）。
   */
  window.__rampA11yScan = async function (opts) {
    tableGridCache = new WeakMap(); // 頁面可能已變動，格點快取只在單次掃描內有效
    // 掃描前先清掉舊高亮，避免高亮樣式影響結果
    window.__rampA11yClear();
    window.__rampA11yPickStop();
    if (window.__rampA11yTabOverlay) window.__rampA11yTabOverlay(false);

    // 局部掃描：include／exclude 是 CSS 選擇器（popup 的「掃描範圍」、CLI 的 --scope／--scope-exclude）。
    // 選擇器寫錯、或一個元素都對不到，回傳 { error } 讓呼叫端講清楚——不能退回掃整頁假裝成功
    const scope = scopeContext(opts || {});
    if (scope.error) return { url: location.href, error: scope.error, selector: scope.selector };

    const results = await window.axe.run(scope.context, {
      // MVP 僅掃描主頁面；跨來源 iframe 無法注入 axe，開啟會導致逾時
      iframes: false,
      resultTypes: ['violations', 'incomplete'],
      // 讓每個結果 node 帶上 live DOM 元素（node.element），供 NVDA 報讀預覽計算；
      // 這些元素參照只在頁面端使用，不會進入回傳給 popup 的序列化資料
      elementRef: true,
      rules: {
        // 115 年修正版新增 2.5.8 目標尺寸(最小)（WCAG 2.2），
        // axe 4.10 預設停用此規則，明確啟用使對應生效
        'target-size': { enabled: true },
      },
    });

    /** axe 的 color-contrast 檢查資料 → 可序列化的精簡版；其他規則回 null */
    const contrastData = (ruleId, node) => {
      if (ruleId !== 'color-contrast' && ruleId !== 'color-contrast-enhanced') return null;
      const checks = [].concat(node.any || [], node.all || [], node.none || []);
      const c = checks.find((x) => x && x.data && (x.data.fgColor || x.data.messageKey));
      if (!c) return null;
      const d = c.data;
      return {
        fg: d.fgColor || null,
        bg: d.bgColor || null,
        ratio: typeof d.contrastRatio === 'number' && d.contrastRatio > 0 ? d.contrastRatio : null,
        expected: d.expectedContrastRatio || null,
        reason: d.messageKey || null,
      };
    };

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
          // color-contrast 才有：axe 算出的字色、背景、比值，算不出時的原因（內建對比檢查器用）
          contrast: contrastData(rule.id, node),
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
        // 局部掃描的範圍（整頁是 null）：報告要寫明只掃了哪裡
        scope: scope.info,
      };
    } finally {
      if (didSetup) {
        try {
          window.axe.teardown();
        } catch (e) {
          /* 還原失敗不影響已算好的結果 */
        }
      }
    }
    return serialized;
  };

  // 內部純函式的測試掛勾（供 test/unit 存取；不影響正式行為，也不被 popup 使用）
  window.__rampA11yInternals = {
    scopeContext,
    kbTabStops,
    kbUnreachable,
    kbFocusRules,
    pickSelector,
    nvdaValue,
    nvdaPosition,
    nvdaItemCount,
    ariaListItemCount,
    isPresentational,
    roIsObject,
    roIsHidden,
    roSvgName,
    liveAtomic,
    tableGrid,
    nvdaDescription,
    nvdaStates,
    nvdaTableCell,
    nvdaTableDims,
    livePoliteness,
    roLandmark,
    roBoundary,
    roComputeFlags,
  };
})();
