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

// ===== 全域狀態 =====
let rulesMap = new Map(); // axeRuleId → 對應表項目
let currentTabId = null;  // 當前掃描的分頁 id
let lastScan = null;      // 最後一次掃描 { result, url, ts }，供報告匯出

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

// ===== 掃描流程 =====

async function runScan() {
  showView('loading');
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

    lastScan = { result, url: tab.url, ts: Date.now() };
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

/** 產生單一問題項目的 HTML */
function issueHtml(item, badgeClass, badgeText) {
  const nodesHtml = item.nodes
    .map(
      (n) => `
        <li>
          <button class="node-btn" type="button" data-selector="${escapeHtml(n.target)}"
                  title="點擊在頁面上高亮此元素">
            ${escapeHtml(n.target)}
          </button>
          ${n.html ? `<code class="node-html">${escapeHtml(n.html.slice(0, 120))}${n.html.length > 120 ? '…' : ''}</code>` : ''}
        </li>`
    )
    .join('');

  const impactText = item.impact
    ? `・影響程度：${IMPACT_ZH[item.impact] || escapeHtml(item.impact)}`
    : '';
  const guidelineHtml = item.mapped
    ? `<p class="guideline">台灣網站無障礙規範 ${escapeHtml(item.guideline)} ${escapeHtml(item.guidelineName)}（${escapeHtml(item.category)}）・等級 ${escapeHtml(item.level)}${impactText}</p>`
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
  const { violations, bestPractice, incomplete } = classifyResults(result);

  renderStats(violations, bestPractice.length, incomplete.length);

  // 快取還原提示
  if (cachedTs) {
    cacheNoteEl.textContent = `顯示上次檢測結果（${timeAgo(cachedTs)}）— 頁面內容可能已變動，可按「重新檢測」更新。`;
    cacheNoteEl.hidden = false;
  } else {
    cacheNoteEl.hidden = true;
  }

  let html = '';

  if (violations.length === 0) {
    // 無違規：正向訊息＋人工複核提醒
    html += `
      <div class="all-clear">
        <p class="success-title">太好了！未發現自動化可偵測的違規</p>
        <p class="success-note">自動化檢測僅能涵蓋約三到四成的無障礙問題，仍建議進行鍵盤操作、報讀軟體等人工複核。</p>
      </div>`;
  } else {
    // 依 A / AA / AAA 分組，同組內依嚴重度排序
    LEVEL_ORDER.forEach((level) => {
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
  }

  // axe 最佳實務建議（非規範必要，獨立分組避免灌水「違規」數字）
  if (bestPractice.length > 0) {
    html += `<h2 class="group-heading">最佳實務建議（非規範必要，${bestPractice.length} 項）</h2>`;
    html += bestPractice.map((v) => issueHtml(v, 'badge-bp', '建議')).join('');
  }

  // incomplete → 需人工複核
  if (incomplete.length > 0) {
    html += `<h2 class="group-heading">需人工複核（${incomplete.length} 項）</h2>`;
    html += incomplete.map((v) => issueHtml(v, 'badge-review', '複核')).join('');
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

// ===== 報告匯出 =====

/** 報告中的單一問題區塊 */
function reportIssueHtml(item, badgeText) {
  const impactText = item.impact
    ? `・影響程度：${IMPACT_ZH[item.impact] || escapeHtml(item.impact)}`
    : '';
  const meta = item.mapped
    ? `台灣網站無障礙規範 ${escapeHtml(item.guideline)} ${escapeHtml(item.guidelineName)}（${escapeHtml(item.category)}）・等級 ${escapeHtml(item.level)}${impactText}`
    : `${item.isBestPractice ? '最佳實務建議（非台灣規範必要項目）' : item.isWcag22 ? 'WCAG 2.2 新增準則（台灣規範尚未採用）' : '未對應台灣規範準則'}・axe 規則：${escapeHtml(item.axeId)}${impactText}`;

  const nodes = item.nodes
    .map((n) => `<li><code>${escapeHtml(n.target)}</code>${n.html ? `<pre>${escapeHtml(n.html)}</pre>` : ''}</li>`)
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
    body += `<h2>需人工複核（${incomplete.length} 項）</h2>` + incomplete.map((v) => reportIssueHtml(v, '複核')).join('');
  }
  if (!violations.length && !incomplete.length) {
    body += '<p>未發現自動化可偵測的違規。自動化檢測僅涵蓋部分無障礙問題，仍需人工複核。</p>';
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

// popup 開啟時：
//  1. 受保護頁面直接顯示「無法檢測」，不給一顆註定失敗的按鈕
//  2. 若同一分頁、同一網址有快取結果，直接還原（不必重掃）
(async function initPopup() {
  try {
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
      currentTabId = tab.id;
      lastScan = { result: cached.result, url: cached.url, ts: cached.ts };
      renderResults(cached.result, cached.ts);
    }
  } catch {
    // 初始化失敗就停留在初始畫面，不影響使用
  }
})();

// 展開／收合與元素高亮採事件代理，內容為動態渲染
issuesEl.addEventListener('click', async (e) => {
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
