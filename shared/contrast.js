/**
 * shared/contrast.js
 * 內建對比檢查器的純邏輯（無 DOM／chrome 依賴，test/unit 直接 require 驗證）。
 *
 * 為什麼要有：axe 的 color-contrast 遇到背景是圖片、漸層、被別的元素蓋住時算不出背景色，
 * 只能丟進「需人工複核」——實測案例一頁就有 102 處。WAVE 的做法是給一個手動的取色器；
 * 這裡改成直接量螢幕上實際畫出來的顏色：截目前分頁可見範圍（activeTab 本來就允許
 * captureVisibleTab，不需要新權限；截圖只在 popup 記憶體裡用，不存、不外傳），
 * 在每一行文字的外框外面取一圈像素當背景，跟文字顏色逐點算對比，回報最差與中位數。
 *
 *   - 外框外面一圈：行框（Range.getClientRects）把字形包在裡面，外面那一圈只有背景，
 *     避開反鋸齒的邊緣像素（那些是字色與背景的混色，會把對比拉低成假的最差值）。
 *     落在同一元素其他行框裡的點不取（多行文字的上下一行）。
 *   - 回報最差而不是平均：背景是照片或漸層時，字最難讀的那一段才是障礙所在。
 *
 * UMD 包裝，與 shared/report-core.js 同樣式：瀏覽器 → window.RampContrast，Node → require。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RampContrast = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** '#rgb'／'#rrggbb'／'rgb(r, g, b)'／'rgba(r, g, b, a)' → { r, g, b, a }；看不懂回 null */
  function parseColor(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(t);
    if (m) {
      const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
      return { r, g, b, a: 1 };
    }
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(t);
    if (m) {
      return {
        r: parseInt(m[1].slice(0, 2), 16),
        g: parseInt(m[1].slice(2, 4), 16),
        b: parseInt(m[1].slice(4, 6), 16),
        a: m[2] ? parseInt(m[2], 16) / 255 : 1,
      };
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(t);
    if (m) {
      let a = 1;
      if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a };
    }
    return null;
  }

  function toHex(c) {
    const h = (v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0');
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
  }

  /** WCAG 2.x 相對亮度 */
  function luminance(c) {
    const ch = (v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }

  /** 兩個不透明顏色的對比值（1–21），不四捨五入 */
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** 半透明的字色疊在背景上（螢幕上實際看到的字色） */
  function over(top, bottom) {
    const a = top.a === undefined ? 1 : top.a;
    return {
      r: top.r * a + bottom.r * (1 - a),
      g: top.g * a + bottom.g * (1 - a),
      b: top.b * a + bottom.b * (1 - a),
      a: 1,
    };
  }

  /**
   * 這段文字的 AA 門檻：大字級（≥ 24px，或粗體 ≥ 18.66px，即 18pt／14pt）3:1，其餘 4.5:1。
   * fontSizePx 算不出來時當一般文字（往嚴格那邊錯）。
   */
  function requiredRatio(fontSizePx, fontWeight) {
    const size = Number(fontSizePx) || 0;
    const bold = Number(fontWeight) >= 700 || fontWeight === 'bold' || fontWeight === 'bolder';
    return size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
  }

  /**
   * 每一個行框外面一圈的取樣點（截圖的像素座標）。
   * @param {Array<{x:number,y:number,w:number,h:number}>} rects 行框（CSS px，相對視窗）
   * @param {number} scale  截圖像素 / CSS px（含 devicePixelRatio 與縮放）
   * @param {number} imgW   截圖寬（像素）
   * @param {number} imgH   截圖高
   * @param {number} [gap=2]  離行框幾個 CSS px 取樣
   * @param {number} [step=2] 沿邊每隔幾個 CSS px 取一點
   */
  function ringPoints(rects, scale, imgW, imgH, gap = 2, step = 2) {
    const pts = [];
    const seen = new Set();
    const inside = (x, y) =>
      rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    const add = (x, y) => {
      if (inside(x, y)) return; // 落在別的行框裡（多行文字的上下一行）
      const px = Math.round(x * scale);
      const py = Math.round(y * scale);
      if (px < 0 || py < 0 || px >= imgW || py >= imgH) return;
      const k = px + ',' + py;
      if (seen.has(k)) return;
      seen.add(k);
      pts.push([px, py]);
    };
    for (const r of rects) {
      if (!(r.w > 0 && r.h > 0)) continue;
      const left = r.x - gap;
      const right = r.x + r.w + gap;
      const top = r.y - gap;
      const bottom = r.y + r.h + gap;
      for (let x = left; x <= right; x += step) {
        add(x, top);
        add(x, bottom);
      }
      for (let y = top; y <= bottom; y += step) {
        add(left, y);
        add(right, y);
      }
    }
    return pts;
  }

  /**
   * 文字顏色對每個背景取樣點算對比，回報最差、中位數、最好。
   * 跟字色幾乎一樣的點不算（多半是旁邊另一段同色文字的字形），算進去會變成假的 1:1。
   * @param {{r,g,b,a}} fg   文字顏色（可半透明，逐點疊在那個背景上）
   * @param {Array<{r,g,b}>} samples 背景取樣
   * @param {number} required 門檻（4.5 或 3）
   * @returns {null | {n, worst, median, best, worstBg, bestBg, belowCount, pass}}
   */
  function summarize(fg, samples, required) {
    const rows = [];
    for (const bg of samples) {
      const shown = fg.a < 1 ? over(fg, bg) : fg;
      const d = Math.abs(shown.r - bg.r) + Math.abs(shown.g - bg.g) + Math.abs(shown.b - bg.b);
      if (d < 12) continue;
      rows.push({ ratio: contrast(shown, bg), bg });
    }
    if (!rows.length) return null;
    rows.sort((a, b) => a.ratio - b.ratio);
    const mid = rows[Math.floor((rows.length - 1) / 2)].ratio;
    const below = rows.filter((r) => r.ratio < required).length;
    return {
      n: rows.length,
      worst: rows[0].ratio,
      median: mid,
      best: rows[rows.length - 1].ratio,
      worstBg: toHex(rows[0].bg),
      bestBg: toHex(rows[rows.length - 1].bg),
      belowCount: below,
      pass: below === 0,
    };
  }

  /** 比值給人看：無條件捨去到小數兩位（4.499 不能顯示成 4.5:1 然後判不通過） */
  function formatRatio(v) {
    return `${(Math.floor(v * 100) / 100).toFixed(2)}:1`;
  }

  /** axe 的 color-contrast 為什麼算不出來（messageKey）→ 給人看的原因 */
  const REASON_ZH = {
    bgImage: '背景是圖片',
    bgGradient: '背景是漸層',
    imgNode: '文字疊在圖片元素上',
    bgOverlap: '有其他元素蓋在文字下面或上面',
    elmPartiallyObscured: '文字被其他元素部分遮住',
    elmPartiallyObscuring: '文字蓋到其他元素',
    outsideViewport: '元素在視窗外',
    equalRatio: '字色與背景色相同',
    shortTextContent: '文字太短（單一字元多半是圖示）',
    nonBmp: '文字是圖示字元',
    pseudoContent: '背景來自偽元素',
    fgAlpha: '文字顏色半透明',
    colorParse: '顏色格式無法解析',
    shadowOnText: '文字有陰影',
  };

  function reasonText(key) {
    return key ? REASON_ZH[key] || `axe 無法判定（${key}）` : '';
  }

  return {
    parseColor,
    toHex,
    luminance,
    contrast,
    over,
    requiredRatio,
    ringPoints,
    summarize,
    formatRatio,
    reasonText,
  };
});
