/**
 * popup/popup.js
 * 主控流程：
 *  1. 取得當前分頁 → 檢查是否為受保護頁面（開啟時即檢查，並嘗試還原同頁快取）
 *  2. 注入 vendor/axe.min.js、vendor/axe-locale-zh_TW.js 與 content/scanner.js
 *  3. 呼叫頁面內的 __rampA11yScan() 取得序列化結果
 *  4. 以 data/rules-map.json 轉譯為台灣規範的繁中說明後渲染，並存入 session 快取
 *  5. 點擊受影響元素 → 呼叫頁面內的 __rampA11yHighlight() 高亮定位
 */

'use strict';

// ===== DOM 參照 =====
const views = {
  initial: document.getElementById('view-initial'),
  loading: document.getElementById('view-loading'),
  results: document.getElementById('view-results'),
  error: document.getElementById('view-error'),
};
const statsEl = document.getElementById('stats');
const cacheNoteEl = document.getElementById('cache-note');
const issuesEl = document.getElementById('issues');
const errorTitleEl = document.getElementById('error-title');
const errorDetailEl = document.getElementById('error-detail');
const btnScan = document.getElementById('btn-scan');
const btnRescan = document.getElementById('btn-rescan');
const btnRetry = document.getElementById('btn-retry');
const btnExport = document.getElementById('btn-export');
const levelSelect = document.getElementById('level-select');
const delaySelect = document.getElementById('delay-select');
const filterGroup = document.getElementById('filter-group');
const loadingTextEl = document.querySelector('#view-loading .loading-text');
const modeTabs = document.getElementById('mode-tabs');
const toolbarEl = document.querySelector('.toolbar');
const readingSummaryEl = document.getElementById('reading-summary');

// ===== 全域狀態 =====
let rulesMap = new Map(); // axeRuleId → 對應表項目
let currentTabId = null;  // 當前掃描的分頁 id
let lastScan = null;      // 最後一次掃描 { result, url, ts, fromCacheTs }，供報告匯出與重新渲染
let currentMode = 'issues'; // 檢視模式：issues（檢測問題）| reading（朗讀順序）| live（動態播報）
let readingData = null;   // 朗讀順序資料快取（每次重新檢測時失效）
let liveTimer = null;     // 動態播報輪詢計時器

// 使用者偏好（chrome.storage.local 持久化）
const prefs = {
  targetLevel: 'AA',   // 目標檢測等級（政府網站標章要求 AA）
  scanDelay: 0,        // 掃描前等待秒數（動畫、延遲載入頁面用）
  resultFilter: 'all', // 結果篩選：all | violations | review
};

// 人工複核自評：目前網址的 { axeRuleId: 'pass' | 'fail' }，chrome.storage.local 持久化
let reviewState = {};
let reviewKey = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 等級顯示順序與標籤
const LEVEL_ORDER = ['A', 'AA', 'AAA'];

// axe impact 嚴重度：排序權重與繁中標籤
const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const IMPACT_ZH = { critical: '嚴重', serious: '高', moderate: '中', minor: '輕微' };

/** 同組內依 axe impact 嚴重度排序（critical → minor，無 impact 排最後） */
function sortByImpact(list) {
  return list
    .slice()
    .sort((a, b) => (IMPACT_ORDER[a.impact] ?? 9) - (IMPACT_ORDER[b.impact] ?? 9));
}

/** 快取結果的時間顯示 */
function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return '剛剛';
  if (mins < 60) return `${mins} 分鐘前`;
  return `${Math.round(mins / 60)} 小時前`;
}

// ===== 工具函式 =====

/** 切換顯示的狀態畫面 */
function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.hidden = key !== name;
  });
}

/** HTML 逸出，避免頁面內容（selector、HTML 片段）注入 popup */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 顯示錯誤畫面 */
function showError(title, detail, canRetry) {
  errorTitleEl.textContent = title;
  errorDetailEl.textContent = detail || '';
  btnRetry.hidden = !canRetry;
  showView('error');
}

/** 判斷是否為無法注入腳本的受保護頁面 */
function isRestrictedUrl(url) {
  if (!url) return true;
  const restrictedSchemes = [
    'chrome://', 'chrome-extension://', 'chrome-search://', 'chrome-devtools://',
    'edge://', 'extension://', 'devtools://', 'about:', 'view-source:',
  ];
  if (restrictedSchemes.some((s) => url.startsWith(s))) return true;
  // 擴充功能商店頁面同樣禁止注入
  const restrictedHosts = [
    'chromewebstore.google.com',
    'chrome.google.com',
    'microsoftedge.microsoft.com',
  ];
  try {
    const host = new URL(url).hostname;
    return restrictedHosts.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return true;
  }
}

/** 載入 axe 規則 → 台灣規範 對應表 */
async function loadRulesMap() {
  if (rulesMap.size > 0) return;
  const res = await fetch(chrome.runtime.getURL('data/rules-map.json'));
  const list = await res.json();
  list.forEach((item) => rulesMap.set(item.axeRuleId, item));
}

/** 取得目前作用中的分頁 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ===== 偏好設定與人工複核自評的持久化 =====

/** 載入偏好設定並同步到控制項 */
async function loadPrefs() {
  try {
    const st = await chrome.storage.local.get('prefs');
    Object.assign(prefs, st.prefs || {});
  } catch { /* 讀取失敗就用預設值 */ }
  levelSelect.value = prefs.targetLevel;
  delaySelect.value = String(prefs.scanDelay);
  syncFilterUI();
}

function savePrefs() {
  try { chrome.storage.local.set({ prefs }); } catch { /* 忽略 */ }
}

