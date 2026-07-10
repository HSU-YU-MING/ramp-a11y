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
    if (roleEn === 'progressbar' || roleEn === 'meter' || el.tagName === 'PROGRESS' || el.tagName === 'METER') {
      const vt = attr('aria-valuetext'); if (vt) return vt.trim();
      let now = attr('aria-valuenow'), min = attr('aria-valuemin'), max = attr('aria-valuemax');
      if (now == null && el.value != null && el.value !== '') now = String(el.value);
      if (min == null && (el.tagName === 'PROGRESS' || el.tagName === 'METER')) min = String(el.min != null ? el.min : 0);
      if (max == null && (el.tagName === 'PROGRESS' || el.tagName === 'METER')) max = String(el.max != null ? el.max : 1);
      const n = parseFloat(now), lo = parseFloat(min), hi = parseFloat(max);
      if (!isNaN(n) && !isNaN(lo) && !isNaN(hi) && hi > lo) return '百分之 ' + Math.round(((n - lo) / (hi - lo)) * 100);
      return !isNaN(n) ? String(n) : null;
    }
    if (roleEn === 'slider' || roleEn === 'spinbutton') {
      const vt = attr('aria-valuetext'); if (vt) return vt.trim();
      const now = attr('aria-valuenow'); if (now != null) return now.trim();
      return el.value != null && el.value !== '' ? String(el.value) : null;
    }
    if (el.tagName === 'SELECT') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      return opt ? (opt.textContent || '').trim() || null : null;
    }
    if (roleEn === 'combobox') {
      const vt = attr('aria-valuetext'); if (vt) return vt.trim();
      return el.value != null && String(el.value).trim() ? String(el.value).trim() : null;
    }
    if (roleEn === 'textbox' || roleEn === 'searchbox') {
      if (el.type === 'password') return null; // 密碼欄不朗讀內容
      const v = (el.value != null ? String(el.value) : '').trim();
      return v || null;
    }
    return null;
  }

  /** 集合位置「{總數} 之 {序位}」（aria-posinset/setsize，或原生 li/option/radio 計算） */
  function nvdaPosition(el, roleEn) {
    const pos = parseInt(el.getAttribute('aria-posinset'), 10);
    const size = parseInt(el.getAttribute('aria-setsize'), 10);
    if (!isNaN(pos) && !isNaN(size) && size > 0) return size + ' 之 ' + pos;
    const parent = el.parentElement;
    if (el.tagName === 'LI' && parent && /^(UL|OL|MENU)$/.test(parent.tagName)) {
      const items = Array.prototype.filter.call(parent.children, (c) => c.tagName === 'LI');
      const i = items.indexOf(el); if (i >= 0) return items.length + ' 之 ' + (i + 1);
    }
    if (el.tagName === 'OPTION') {
      const sel = el.closest('select');
      if (sel) { const opts = Array.prototype.slice.call(sel.querySelectorAll('option')); const i = opts.indexOf(el); if (i >= 0) return opts.length + ' 之 ' + (i + 1); }
    }
    if (roleEn === 'radio' && el.name) {
      const nm = window.CSS && CSS.escape ? CSS.escape(el.name) : el.name;
      const radios = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"][name="' + nm + '"]'));
      const i = radios.indexOf(el); if (i >= 0) return radios.length + ' 之 ' + (i + 1);
    }
    return null;
  }

  /** 清單／清單方塊的項目數「有 N 項」（NVDA 進入清單時會報項目數） */
  function nvdaItemCount(el, roleEn) {
    let n = 0;
    if (roleEn === 'list') {
      n = (el.tagName === 'UL' || el.tagName === 'OL' || el.tagName === 'MENU')
        ? Array.prototype.filter.call(el.children, (c) => c.tagName === 'LI').length
        : el.querySelectorAll('[role="listitem"]').length;
    } else if (roleEn === 'listbox') {
      n = el.tagName === 'SELECT' ? el.querySelectorAll('option').length : el.querySelectorAll('[role="option"]').length;
    }
    return n > 0 ? '有 ' + n + ' 項' : null;
  }

  /** 描述——NVDA 會在名稱／角色之後補念的說明（aria-describedby，或 title） */
  function nvdaDescription(el, name) {
    const ref = el.getAttribute('aria-describedby');
    if (ref) {
      const txt = ref.trim().split(/\s+/).map((id) => {
        const t = document.getElementById(id);
        return t ? (t.textContent || '').trim() : '';
      }).filter(Boolean).join(' ');
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
  function nvdaTableCell(el) {
    if (el.tagName !== 'TD' && el.tagName !== 'TH') return null;
    const row = el.parentElement;
    if (!row || row.cells == null || el.cellIndex == null || row.rowIndex == null) return null;
    const coord = '第 ' + (row.rowIndex + 1) + ' 列 第 ' + (el.cellIndex + 1) + ' 欄';
    const table = el.closest('table');
    let colHeader = null, rowHeader = null;
    if (table) {
      const headRow = (table.tHead && table.tHead.rows[0]) || table.rows[0];
      if (headRow && headRow !== row) {
        const hc = headRow.cells[el.cellIndex];
        if (hc && hc.tagName === 'TH') colHeader = (hc.textContent || '').trim() || null;
      }
      const first = row.cells[0];
      if (first && first.tagName === 'TH' && first !== el) rowHeader = (first.textContent || '').trim() || null;
    }
    return { coord, colHeader, rowHeader };
  }

  /** 表格維度「表格有 N 欄 M 列」（NVDA 進入表格會念；僅原生 <table>） */
  function nvdaTableDims(el) {
    if (el.tagName !== 'TABLE') return null;
    const rows = el.rows ? el.rows.length : 0;
    const cols = el.rows && el.rows[0] ? el.rows[0].cells.length : 0;
    return rows && cols ? '表格有 ' + cols + ' 欄 ' + rows + ' 列' : null;
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
      name: name || null,                     // null 表示無可朗讀名稱
      role: roleZh,                           // 已核對的中文角色（含標題階層）；null 表示未收錄
      roleEn: roleZh ? null : announcedRoleEn, // 未收錄時保留英文 role 供 UI 標示，不杜撰中文
      nameRequired,                           // 此角色是否必須有名稱（決定是否顯示「無可朗讀名稱」）
      value: value ? value.slice(0, 60) : null, // 目前值／內容（編輯區、下拉、滑桿、進度）
      states: nvdaStates(el),
      position,     // 集合位置「N 之 M」或儲存格座標「第 N 列 第 N 欄」
      itemCount,    // 清單項目數「有 N 項」或表格維度「表格有 N 欄 M 列」
      description,  // aria-describedby／title 描述，或儲存格的欄/列標題
    };
  }

  // ===== 朗讀順序預覽（第二階段）=====
  // 把整頁「線性化」成螢幕報讀軟體實際念出的順序（NVDA 瀏覽模式依 DOM 順序走），
  // 再比對視覺順序：標出同一視覺列上「畫面由左到右」與「朗讀先後」相反的落差
  // （flex order、float:right、RTL 等造成的 WCAG 1.3.2「有意義順序」問題）。

  const RO_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'LINK', 'META']);
  const RO_OBJECT_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'IMG', 'SVG', 'IFRAME', 'AUDIO', 'VIDEO', 'SUMMARY', 'AREA', 'CANVAS', 'PROGRESS', 'METER']);
  const RO_WIDGET_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton', 'combobox', 'textbox', 'searchbox', 'option', 'img', 'progressbar', 'treeitem']);
  const RO_OBJ_FALLBACK = { IFRAME: '框架', SVG: '圖形', AUDIO: '音訊', VIDEO: '視訊', SUMMARY: '摘要', CANVAS: '畫布', AREA: '熱區' };

  function roIsHidden(el) {
    if (el.closest && el.closest('[aria-hidden="true"]')) return true;
    if (typeof el.checkVisibility === 'function') {
      return !el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    }
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse';
  }
  function roIsObject(el) {
    // 無 href 的 <a> 不是連結（NVDA 不當成獨立物件）
    if (el.tagName === 'A' && !el.getAttribute('href') && !el.getAttribute('role')) return false;
    if (RO_OBJECT_TAGS.has(el.tagName)) return true;
    const r = el.getAttribute('role');
    return !!(r && RO_WIDGET_ROLES.has(r.trim().split(/\s+/)[0]));
  }
  function roIsBlock(el) {
    const d = getComputedStyle(el).display;
    return d && d !== 'inline' && d !== 'inline-block' && d !== 'inline-flex' && d !== 'inline-grid' && d !== 'contents';
  }
  function roBlockRole(el) {
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) return '標題第 ' + t[1] + ' 級';
    if (t === 'LI') return '清單項目';
    if (t === 'TH') return '表頭儲存格';
    if (t === 'TD') return '儲存格';
    if (t === 'BLOCKQUOTE') return '引述';
    if (t === 'FIGCAPTION') return '圖說';
    if (t === 'DT') return '詞彙';
    if (t === 'DD') return '釋義';
    return '文字';
  }

  // 地標名稱（校對自 NVDA 官方 zh_TW）
  const RO_LANDMARK_ZH = {
    banner: '橫幅區', navigation: '導覽區', main: '主要內容區', complementary: '補充區',
    contentinfo: '資訊區', region: '區域', search: '搜尋區', form: '表單區',
  };
  function roHasName(el) {
    return !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'));
  }
  /** 元素是否為地標（含隱含地標的 HTML 元素）→ 回傳地標中文名，否則 null */
  function roLandmark(el) {
    const roleAttr = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (roleAttr && RO_LANDMARK_ZH[roleAttr]) {
      if ((roleAttr === 'region' || roleAttr === 'form') && !roHasName(el)) return null;
      return RO_LANDMARK_ZH[roleAttr];
    }
    switch (el.tagName) {
      case 'NAV': return '導覽區';
      case 'MAIN': return '主要內容區';
      case 'ASIDE': return '補充區';
      // header/footer 僅在非巢狀於 article/section 等時才是地標
      case 'HEADER': return el.closest('article,aside,main,nav,section') ? null : '橫幅區';
      case 'FOOTER': return el.closest('article,aside,main,nav,section') ? null : '資訊區';
      case 'SECTION': return roHasName(el) ? '區域' : null; // 具名 section 才是地標
      case 'FORM': return roHasName(el) ? '表單區' : null;
      default: return null;
    }
  }
  /** 需在朗讀順序中標示邊界的區域（地標／表格），含進入與離開的朗讀文字 */
  function roBoundary(el) {
    const lm = roLandmark(el);
    if (lm) {
      const label = (el.getAttribute('aria-label') || '').trim();
      return { kind: 'landmark', enter: label ? label + ' ' + lm : lm, exit: '離開' + lm };
    }
    if (el.tagName === 'TABLE') {
      return { kind: 'table', enter: nvdaTableDims(el) || '表格', exit: '離開表格' };
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
      if (r.width || r.height) return { top: r.top + window.scrollY, left: r.left + window.scrollX, w: r.width, h: r.height };
    } catch (e) { /* 保底 */ }
    return null;
  }

  window.__rampA11yReadingOrder = function () {
    // 清掉上次留下的定位屬性，避免索引錯亂
    document.querySelectorAll('[data-ramp-ro]').forEach((e) => e.removeAttribute('data-ramp-ro'));

    const MAX = 500;
    const stops = [];
    // nvdaPreview 依賴 axe 虛擬樹（getRole／accessibleText），需先 setup 重建
    let didSetup = false;
    try {
      if (window.axe && typeof window.axe.setup === 'function') { window.axe.setup(document); didSetup = true; }
    } catch (e) { /* setup 失敗仍可線性化，物件名稱改用保底 */ }

    let buf = '', bufNodes = [], bufEl = null;
    function flush() {
      const text = buf.replace(/\s+/g, ' ').trim();
      const nodes = bufNodes, el = bufEl;
      buf = ''; bufNodes = []; bufEl = null;
      if (!text || !el || stops.length >= MAX) return;
      const roIndex = stops.length;
      try { el.setAttribute('data-ramp-ro', roIndex); } catch (e) { /* 忽略 */ }
      const stop = {
        roIndex, kind: 'text', role: roBlockRole(el),
        text: text.slice(0, 140), name: null, nameRequired: false, states: [],
        value: null, position: null, itemCount: null, description: null,
        flagged: false, rect: roRangeRect(nodes) || roRect(el),
      };
      // 表格儲存格：補座標與欄/列標題
      if (el.tagName === 'TD' || el.tagName === 'TH') {
        const cell = nvdaTableCell(el);
        if (cell) {
          stop.position = cell.coord;
          const h = [cell.colHeader, cell.rowHeader].filter(Boolean).join('・');
          if (h) stop.description = h;
        }
      }
      stops.push(stop);
    }
    // 地標／表格的進入‧離開邊界標記（無幾何範圍，不參與視覺落差判定）
    function pushBoundary(kind, text, dir) {
      if (stops.length >= MAX) return;
      stops.push({
        roIndex: stops.length, kind, boundary: dir, role: null, text,
        name: null, nameRequired: false, states: [], value: null, position: null,
        itemCount: null, description: null, flagged: false, rect: null,
      });
    }
    function pushObject(c) {
      if (stops.length >= MAX) return;
      flush(); // 物件前的文字先斷句，維持朗讀先後
      const roIndex = stops.length;
      let name = null, role = null, states = [], nameRequired = false;
      let value = null, position = null, itemCount = null, description = null;
      const nv = nvdaPreview(c);
      if (nv) {
        name = nv.name; role = nv.role || nv.roleEn; states = nv.states; nameRequired = nv.nameRequired;
        value = nv.value; position = nv.position; itemCount = nv.itemCount; description = nv.description;
      } else { role = RO_OBJ_FALLBACK[c.tagName] || c.tagName.toLowerCase(); } // getRole 無角色時的保底
      try { c.setAttribute('data-ramp-ro', roIndex); } catch (e) { /* 忽略 */ }
      stops.push({ roIndex, kind: 'object', role, text: null, name, nameRequired, states,
        value, position, itemCount, description, flagged: false, rect: roRect(c) });
    }
    function walk(el, blockEl) {
      for (let c = el.firstChild; c && stops.length < MAX; c = c.nextSibling) {
        if (c.nodeType === 3) { // 文字節點：累積到目前區塊的朗讀緩衝
          if (c.nodeValue && c.nodeValue.trim()) { if (!bufEl) bufEl = blockEl; bufNodes.push(c); buf += c.nodeValue; }
          continue;
        }
        if (c.nodeType !== 1) continue;
        if (RO_SKIP_TAGS.has(c.tagName) || roIsHidden(c)) continue;
        if (roIsObject(c)) { pushObject(c); continue; } // 物件為獨立停點，不深入其子樹
        const bd = roBoundary(c);         // 地標／表格邊界
        const blk = roIsBlock(c);
        if (blk || bd) flush();           // 進入區塊/邊界前先斷句
        if (bd) pushBoundary(bd.kind, bd.enter, 'enter');
        walk(c, (blk || bd) ? c : blockEl);
        if (blk || bd) flush();           // 離開區塊/邊界後再斷句
        if (bd) pushBoundary(bd.kind, bd.exit, 'exit');
      }
    }
    try { walk(document.body, document.body); flush(); }
    finally { if (didSetup) { try { window.axe.teardown(); } catch (e) { /* 忽略 */ } } }

    // 視覺順序比對：把有幾何範圍的停點依 top 分列（容差 TOL），同一列內依 left 排序即
    // 「畫面由左到右」。若同列中左邊的停點朗讀順序反而在後 → 視覺與朗讀順序落差。
    const R = stops.filter((s) => s.rect && s.rect.w > 0 && s.rect.h > 0);
    R.forEach((s, k) => { s._read = k; });
    const sorted = R.slice().sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const TOL = 14;
    const rows = []; let cur = null;
    for (const s of sorted) {
      if (!cur || s.rect.top - cur.top0 > TOL) { cur = { top0: s.rect.top, items: [s] }; rows.push(cur); }
      else cur.items.push(s);
    }
    let flaggedCount = 0;
    for (const r of rows) {
      r.items.sort((a, b) => a.rect.left - b.rect.left);
      for (let j = 0; j < r.items.length - 1; j++) {
        if (r.items[j]._read > r.items[j + 1]._read) {
          if (!r.items[j].flagged) { r.items[j].flagged = true; flaggedCount++; }
          if (!r.items[j + 1].flagged) { r.items[j + 1].flagged = true; flaggedCount++; }
        }
      }
    }

    return {
      url: location.href,
      total: stops.length,
      truncated: stops.length >= MAX,
      flaggedCount,
      stops: stops.map((s) => ({
        roIndex: s.roIndex, kind: s.kind, role: s.role,
        name: s.name != null ? s.name : null, nameRequired: !!s.nameRequired,
        text: s.text != null ? s.text : null, states: s.states || [], flagged: !!s.flagged,
        value: s.value != null ? s.value : null, position: s.position != null ? s.position : null,
        itemCount: s.itemCount != null ? s.itemCount : null, description: s.description != null ? s.description : null,
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
