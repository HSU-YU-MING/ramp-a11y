/**
 * cli/auth.js
 * ramp-scan 登入後掃描的純邏輯（不碰 Chrome，test/cli 直接 require 驗證）。
 *
 * 四種方式（Lighthouse〈authenticated pages〉同一套思路）：
 *   --cookies <file>        匯入 cookie（DevTools／擴充功能匯出的 JSON，或 Netscape cookies.txt）
 *   --header "Name: Value"  自訂標頭（Authorization 之類），只送給被掃網站自己的來源
 *   --user-data-dir <dir>   用已經登入過的 Chrome 設定檔
 *   --login                 開一個看得見的 Chrome 讓人自己登入（驗證碼、自然人憑證都行），按 Enter 再掃
 *
 * 安全邊界：憑證的值**不寫進報告、不印出來**（報告只記用了哪幾種方式）；錯誤訊息只說第幾行、哪個欄位。
 * 標頭只送同來源，避免 token 跟著頁面上的第三方資源（CDN、分析、廣告）送出去。
 */
'use strict';

/**
 * 解析 cookie 檔。認得三種：
 *   - JSON 陣列：[{ name, value, domain, path, ... }]（Puppeteer／DevTools Protocol 的格式）
 *   - JSON 物件包一層：{ cookies: [...] }（部分擴充功能的匯出）
 *   - Netscape cookies.txt：domain \t includeSubdomains \t path \t secure \t expires \t name \t value
 * 回傳給 page.setCookie 用的陣列；格式不對丟 Error（呼叫端轉成參數錯誤 exit 1）。
 */
function parseCookieFile(text) {
  const src = String(text).replace(/^\uFEFF/, ''); // 去掉 UTF-8 BOM
  const trimmed = src.trim();
  if (!trimmed) throw new Error('cookie 檔是空的');
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      // 不帶 e.message：V8 的訊息常引用一段輸入（"…TOPSECRET…" is not valid JSON），會把 cookie 值印出來。
      // 只取位置（「第幾行第幾欄」）
      const m = /line (\d+) column (\d+)/.exec(String(e && e.message));
      throw new Error(`cookie 檔不是有效的 JSON${m ? `（第 ${m[1]} 行第 ${m[2]} 欄附近）` : ''}`);
    }
    const list = Array.isArray(data)
      ? data
      : data && Array.isArray(data.cookies)
        ? data.cookies
        : null;
    if (!list) throw new Error('cookie 檔的 JSON 要是陣列，或 { "cookies": [...] }');
    return list.map((c, i) => {
      if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') {
        throw new Error(`cookie 檔第 ${i + 1} 筆缺 name 或 value`);
      }
      if (!c.domain && !c.url) throw new Error(`cookie 檔第 ${i + 1} 筆（${c.name}）缺 domain`);
      const out = { name: c.name, value: c.value };
      for (const k of ['domain', 'path', 'url', 'secure', 'httpOnly', 'sameSite']) {
        if (c[k] !== undefined && c[k] !== null) out[k] = c[k];
      }
      // 匯出格式不一：expirationDate（Chrome 擴充 API）／expires（DevTools）
      const exp = c.expires !== undefined ? c.expires : c.expirationDate;
      if (typeof exp === 'number' && exp > 0) out.expires = exp;
      if (typeof out.sameSite === 'string') out.sameSite = normalizeSameSite(out.sameSite);
      if (out.sameSite === undefined) delete out.sameSite;
      return out;
    });
  }
  // Netscape cookies.txt
  const cookies = [];
  src.split(/\r?\n/).forEach((line, i) => {
    let l = line;
    let httpOnly = false;
    if (l.startsWith('#HttpOnly_')) {
      httpOnly = true;
      l = l.slice('#HttpOnly_'.length);
    } else if (!l.trim() || l.startsWith('#')) return;
    const f = l.split('\t');
    if (f.length < 7) throw new Error(`cookies.txt 第 ${i + 1} 行不是 7 個以 Tab 分隔的欄位`);
    const [domain, , pathPart, secure, expires, name, ...rest] = f;
    const c = {
      name,
      value: rest.join('\t'),
      domain,
      path: pathPart || '/',
      secure: secure === 'TRUE',
      httpOnly,
    };
    const e = Number(expires);
    if (Number.isFinite(e) && e > 0) c.expires = e;
    cookies.push(c);
  });
  if (!cookies.length) throw new Error('cookies.txt 裡沒有任何 cookie');
  return cookies;
}

function normalizeSameSite(v) {
  const s = v.toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'lax') return 'Lax';
  if (s === 'none' || s === 'no_restriction') return 'None';
  return undefined; // unspecified 之類：交給 Chrome 預設
}

/**
 * --header 的值（可重複）→ { 名稱: 值 }。格式 "Name: Value"；名稱只收 token 字元。
 * Host、Cookie 以外的一般標頭都可以；Cookie 請用 --cookies（會綁網域，不會亂送）。
 */
function parseHeaders(list) {
  const out = {};
  for (const raw of list || []) {
    const i = String(raw).indexOf(':');
    const name = i > 0 ? raw.slice(0, i).trim() : '';
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error('--header 要寫成 "名稱: 值"（名稱不能有空白或特殊字元）');
    }
    const lower = name.toLowerCase();
    if (lower === 'host') throw new Error('--header 不能改 Host');
    if (lower === 'cookie')
      throw new Error('Cookie 請用 --cookies 匯入（會綁網域，不會送給別的網站）');
    out[name] = raw.slice(i + 1).trim();
  }
  return out;
}

/**
 * 看起來像登出的網址：登入後爬掃要跳過，否則爬到「登出」連結整個工作階段就沒了，
 * 之後每一頁掃到的都是登入頁（Lighthouse 的文件也提醒同一件事）。
 */
const LOGOUT_RE = /(?:log|sign)[-_ ]?(?:out|off)|登出|logoff/i;
function isLogoutUrl(url) {
  let p;
  try {
    const u = new URL(url);
    p = decodeURIComponent(u.pathname + u.search);
  } catch (e) {
    p = String(url);
  }
  return LOGOUT_RE.test(p);
}

/** 網址的來源（scheme://host:port）；不是網址回 null */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return null;
  }
}

/** 報告記錄用的登入方式（只有方式，沒有任何值） */
function authMethods(values) {
  const m = [];
  if (values.cookies) m.push('cookies');
  if (values.header && values.header.length) m.push('header');
  if (values['user-data-dir']) m.push('profile');
  if (values.login) m.push('login');
  return m;
}

const AUTH_ZH = {
  cookies: 'cookie 檔',
  header: '自訂標頭',
  profile: 'Chrome 設定檔',
  login: '手動登入',
};

/** 報告頁首的一行（沒有登入回 null） */
function authLine(methods) {
  if (!methods || !methods.length) return null;
  return `登入狀態：以${methods.map((m) => AUTH_ZH[m] || m).join('＋')}掃描（報告不記錄任何憑證）`;
}

module.exports = { parseCookieFile, parseHeaders, isLogoutUrl, originOf, authMethods, authLine };