/** 同步篩選 chips 的視覺與 aria 狀態 */
function syncFilterUI() {
  filterGroup.querySelectorAll('.chip').forEach((b) => {
    const on = b.dataset.filter === prefs.resultFilter;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

/** 載入指定網址的人工複核自評狀態 */
async function loadReviewState(url) {
  reviewKey = 'review::' + url;
  try {
    const st = await chrome.storage.local.get(reviewKey);
    reviewState = st[reviewKey] || {};
  } catch {
    reviewState = {};
  }
}

// ===== 掃描流程 =====

async function runScan() {
  showView('loading');
  readingData = null; // 頁面即將重新檢測，舊的朗讀順序失效
  try {
    await loadRulesMap();

    const tab = await getActiveTab();
    if (!tab || isRestrictedUrl(tab.url)) {
      showError(
        '此頁面無法檢測',
        '瀏覽器內建頁面（chrome:// 等）與擴充功能商店基於安全限制，無法注入檢測腳本。請切換到一般網頁再試。',
        false
      );
      return;
    }
    currentTabId = tab.id;

    // 掃描前等待（供動畫或延遲載入的頁面完成渲染）
    if (prefs.scanDelay > 0) {
      loadingTextEl.textContent = `等待頁面內容載入（${prefs.scanDelay} 秒）…`;
      await sleep(prefs.scanDelay * 1000);
      loadingTextEl.textContent = '檢測中…';
    }

    // 步驟一：注入本地打包的 axe-core、繁中語言包與掃描器
    // （同一 isolated world 共用，axe 全域可被後續檔案取用）
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [
        'vendor/axe.min.js',
        'vendor/axe-locale-zh_TW.js',
        'content/scanner.js',
      ],
    });

    // 步驟二：執行掃描，取回序列化的純資料
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__rampA11yScan(),
    });

    const result = injection && injection[0] && injection[0].result;
    if (!result) {
      showError('檢測失敗', '掃描未回傳結果，請重新整理頁面後再試。', true);
      return;
    }

    await loadReviewState(tab.url);
    lastScan = { result, url: tab.url, ts: Date.now(), fromCacheTs: null };
    renderResults(result, null);

    // 快取本次結果：popup 關閉後重開可直接還原，不必重掃
    try {
      await chrome.storage.session.set({
        ['scan_' + tab.id]: { url: tab.url, ts: lastScan.ts, result },
      });
    } catch {
      // 快取失敗不影響主流程
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // 將 Chrome 常見的注入拒絕錯誤轉為友善的繁中訊息
    if (/cannot access|cannot be scripted|error page|chrome:\/\/|extensions gallery/i.test(msg)) {
      showError(
        '此頁面無法檢測',
        '瀏覽器不允許在此頁面注入檢測腳本（受保護頁面、錯誤頁或未授權的本機檔案）。請切換到一般網頁再試。',
        false
      );
    } else if (/already running/i.test(msg)) {
      showError('檢測仍在進行中', '上一次掃描尚未完成，請稍候幾秒再試一次。', true);
    } else {
      showError('檢測失敗', msg, true);
    }
  }
}

// ===== 結果轉譯與渲染 =====

/**
 * 將單一 axe 規則結果轉譯為顯示用資料。
 * 未在對應表中的規則沿用 axe 的說明文字（經 zh_TW 語言包多為繁中），
 * 並依 tags 分流為「未對應台灣準則」或「最佳實務建議」。
 */
function translateRule(rule) {
  const map = rulesMap.get(rule.id);
  const common = {
    helpUrl: rule.helpUrl,
    nodes: rule.nodes,
    // scanner 端最多回傳 20 個元素，nodeCount 為實際總數
    nodeCount: rule.nodeCount != null ? rule.nodeCount : rule.nodes.length,
    axeId: rule.id,
    impact: rule.impact || null,
    // best-practice 為 axe 的最佳實務建議，並非 WCAG 失敗項，需與違規分流
    isBestPractice: (rule.tags || []).includes('best-practice'),
    // WCAG 2.2 新增準則：台灣規範（對齊 WCAG 2.1）尚未採用，需明確標示
    isWcag22: (rule.tags || []).some((t) => /^wcag22a{1,3}$/.test(t)),
  };
  if (map) {
    return {
      ...common,
      mapped: true,
      level: map.twLevel,
      title: map.titleZh,
      guideline: map.twGuideline,
      guidelineName: map.twGuidelineName || '',
      category: map.category,
      why: map.whyZh,
      how: map.howZh,
      note: map.noteZh || null, // 版本差異等補充說明（如 115 年修正版的增刪）
      checkCodes: map.twCheckCodes || [], // 官方檢測碼（附件一 C 碼）
    };
  }
  return {
    ...common,
    mapped: false,
    level: null,
    title: rule.help, // 經 zh_TW 語言包後多數已是繁中
    guideline: null,
    category: null,
    why: rule.description,
    how: null,
    note: null,
    checkCodes: [],
  };
}

/** 渲染統計列（violations 已排除最佳實務項目） */
function renderStats(violations, bpCount, incompleteCount) {
  const levelCounts = { A: 0, AA: 0, AAA: 0 };
  let unmapped = 0;
  violations.forEach((v) => {
    if (v.mapped) levelCounts[v.level] = (levelCounts[v.level] || 0) + 1;
    else unmapped += 1;
  });

  const parts = [
    `<span class="stat">違規總數 <strong>${violations.length}</strong></span>`,
    `<span class="stat"><span class="badge badge-A">A</span><strong>${levelCounts.A}</strong></span>`,
    `<span class="stat"><span class="badge badge-AA">AA</span><strong>${levelCounts.AA}</strong></span>`,
    `<span class="stat"><span class="badge badge-AAA">AAA</span><strong>${levelCounts.AAA}</strong></span>`,
  ];
  if (unmapped > 0) {
    parts.push(`<span class="stat"><span class="badge badge-unmapped">其他</span><strong>${unmapped}</strong></span>`);
  }
  if (bpCount > 0) {
    parts.push(`<span class="stat"><span class="badge badge-bp">建議</span><strong>${bpCount}</strong></span>`);
  }
  parts.push(`<span class="stat"><span class="badge badge-review">複核</span>需人工複核 <strong>${incompleteCount}</strong></span>`);
  statsEl.innerHTML = parts.join('');
}

