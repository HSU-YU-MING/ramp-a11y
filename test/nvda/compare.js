/**
 * 真 NVDA 對照工具（手動執行，非自動化 CI）
 *
 * 目的：讓「真正的 NVDA」走過測試頁，擷取它實際念出的每一句，與我們的
 *       __rampA11yReadingOrder 模擬並排比對，驗證用詞／組合是否貼近真實 NVDA。
 *
 * 需求：
 *   - Windows + 本機 Chrome
 *   - 先安裝 Guidepup 的 NVDA：npx @guidepup/setup（會裝一份掛了 NVDA Remote
 *     附加元件的專用 NVDA，供 Guidepup 驅動與擷取語音）
 *
 * 用法：node test/nvda/compare.js [fixture 檔名，預設 nvda-fixture.html]
 *
 * ⚠ 焦點注意：執行時會開一個瀏覽器視窗。NVDA 跟隨「鍵盤焦點」朗讀，而 Windows
 *   的前景鎖定不允許背景腳本可靠地把焦點搶到瀏覽器。因此本工具會**請你在倒數內
 *   親手點一下開啟的瀏覽器視窗**，NVDA 才會讀到該頁（若焦點仍在別的視窗——例如
 *   開著的「設定」視窗——請先關掉那些視窗）。這也是本工具維持手動、不進 CI 的原因。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const cp = require('child_process');
const { nvda } = require('@guidepup/guidepup');
const puppeteer = require('puppeteer-core');

const REPO = path.resolve(__dirname, '..', '..');
const FIXTURE = process.argv[2] || 'nvda-fixture.html';
const PORT = 18973;
const URL = `http://127.0.0.1:${PORT}/${FIXTURE}`;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把停點壓成一行文字，方便與 NVDA 語音並排 */
function stopToLine(s) {
  if (s.kind === 'landmark' || s.kind === 'table') return '〔' + s.text + '〕';
  if (s.kind === 'object') {
    const bits = [s.name || (s.nameRequired ? '（無可朗讀名稱）' : ''), s.role];
    if (s.value) bits.push(s.value);
    if (s.states && s.states.length) bits.push(s.states.join(' '));
    if (s.position) bits.push(s.position);
    if (s.itemCount) bits.push(s.itemCount);
    if (s.description) bits.push('（' + s.description + '）');
    return bits.filter(Boolean).join(' ');
  }
  return (s.text || '') + (s.position ? ' ' + s.position : '') + (s.description ? '（' + s.description + '）' : '');
}

(async () => {
  if (!CHROME) throw new Error('找不到 Chrome');
  const server = http.createServer((req, res) => {
    const p = path.join(REPO, 'test', req.url === '/' ? FIXTURE : req.url.replace(/^\//, ''));
    fs.readFile(p, (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
  }).listen(PORT);

  // (A) 我們的模擬（headless）
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', pipe: true });
  const pg = await b.newPage();
  await pg.goto(URL, { waitUntil: 'load' });
  await pg.addScriptTag({ path: path.join(REPO, 'vendor/axe.min.js') });
  await pg.addScriptTag({ path: path.join(REPO, 'vendor/axe-locale-zh_TW.js') });
  await pg.addScriptTag({ path: path.join(REPO, 'content/scanner.js') });
  const ro = await pg.evaluate(() => window.__rampA11yReadingOrder());
  await b.close();
  const ourLines = ro.stops.map(stopToLine);

  // (B) 真 NVDA
  try { cp.execSync('taskkill /IM nvda.exe /F', { stdio: 'ignore' }); } catch (e) { /* 沒在跑就算了 */ }
  await sleep(1200);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'nvda-cmp-'));
  const chrome = cp.spawn(CHROME, ['--user-data-dir=' + prof, '--no-first-run', '--new-window', URL], { detached: false });
  await sleep(3500);
  await nvda.start();
  await sleep(1500);
  for (let n = 6; n >= 1; n--) { process.stdout.write(`\r👉 請點一下剛開啟的瀏覽器視窗，讓 NVDA 讀它…（${n}）  `); await sleep(1000); }
  process.stdout.write('\n');
  await nvda.clearSpokenPhraseLog();
  await nvda.press('Control+Home'); await sleep(800);
  const phrases = []; let same = 0, prev = null;
  for (let i = 0; i < 45; i++) {
    await nvda.next();
    const p = (await nvda.lastSpokenPhrase() || '').trim();
    if (p === prev) { if (++same >= 3) break; } else same = 0;
    prev = p; if (p) phrases.push(p);
  }
  await nvda.stop();
  try { cp.execSync('taskkill /PID ' + chrome.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
  server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

  const rows = Math.max(phrases.length, ourLines.length);
  console.log('\n頁面：' + FIXTURE);
  console.log('─'.repeat(78));
  console.log('  #  | 真 NVDA 念出的'.padEnd(44) + '| 我們的模擬');
  console.log('─'.repeat(78));
  for (let i = 0; i < rows; i++) {
    const l = (String(i + 1).padStart(3) + '  | ' + (phrases[i] || '')).padEnd(44);
    console.log(l + '| ' + (ourLines[i] || ''));
  }
  console.log('─'.repeat(78));
  const focusOk = phrases.some((p) => /報讀|測試頁|滑桿|表格|導覽/.test(p));
  if (!focusOk) {
    console.log('⚠ NVDA 似乎沒讀到本頁（可能焦點在別的視窗）。請關掉其他視窗、重跑，');
    console.log('  並在倒數內親手點一下開啟的瀏覽器視窗。');
  }
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