/**
 * 模擬 NVDA 報讀那一行（popup 用）。
 * nvda 為 scanner 端算好的 { name, role, roleEn, states }；無資料時回傳空字串。
 * 名稱為空 → 以醒目樣式顯示「（無可朗讀名稱）」，這正是無名按鈕／連結的核心痛點。
 */
function nvdaLineHtml(nvda) {
  if (!nvda) return '';
  // 名稱：有名稱→念出；無名稱且此角色「必須有名稱」→醒目提示；否則（結構角色）不提示
  const name = nvda.name
    ? `<span class="nvda-name">${escapeHtml(nvda.name)}</span>`
    : nvda.nameRequired
      ? '<span class="nvda-noname">（無可朗讀名稱）</span>'
      : '';
  const role = nvda.role
    ? `<span class="nvda-role">${escapeHtml(nvda.role)}</span>`
    : nvda.roleEn
      ? `<span class="nvda-role nvda-role-en" title="NVDA 官方翻譯尚未收錄此角色，顯示原始 role">${escapeHtml(nvda.roleEn)}</span>`
      : '';
  const value = nvda.value ? `<span class="nvda-value">${escapeHtml(nvda.value)}</span>` : '';
  const states = nvda.states && nvda.states.length
    ? `<span class="nvda-states">${nvda.states.map(escapeHtml).join('　')}</span>`
    : '';
  const position = nvda.position ? `<span class="nvda-pos">${escapeHtml(nvda.position)}</span>` : '';
  const itemCount = nvda.itemCount ? `<span class="nvda-pos">${escapeHtml(nvda.itemCount)}</span>` : '';
  const desc = nvda.description ? `<span class="nvda-desc">${escapeHtml(nvda.description)}</span>` : '';
  const hasAny = nvda.name || nvda.role || nvda.roleEn || value || (nvda.states && nvda.states.length)
    || position || itemCount || desc;
  if (!hasAny) return ''; // 無任何可念資訊（如純文字節點）不顯示整行
  // 依 NVDA 朗讀次序：名稱 → 角色 → 值 → 狀態 → 位置 → 項目數 → 描述
  return `<p class="nvda-line" title="模擬 NVDA 螢幕報讀軟體會如何念出此元素（角色／狀態／值等用詞取自 NVDA 官方正體中文）">
            <span class="nvda-tag" aria-hidden="true">🔊 NVDA</span>${name} ${role} ${value} ${states} ${position} ${itemCount} ${desc}
          </p>`;
}

/**
 * 產生單一問題項目的 HTML
 * @param {boolean} isReview 是否為「需人工複核」項目（顯示自評選單）
 */
function issueHtml(item, badgeClass, badgeText, isReview) {
  const nodesHtml = item.nodes
    .map(
      (n) => `
        <li>
          <button class="node-btn" type="button" data-selector="${escapeHtml(n.target)}"
                  title="點擊在頁面上高亮此元素">
            ${escapeHtml(n.target)}
          </button>
          ${nvdaLineHtml(n.nvda)}
          ${n.html ? `<code class="node-html">${escapeHtml(n.html.slice(0, 120))}${n.html.length > 120 ? '…' : ''}</code>` : ''}
        </li>`
    )
    .join('');

  const impactText = item.impact
    ? `・影響程度：${IMPACT_ZH[item.impact] || escapeHtml(item.impact)}`
    : '';
  const codesText = item.checkCodes && item.checkCodes.length
    ? `・檢測碼 ${item.checkCodes.map(escapeHtml).join('、')}`
    : '';
  const guidelineHtml = item.mapped
    ? `<p class="guideline">台灣網站無障礙規範 ${escapeHtml(item.guideline)} ${escapeHtml(item.guidelineName)}（${escapeHtml(item.category)}）・等級 ${escapeHtml(item.level)}${impactText}${codesText}</p>`
    : `<p class="guideline">${
        item.isBestPractice
          ? '最佳實務建議（非台灣規範必要項目）'
          : item.isWcag22
            ? 'WCAG 2.2 新增準則（115 年修正版起適用）'
            : '未對應台灣規範準則'
      }・axe 規則：${escapeHtml(item.axeId)}${impactText}</p>`;

  const whyHtml = item.why
    ? `<p><strong>為什麼是障礙：</strong>${escapeHtml(item.why)}</p>`
    : '';
  const howHtml = item.how
    ? `<p><strong>如何修正：</strong>${escapeHtml(item.how)}</p>`
    : '';
  const noteHtml = item.note
    ? `<p class="issue-note">※ ${escapeHtml(item.note)}</p>`
    : '';
  // 需人工複核項目提供自評選單（對應官方自我評量流程）
  const rv = reviewState[item.axeId] || '';
  const reviewHtml = isReview
    ? `
      <div class="review-box">
        <label>人工複核自評：
          <select class="review-select" data-axe-id="${escapeHtml(item.axeId)}">
            <option value=""${rv === '' ? ' selected' : ''}>未確認</option>
            <option value="pass"${rv === 'pass' ? ' selected' : ''}>通過</option>
            <option value="fail"${rv === 'fail' ? ' selected' : ''}>不通過</option>
          </select>
        </label>
      </div>`
    : '';

  return `
    <div class="issue">
      <button class="issue-header" type="button" aria-expanded="false">
        <span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>
        <span class="issue-title">${escapeHtml(item.title)}</span>
        ${item.mapped ? `<span class="issue-guideline">${escapeHtml(item.guideline)}</span>` : ''}
        <span class="issue-count">${item.nodeCount} 個元素</span>
        <span class="chevron" aria-hidden="true">▶</span>
      </button>
      <div class="issue-body" hidden>
        ${guidelineHtml}
        ${whyHtml}
        ${howHtml}
        ${noteHtml}
        ${reviewHtml}
        <p><strong>受影響元素（點擊可在頁面上定位）：</strong></p>
        <ul class="nodes">${nodesHtml}</ul>
        ${item.nodeCount > item.nodes.length ? `<p class="node-more">還有 ${item.nodeCount - item.nodes.length} 個元素未列出（僅顯示前 ${item.nodes.length} 個）</p>` : ''}
        <a class="help-link" href="${escapeHtml(item.helpUrl)}" target="_blank" rel="noopener">axe 規則詳細說明（英文）</a>
      </div>
    </div>`;
}

/**
 * 渲染完整結果面板。
 * @param {object} result   掃描結果（violations / incomplete）
 * @param {number|null} cachedTs 若為快取還原，傳入原掃描時間戳；即時掃描傳 null
 */
/**
 * 將掃描結果轉譯並分流（渲染與報告匯出共用）。
 * 最佳實務建議並非 WCAG 失敗項，不計入「違規」。
 */
function classifyResults(result) {
  const all = result.violations.map(translateRule);
  const incomplete = sortByImpact(result.incomplete.map(translateRule));
  const bestPractice = sortByImpact(all.filter((v) => !v.mapped && v.isBestPractice));
  const violations = all.filter((v) => v.mapped || !v.isBestPractice);
  return { violations, bestPractice, incomplete };
}

function renderResults(result, cachedTs) {
  setModeUI('issues'); // 結果一律以「檢測問題」模式呈現
  const { violations, bestPractice, incomplete } = classifyResults(result);

  renderStats(violations, bestPractice.length, incomplete.length);

  // 快取還原提示
  if (cachedTs) {
    cacheNoteEl.textContent = `顯示上次檢測結果（${timeAgo(cachedTs)}）— 頁面內容可能已變動，可按「重新檢測」更新。`;
    cacheNoteEl.hidden = false;
  } else {
    cacheNoteEl.hidden = true;
  }

  // 目標等級與結果篩選（Freego 的檢測等級／顯示篩選之移植）
  const levelIdx = LEVEL_ORDER.indexOf(prefs.targetLevel);
  const withinTarget = (lv) => LEVEL_ORDER.indexOf(lv) <= levelIdx;
  const showViolations = prefs.resultFilter !== 'review';
  const showBp = prefs.resultFilter === 'all';
  const showReview = prefs.resultFilter !== 'violations';

  let html = '';

  if (violations.length === 0) {
    // 無違規：正向訊息＋人工複核提醒
    html += `
      <div class="all-clear">
        <p class="success-title">太好了！未發現自動化可偵測的違規</p>
        <p class="success-note">自動化檢測僅能涵蓋約三到四成的無障礙問題，仍建議進行鍵盤操作、報讀軟體等人工複核。</p>
      </div>`;
  } else if (showViolations) {
    // 目標等級內：依 A / AA / AAA 分組，同組內依嚴重度排序
    LEVEL_ORDER.forEach((level) => {
      if (!withinTarget(level)) return;
      const group = sortByImpact(violations.filter((v) => v.mapped && v.level === level));
      if (group.length === 0) return;
      html += `<h2 class="group-heading">等級 ${level}（${group.length} 項）</h2>`;
      html += group.map((v) => issueHtml(v, 'badge-' + level, level)).join('');
    });

    // WCAG 相關、但未在台灣規範對應表中的規則
    const unmapped = sortByImpact(violations.filter((v) => !v.mapped));
    if (unmapped.length > 0) {
      html += `<h2 class="group-heading">其他 WCAG 項目（未對應台灣準則，${unmapped.length} 項）</h2>`;
      html += unmapped.map((v) => issueHtml(v, 'badge-unmapped', '其他')).join('');
    }

    // 超出目標等級的項目（仍列出供參考，不與目標混在一起）
    const beyond = sortByImpact(violations.filter((v) => v.mapped && !withinTarget(v.level)));
    if (beyond.length > 0) {
      html += `<h2 class="group-heading">超出目標等級 ${escapeHtml(prefs.targetLevel)}（${beyond.length} 項）</h2>`;
      html += beyond.map((v) => issueHtml(v, 'badge-' + v.level, v.level)).join('');
    }
  }

  // axe 最佳實務建議（非規範必要，獨立分組避免灌水「違規」數字）
  if (showBp && bestPractice.length > 0) {
    html += `<h2 class="group-heading">最佳實務建議（非規範必要，${bestPractice.length} 項）</h2>`;
    html += bestPractice.map((v) => issueHtml(v, 'badge-bp', '建議')).join('');
  }

  // incomplete → 需人工複核（附自評選單）
  if (showReview && incomplete.length > 0) {
    html += `<h2 class="group-heading">需人工複核（${incomplete.length} 項）</h2>`;
    html += incomplete.map((v) => issueHtml(v, 'badge-review', '複核', true)).join('');
  }

  issuesEl.innerHTML = html;
  showView('results');
  issuesEl.scrollTop = 0;
}

// ===== 高亮定位 =====

/**
 * 呼叫頁面內的高亮函式。
 * 回傳 true（成功）、false（找不到元素）或 'missing'（掃描器尚未注入，
 * 例如快取還原後頁面曾重新整理，isolated world 已是全新的）。
 */
async function execHighlight(selector) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    func: (sel) => (window.__rampA11yHighlight ? window.__rampA11yHighlight(sel) : 'missing'),
    args: [selector],
  });
  return injection && injection[0] ? injection[0].result : false;
}

/** 在原頁面高亮指定元素並捲動過去 */
async function highlightOnPage(selector) {
  if (currentTabId == null) return false;
  try {
    let res = await execHighlight(selector);
    if (res === 'missing') {
      // 補注入掃描器後重試一次（高亮不需要 axe 本體）
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        files: ['content/scanner.js'],
      });
      res = await execHighlight(selector);
    }
    return res === true;
  } catch {
    return false;
  }
}

// ===== 朗讀順序預覽（第二階段）=====

/** 切換檢視模式的介面狀態（stats／工具列僅在檢測問題模式顯示） */
function setModeUI(mode) {
  // 離開動態播報模式時停止輪詢（頁面端的監看仍持續累積）
  if (mode !== 'live' && liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  currentMode = mode;
  modeTabs.querySelectorAll('.mode-tab').forEach((t) => {
    const on = t.dataset.mode === mode;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  const issuesMode = mode === 'issues';
  statsEl.hidden = !issuesMode;
  toolbarEl.hidden = !issuesMode;
  if (!issuesMode) {
    cacheNoteEl.hidden = true;       // 非檢測問題模式不顯示快取提示
  } else {
    readingSummaryEl.hidden = true;  // 回到檢測問題模式時收起摘要列
  }
}

/** 注入掃描器並取得朗讀順序（線性化的無障礙樹＋視覺順序落差） */
async function execReadingOrder() {
  if (currentTabId == null) return null;
  // 朗讀順序的物件名稱依賴 axe（accessible name／role）。先探測是否已注入，
  // 避免每次進此模式都重跑 axe.min.js（~550KB）造成不必要的解析成本。
  const probe = await chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    func: () => !!(window.axe && window.__rampA11yReadingOrder),
  });
  const ready = probe && probe[0] && probe[0].result;
  if (!ready) {
    await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      files: ['vendor/axe.min.js', 'vendor/axe-locale-zh_TW.js', 'content/scanner.js'],
    });
  }
  const injection = await chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    func: () => window.__rampA11yReadingOrder(),
  });
  return injection && injection[0] ? injection[0].result : null;
}

/** 產生單一朗讀停點的 HTML */
function readingItemHtml(s) {
  // 地標／表格／清單的進入‧離開邊界：非互動的區域標記
  if (s.kind === 'landmark' || s.kind === 'table' || s.kind === 'list') {
    const dir = s.boundary === 'exit' ? 'exit' : 'enter';
    const tag = s.kind === 'table' ? '表格' : s.kind === 'list' ? '清單' : '地標';
    return `
      <div class="ro-boundary ${dir}">
        <span class="ro-seq">${s.roIndex + 1}</span>
        <span class="ro-bchip">${tag}</span>
        <span class="ro-btext">${escapeHtml(s.text || '')}</span>
      </div>`;
  }
  const roleTag = s.role ? `<span class="ro-role">${escapeHtml(s.role)}</span>` : '';
  let body;
  if (s.kind === 'object') {
    const name = s.name
      ? `<span class="ro-name">${escapeHtml(s.name)}</span>`
      : s.nameRequired
        ? '<span class="ro-noname">（無可朗讀名稱）</span>'
        : '';
    const value = s.value ? ` <span class="nvda-value">${escapeHtml(s.value)}</span>` : '';
    const states = s.states && s.states.length
      ? ` <span class="ro-states">${s.states.map(escapeHtml).join('　')}</span>`
      : '';
    const extra = [s.position, s.itemCount].filter(Boolean).map(escapeHtml).join('　');
    const extraHtml = extra ? ` <span class="nvda-pos">${extra}</span>` : '';
    body = `<span class="ro-body">${name}${value}${states}${extraHtml}</span>`;
  } else {
    // 文字停點（含表格儲存格的座標與欄/列標題）
    const pos = s.position ? ` <span class="nvda-pos">${escapeHtml(s.position)}</span>` : '';
    const desc = s.description ? ` <span class="nvda-desc">${escapeHtml(s.description)}</span>` : '';
    body = `<span class="ro-body ro-text">${escapeHtml(s.text || '')}${pos}${desc}</span>`;
  }
  const flag = s.flagged
    ? '<span class="ro-flag" title="此停點在畫面上的左右位置與朗讀先後相反（視覺順序與朗讀順序落差，對應 WCAG 1.3.2）">順序落差</span>'
    : '';
  return `
    <button class="ro-item${s.flagged ? ' flagged' : ''}" type="button" data-ro="${s.roIndex}"
            title="點擊在頁面上高亮此處">
      <span class="ro-seq">${s.roIndex + 1}</span>
      ${roleTag}
      ${body}
      ${flag}
    </button>`;
}

/** 渲染朗讀順序清單與摘要 */
function renderReadingList(data) {
  readingSummaryEl.hidden = false;
  const flagText = data.flaggedCount
    ? `・<span class="ro-flag-count">${data.flaggedCount} 個順序落差</span>`
    : '・順序與畫面一致';
  const truncText = data.truncated ? `・僅顯示前 ${data.total} 個` : '';
  readingSummaryEl.innerHTML =
    `螢幕報讀軟體（NVDA）會依此順序念出整頁　共 <strong>${data.total}</strong> 個朗讀停點 ${flagText} ${truncText}`;
  issuesEl.innerHTML = data.stops.length
    ? data.stops.map(readingItemHtml).join('')
    : '<p class="ro-empty">此頁沒有可線性化的朗讀內容。</p>';
  issuesEl.scrollTop = 0;
}

/** 切到朗讀順序模式（首次進入才抓資料，之後用快取） */
async function enterReadingMode() {
  setModeUI('reading');
  if (readingData) { renderReadingList(readingData); return; }
  readingSummaryEl.hidden = true;
  issuesEl.innerHTML = '<p class="ro-loading">正在分析整頁朗讀順序…</p>';
  try {
    const data = await execReadingOrder();
    if (!data) {
      issuesEl.innerHTML = '<p class="ro-empty">無法取得朗讀順序，請按「重新檢測」後再試。</p>';
      return;
    }
    readingData = data;
    renderReadingList(data);
  } catch (err) {
    issuesEl.innerHTML = '<p class="ro-empty">分析朗讀順序時發生錯誤。</p>';
  }
}

/** 呼叫頁面內依朗讀索引高亮（沿用掃描器補注入機制） */
async function execHighlightRO(roIndex) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    func: (i) => (window.__rampA11yHighlightRO ? window.__rampA11yHighlightRO(i) : 'missing'),
    args: [roIndex],
  });
  return injection && injection[0] ? injection[0].result : false;
}

async function highlightROonPage(roIndex) {
  if (currentTabId == null) return false;
  try {
    let res = await execHighlightRO(roIndex);
    if (res === 'missing') {
      // 頁面曾重整：補注入掃描器並重建 data-ramp-ro 定位屬性後重試
      await chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: ['content/scanner.js'] });
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        func: () => window.__rampA11yReadingOrder && window.__rampA11yReadingOrder(),
      });
      res = await execHighlightRO(roIndex);
    }
    return res === true;
  } catch {
    return false;
  }
}

// ===== 動態播報（即時區域模擬）=====

/** 產生單一播報項目的 HTML */
function liveItemHtml(e) {
  const pol = e.politeness === 'assertive'
    ? '<span class="live-pol assertive">立即播報</span>'
    : '<span class="live-pol polite">依序播報</span>';
  const d = new Date(e.ts);
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const src = e.source ? `<span class="live-src">${escapeHtml(e.source)}</span>` : '';
  return `
    <div class="live-item ${e.politeness}">
      <span class="live-time">${time}</span>
      ${pol}
      <span class="live-text">🔊 ${escapeHtml(e.text)}</span>
      ${src}
    </div>`;
}

/** 渲染動態播報時間軸（最新在上）與摘要 */
function renderLiveList(data) {
  const log = (data && data.log) || [];
  readingSummaryEl.hidden = false;
  readingSummaryEl.innerHTML =
    `監看即時區域中（aria-live／role=alert…）　已捕捉 <strong>${log.length}</strong> 則播報`
    + `<button class="live-clear" type="button">清除</button>`;
  if (!log.length) {
    issuesEl.innerHTML = '<p class="ro-empty">監看中… 在頁面上觸發動態變化（送出表單看錯誤訊息、按下儲存看提示、即時搜尋…），NVDA 會自動播報的內容就會依序出現在這裡。</p>';
    return;
  }
  issuesEl.innerHTML = log.slice().reverse().map(liveItemHtml).join('');
  issuesEl.scrollTop = 0;
}

/** 向頁面取回目前的播報緩衝並渲染 */
async function refreshLive() {
  if (currentTabId == null) return;
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      func: () => (window.__rampA11yLiveGet ? window.__rampA11yLiveGet() : { on: false, log: [] }),
    });
    const data = injection && injection[0] ? injection[0].result : null;
    if (currentMode === 'live') renderLiveList(data || { log: [] });
  } catch {
    /* 分頁關閉或跳轉時忽略 */
  }
}

/** 切到動態播報模式：注入監看器、開始輪詢 */
async function enterLiveMode() {
  setModeUI('live');
  readingSummaryEl.hidden = true;
  issuesEl.innerHTML = '<p class="ro-loading">開始監看即時區域…</p>';
  try {
    await chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: ['content/scanner.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      func: () => window.__rampA11yLiveStart && window.__rampA11yLiveStart(),
    });
    await refreshLive();
    liveTimer = setInterval(refreshLive, 1200); // 每 1.2 秒輪詢新播報
  } catch (err) {
    issuesEl.innerHTML = '<p class="ro-empty">無法在此頁面啟動動態監看，請重新檢測後再試。</p>';
  }
}

// ===== 報告匯出 =====

/** 報告中的 NVDA 報讀預覽（純文字、可列印） */
function reportNvdaHtml(nvda) {
  if (!nvda) return '';
  const parts = [];
  if (nvda.name) parts.push(nvda.name);
  else if (nvda.nameRequired) parts.push('（無可朗讀名稱）');
  if (nvda.role) parts.push(nvda.role);
  else if (nvda.roleEn) parts.push(nvda.roleEn);
  if (nvda.value) parts.push(nvda.value);
  if (nvda.states && nvda.states.length) parts.push(nvda.states.join('　'));
  if (nvda.position) parts.push(nvda.position);
  if (nvda.itemCount) parts.push(nvda.itemCount);
  if (nvda.description) parts.push('（' + nvda.description + '）');
  if (!parts.length) return '';
  return `<p class="nvda">🔊 模擬 NVDA 朗讀：${escapeHtml(parts.join('　'))}</p>`;
}

/** 報告中的單一問題區塊 */
function reportIssueHtml(item, badgeText, isReview) {
  const impactText = item.impact
    ? `・影響程度：${IMPACT_ZH[item.impact] || escapeHtml(item.impact)}`
    : '';
  const codesText = item.checkCodes && item.checkCodes.length
    ? `・檢測碼 ${item.checkCodes.map(escapeHtml).join('、')}`
    : '';
  const rv = reviewState[item.axeId] || '';
  const reviewText = isReview
    ? `<p><strong>人工複核自評：</strong>${rv === 'pass' ? '通過' : rv === 'fail' ? '不通過' : '未確認'}</p>`
    : '';
  const meta = item.mapped
    ? `台灣網站無障礙規範 ${escapeHtml(item.guideline)} ${escapeHtml(item.guidelineName)}（${escapeHtml(item.category)}）・等級 ${escapeHtml(item.level)}${impactText}${codesText}`
    : `${item.isBestPractice ? '最佳實務建議（非台灣規範必要項目）' : item.isWcag22 ? 'WCAG 2.2 新增準則（台灣規範尚未採用）' : '未對應台灣規範準則'}・axe 規則：${escapeHtml(item.axeId)}${impactText}`;

  const nodes = item.nodes
    .map((n) => `<li><code>${escapeHtml(n.target)}</code>${reportNvdaHtml(n.nvda)}${n.html ? `<pre>${escapeHtml(n.html)}</pre>` : ''}</li>`)
    .join('');
  const more = item.nodeCount > item.nodes.length
    ? `<p class="more">（共 ${item.nodeCount} 個受影響元素，僅列出前 ${item.nodes.length} 個）</p>`
    : '';

  return `
  <section class="issue">
    <h3><span class="badge">${escapeHtml(badgeText)}</span>${escapeHtml(item.title)}</h3>
    <p class="meta">${meta}</p>
    ${item.why ? `<p><strong>為什麼是障礙：</strong>${escapeHtml(item.why)}</p>` : ''}
    ${item.how ? `<p><strong>如何修正：</strong>${escapeHtml(item.how)}</p>` : ''}
    ${item.note ? `<p class="more">※ ${escapeHtml(item.note)}</p>` : ''}
    ${reviewText}
    <p><strong>受影響元素（${item.nodeCount}）：</strong></p>
    <ul class="nodes">${nodes}</ul>
    ${more}
  </section>`;
}

/** 產生自包含的 HTML 檢測報告（可直接以瀏覽器開啟、列印轉 PDF） */
function buildReportHtml(scan) {
  const { violations, bestPractice, incomplete } = classifyResults(scan.result);
  const levelCounts = { A: 0, AA: 0, AAA: 0 };
  let unmappedCount = 0;
  violations.forEach((v) => {
    if (v.mapped) levelCounts[v.level] += 1;
    else unmappedCount += 1;
  });

  let body = '';
  LEVEL_ORDER.forEach((level) => {
    const group = sortByImpact(violations.filter((v) => v.mapped && v.level === level));
    if (group.length === 0) return;
    body += `<h2>等級 ${level}（${group.length} 項）</h2>` + group.map((v) => reportIssueHtml(v, level)).join('');
  });
  const unmapped = sortByImpact(violations.filter((v) => !v.mapped));
  if (unmapped.length) {
    body += `<h2>其他 WCAG 項目（未對應台灣準則，${unmapped.length} 項）</h2>` + unmapped.map((v) => reportIssueHtml(v, '其他')).join('');
  }
  if (bestPractice.length) {
    body += `<h2>最佳實務建議（非規範必要，${bestPractice.length} 項）</h2>` + bestPractice.map((v) => reportIssueHtml(v, '建議')).join('');
  }
  if (incomplete.length) {
    body += `<h2>需人工複核（${incomplete.length} 項）</h2>` + incomplete.map((v) => reportIssueHtml(v, '複核', true)).join('');
  }
  if (!violations.length && !incomplete.length) {
    body += '<p>未發現自動化可偵測的違規。自動化檢測僅涵蓋部分無障礙問題，仍需人工複核。</p>';
  }

  // 人工複核自評摘要
  let reviewSummary = '';
  if (incomplete.length) {
    const counts = { pass: 0, fail: 0, none: 0 };
    incomplete.forEach((i) => { counts[reviewState[i.axeId] || 'none'] += 1; });
    reviewSummary = `<p class="info">人工複核自評：通過 ${counts.pass} 項・不通過 ${counts.fail} 項・未確認 ${counts.none} 項（自評由檢測者自行填寫，僅供內部參考）</p>`;
  }

  const version = chrome.runtime.getManifest().version;
  const time = new Date(scan.ts).toLocaleString('zh-TW');

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ramp 無障礙檢測報告 — ${escapeHtml(scan.url)}</title>
<style>
  body { font-family: "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", system-ui, sans-serif;
         max-width: 860px; margin: 0 auto; padding: 24px; color: #1F2937; line-height: 1.7; }
  header { border-bottom: 3px solid #0F766E; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { font-size: 22px; color: #0F766E; }
  h2 { font-size: 17px; margin: 28px 0 10px; padding-bottom: 4px; border-bottom: 1px solid #E5E7EB; }
  .info, .meta, .more { color: #4B5563; font-size: 13px; }
  table.stats { border-collapse: collapse; margin: 12px 0; }
  table.stats th, table.stats td { border: 1px solid #E5E7EB; padding: 6px 14px; font-size: 14px; }
  table.stats th { background: #F9FAFB; }
  .issue { border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px 16px; margin: 10px 0;
           page-break-inside: avoid; }
  .issue h3 { font-size: 15px; margin-bottom: 4px; }
  .badge { display: inline-block; background: #374151; color: #fff; border-radius: 999px;
           font-size: 12px; padding: 1px 10px; margin-right: 8px; vertical-align: middle; }
  .nodes { margin-left: 20px; }
  .nodes code { font-size: 12px; word-break: break-all; }
  .nodes pre { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 4px;
               padding: 4px 8px; font-size: 11px; white-space: pre-wrap; word-break: break-all; margin: 2px 0 8px; }
  .nodes .nvda { font-size: 12px; color: #0F766E; margin: 2px 0 4px; }
  .disclaimer { margin-top: 32px; padding: 12px 16px; background: #FEF9C3; border-radius: 8px;
                font-size: 13px; color: #713F12; }
</style>
</head>
<body>
<header>
  <h1>Ramp 無障礙檢測報告</h1>
  <p class="info">檢測網址：${escapeHtml(scan.url)}<br>
  檢測時間：${escapeHtml(time)}<br>
  工具：Ramp（ramp-a11y）v${escapeHtml(version)}・檢測引擎 axe-core 4.10.3<br>
  對應標準：台灣「網站無障礙規範」現行 110.07 版（對齊 WCAG 2.1）；115 年修正版（對齊 WCAG 2.2）自 115 年 11 月 30 日生效，版本差異條目已於內文附註</p>
</header>
<table class="stats">
  <tr><th>違規總數</th><th>等級 A</th><th>等級 AA</th><th>等級 AAA</th><th>未對應</th><th>最佳實務建議</th><th>需人工複核</th></tr>
  <tr><td>${violations.length}</td><td>${levelCounts.A}</td><td>${levelCounts.AA}</td><td>${levelCounts.AAA}</td><td>${unmappedCount}</td><td>${bestPractice.length}</td><td>${incomplete.length}</td></tr>
</table>
${reviewSummary}
${body}
<div class="disclaimer">
  <strong>限制聲明：</strong>自動化檢測僅能涵蓋約三到四成的無障礙問題，本報告不等同官方無障礙標章認證，
  鍵盤操作動線、報讀軟體實際體驗、替代文字是否恰當等仍需人工複核。
</div>
</body>
</html>`;
}

/** 匯出報告：產生 HTML 檔並觸發下載 */
function exportReport() {
  if (!lastScan) return;
  const html = buildReportHtml(lastScan);
  let host = '';
  try { host = new URL(lastScan.url).hostname.replace(/[^\w.-]/g, ''); } catch { /* 保持空字串 */ }
  const d = new Date(lastScan.ts);
  const pad = (n) => String(n).padStart(2, '0');
  const filename = `ramp-a11y-report-${host}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.html`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ===== 事件繫結 =====

btnScan.addEventListener('click', runScan);
btnRescan.addEventListener('click', runScan);
btnRetry.addEventListener('click', runScan);
btnExport.addEventListener('click', exportReport);

/** 以最後一次掃描結果重新渲染（篩選、目標等級變更時） */
function rerender() {
  if (lastScan) renderResults(lastScan.result, lastScan.fromCacheTs);
}

levelSelect.addEventListener('change', () => {
  prefs.targetLevel = levelSelect.value;
  savePrefs();
  rerender();
});

delaySelect.addEventListener('change', () => {
  prefs.scanDelay = Number(delaySelect.value) || 0;
  savePrefs();
});

filterGroup.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  prefs.resultFilter = chip.dataset.filter;
  syncFilterUI();
  savePrefs();
  rerender();
});

// 檢視模式切換：檢測問題 ↔ 朗讀順序 ↔ 動態播報
modeTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.mode-tab');
  if (!tab || tab.dataset.mode === currentMode) return;
  const mode = tab.dataset.mode;
  if (mode === 'reading') {
    enterReadingMode();
  } else if (mode === 'live') {
    enterLiveMode();
  } else {
    setModeUI('issues');
    rerender(); // 以最後一次掃描結果重繪問題清單
  }
});

// 動態播報「清除」按鈕（摘要列為動態渲染，採事件代理）
readingSummaryEl.addEventListener('click', (e) => {
  if (!e.target.closest('.live-clear') || currentTabId == null) return;
  chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    func: () => window.__rampA11yLiveClear && window.__rampA11yLiveClear(),
  }).then(() => refreshLive());
});

// 人工複核自評變更（事件代理，自評選單為動態渲染）
issuesEl.addEventListener('change', (e) => {
  const sel = e.target.closest('.review-select');
  if (!sel || !reviewKey) return;
  const axeId = sel.dataset.axeId;
  if (sel.value) reviewState[axeId] = sel.value;
  else delete reviewState[axeId];
  try { chrome.storage.local.set({ [reviewKey]: reviewState }); } catch { /* 忽略 */ }
});

// popup 開啟時：
//  1. 受保護頁面直接顯示「無法檢測」，不給一顆註定失敗的按鈕
//  2. 若同一分頁、同一網址有快取結果，直接還原（不必重掃）
(async function initPopup() {
  try {
    await loadPrefs();
    const tab = await getActiveTab();
    if (!tab) return;
    if (isRestrictedUrl(tab.url)) {
      showError(
        '此頁面無法檢測',
        '瀏覽器內建頁面（chrome:// 等）與擴充功能商店基於安全限制，無法注入檢測腳本。請切換到一般網頁再試。',
        false
      );
      return;
    }
    const key = 'scan_' + tab.id;
    const store = await chrome.storage.session.get(key);
    const cached = store[key];
    if (cached && cached.url === tab.url && cached.result) {
      await loadRulesMap();
      await loadReviewState(tab.url);
      currentTabId = tab.id;
      lastScan = { result: cached.result, url: cached.url, ts: cached.ts, fromCacheTs: cached.ts };
      renderResults(cached.result, cached.ts);
    }
  } catch {
    // 初始化失敗就停留在初始畫面，不影響使用
  }
})();

// 展開／收合與元素高亮採事件代理，內容為動態渲染
issuesEl.addEventListener('click', async (e) => {
  // 朗讀順序停點 → 頁面高亮（再次點擊清除）
  const roItem = e.target.closest('.ro-item');
  if (roItem) {
    if (roItem.classList.contains('active')) {
      issuesEl.querySelectorAll('.ro-item.active').forEach((b) => b.classList.remove('active'));
      if (currentTabId != null) {
        chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          func: () => window.__rampA11yClear && window.__rampA11yClear(),
        });
      }
      return;
    }
    issuesEl.querySelectorAll('.ro-item.active').forEach((b) => b.classList.remove('active'));
    const ok = await highlightROonPage(Number(roItem.dataset.ro));
    if (ok) {
      roItem.classList.add('active');
    } else {
      roItem.insertAdjacentHTML('afterend',
        '<span class="node-hint">無法在頁面上定位（元素可能已變更，請重新檢測）</span>');
      setTimeout(() => {
        const hint = roItem.parentElement && roItem.parentElement.querySelector('.node-hint');
        if (hint) hint.remove();
      }, 3000);
    }
    return;
  }

  // 展開／收合
  const header = e.target.closest('.issue-header');
  if (header) {
    const expanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', String(!expanded));
    header.nextElementSibling.hidden = expanded;
    return;
  }

  // 點擊受影響元素 → 頁面高亮
  const nodeBtn = e.target.closest('.node-btn');
  if (nodeBtn) {
    // 再次點擊同一個已高亮的元素 → 清除高亮
    if (nodeBtn.classList.contains('active')) {
      issuesEl.querySelectorAll('.node-btn.active').forEach((b) => b.classList.remove('active'));
      if (currentTabId != null) {
        chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          func: () => window.__rampA11yClear && window.__rampA11yClear(),
        });
      }
      return;
    }

    issuesEl.querySelectorAll('.node-btn.active').forEach((b) => b.classList.remove('active'));
    const ok = await highlightOnPage(nodeBtn.dataset.selector);
    if (ok) {
      nodeBtn.classList.add('active');
    } else {
      // 元素可能位於 iframe / shadow DOM 或已從頁面移除
      nodeBtn.insertAdjacentHTML(
        'afterend',
        '<span class="node-hint">無法在頁面上定位此元素（可能位於 iframe 或已變更）</span>'
      );
      setTimeout(() => {
        const hint = nodeBtn.parentElement.querySelector('.node-hint');
        if (hint) hint.remove();
      }, 3000);
    }
  }
});
