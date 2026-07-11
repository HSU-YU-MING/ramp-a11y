/**
 * 真 NVDA 對照工具（全自動，需互動桌面；不進 CI）
 *
 * 讓「真正的 NVDA」以瀏覽模式逐行走過測試頁（含文字、控制項、表格、地標），
 * 擷取它實際念出的每一句，與我們的 __rampA11yReadingOrder 模擬並排比對，
 * 驗證用詞／組合／線性化順序的忠實度。
 *
 * 需求：Windows + 本機 Chrome + 先執行 npx @guidepup/setup（安裝 Guidepup 專用 NVDA）
 * 用法：npm run test:nvda [-- fixture 檔名，預設 nvda-fixture.html]
 *
 * 全自動焦點處理（實測踩雷後的成果，勿隨意簡化）：
 *  1. NVDA 啟動時 Windows 常會彈出「設定 > 協助工具」搶焦點 → 啟動後殺 SystemSettings.exe
 *  2. Guidepup NVDA 預設開啟「語音檢視器」且置頂蓋在畫面左上（x=0,y=0,500x500），
 *     會攔截點擊 → 先把 guidepup nvda.ini 的 showSpeechViewerAtStartup 關掉
 *  3. 以合成滑鼠點擊（OS 層）點進 Chrome 視窗內，真正轉移鍵盤焦點
 *  4. Tab 一定要用 nvda.press()（OS 層、經 NVDA 鍵盤攔截）；CDP 合成鍵盤
 *     只會移動 DOM 焦點，NVDA 聽不到
 *
 * 執行期間 NVDA 會出聲朗讀、桌面視窗會被最小化——屬預期行為。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const cp = require('child_process');
const { nvda } = require('@guidepup/guidepup');
const puppeteer = require('puppeteer-core');

const REPO = path.resolve(__dirname, '..', '..');
const FIXTURE = process.argv[2] || 'nvda-fixture.html';
const PORT = 18985;
const URL = `http://127.0.0.1:${PORT}/${FIXTURE}`;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 寫入並執行內嵌的 PowerShell 輔助腳本 */
const PS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ramp-nvda-ps-'));
function ps(name, args = '') {
  try {
    return cp.execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(PS_DIR, name)}" ${args}`,
      { encoding: 'utf8' }
    ).trim();
  } catch (e) { return 'ERR ' + (e.message || '').slice(0, 80); }
}
fs.writeFileSync(path.join(PS_DIR, 'focus-click.ps1'), `
param([int]$ProcId)
Add-Type @"
using System;using System.Runtime.InteropServices;
public struct RECT{public int L,T,R,B;}
public class WC{
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
}
"@
Get-Process nvda -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.MainWindowHandle -ne 0) { [WC]::ShowWindow($_.MainWindowHandle,6) | Out-Null }
}
Start-Sleep -Milliseconds 400
$p=Get-Process -Id $ProcId -ErrorAction SilentlyContinue
if(-not $p -or $p.MainWindowHandle -eq 0){ Write-Output "NOWINDOW"; exit }
$h=$p.MainWindowHandle
[WC]::ShowWindow($h,9)|Out-Null
Start-Sleep -Milliseconds 400
[WC]::SetForegroundWindow($h)|Out-Null
Start-Sleep -Milliseconds 300
Start-Sleep -Milliseconds 300
$r=New-Object RECT
[WC]::GetWindowRect($h,[ref]$r)|Out-Null
$x=$r.L+180; $y=$r.T+150
[WC]::SetCursorPos($x,$y)|Out-Null
Start-Sleep -Milliseconds 150
[WC]::mouse_event(0x2,0,0,0,[IntPtr]::Zero);[WC]::mouse_event(0x4,0,0,0,[IntPtr]::Zero)
Write-Output ("foregrounded+clicked " + $x + "," + $y)
`);
fs.writeFileSync(path.join(PS_DIR, 'click-at.ps1'), `
param([int]$ProcId,[int]$OffX,[int]$OffY)
Add-Type @"
using System;using System.Runtime.InteropServices;
public struct RECT{public int L,T,R,B;}
public class CK{
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
}
"@
$p=Get-Process -Id $ProcId -ErrorAction SilentlyContinue
if(-not $p -or $p.MainWindowHandle -eq 0){ Write-Output "NOWINDOW"; exit }
$r=New-Object RECT
[CK]::GetWindowRect($p.MainWindowHandle,[ref]$r)|Out-Null
$x=$r.L+$OffX; $y=$r.T+$OffY
[CK]::SetCursorPos($x,$y)|Out-Null
Start-Sleep -Milliseconds 120
[CK]::mouse_event(0x2,0,0,0,[IntPtr]::Zero);[CK]::mouse_event(0x4,0,0,0,[IntPtr]::Zero)
Write-Output ("clicked " + $x + "," + $y)
`);

/** 關掉 guidepup NVDA 的語音檢視器（置頂視窗會攔截點擊） */
function disableSpeechViewer() {
  try {
    const out = cp.execSync('reg query "HKCU\\SOFTWARE\\Guidepup\\Nvda"', { encoding: 'utf8' });
    const m = out.match(/guidepup_nvda_\S+\s+REG_SZ\s+(.+)/);
    if (!m) return '登錄檔無 guidepup NVDA';
    const ini = path.join(m[1].trim(), 'userConfig', 'nvda.ini');
    if (!fs.existsSync(ini)) return 'nvda.ini 不存在';
    const txt = fs.readFileSync(ini, 'utf8');
    if (/showSpeechViewerAtStartup = True/.test(txt)) {
      fs.writeFileSync(ini, txt.replace('showSpeechViewerAtStartup = True', 'showSpeechViewerAtStartup = False'));
      return '已關閉語音檢視器';
    }
    return '語音檢視器已是關閉';
  } catch (e) { return 'ERR ' + e.message; }
}

/** 停點壓成一行 */
function stopToLine(s) {
  if (s.kind === 'text') {
    return [(s.text || ''), s.role !== '文字' ? '【' + s.role + '】' : '', s.position, s.description ? '（' + s.description + '）' : '']
      .filter(Boolean).join(' ');
  }
  const x = [s.name || (s.nameRequired ? '（無可朗讀名稱）' : ''), s.role];
  if (s.value) x.push(s.value);
  if (s.states && s.states.length) x.push(s.states.join(' '));
  if (s.position) x.push(s.position);
  if (s.itemCount) x.push(s.itemCount);
  if (s.description) x.push('（' + s.description + '）');
  return x.filter(Boolean).join(' ');
}

(async () => {
  if (!CHROME) throw new Error('找不到 Chrome');
  console.log('語音檢視器：', disableSpeechViewer());
  const server = http.createServer((req, res) => {
    const p = path.join(REPO, 'test', req.url === '/' ? FIXTURE : req.url.replace(/^\//, ''));
    fs.readFile(p, (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
  }).listen(PORT);

  // (A) 我們的模擬（headless）
  const bh = await puppeteer.launch({ executablePath: CHROME, headless: 'new', pipe: true });
  const ph = await bh.newPage();
  await ph.goto(URL, { waitUntil: 'load' });
  await ph.addScriptTag({ path: path.join(REPO, 'vendor/axe.min.js') });
  await ph.addScriptTag({ path: path.join(REPO, 'vendor/axe-locale-zh_TW.js') });
  await ph.addScriptTag({ path: path.join(REPO, 'content/scanner.js') });
  const ro = await ph.evaluate(() => window.__rampA11yReadingOrder());
  await bh.close();
  const ourLines = ro.stops.map((s) =>
    (s.kind === 'landmark' || s.kind === 'table' || s.kind === 'list') ? '〔' + s.text + '〕' : stopToLine(s));

  // (B) 真 NVDA
  try { cp.execSync('taskkill /IM nvda.exe /F', { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
  await sleep(800);
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: false, pipe: true, defaultViewport: null,
    // 拿掉 --enable-automation：避免產生「受自動化軟體控制」資訊列——
    // 有螢幕報讀軟體時 Chrome 會把焦點移到該資訊列播報，搶走頁面焦點
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-first-run', '--window-position=100,100', '--window-size=1000,800'],
  });
  const pg = (await b.pages())[0];
  await pg.goto(URL, { waitUntil: 'load' });
  console.log('NVDA 啟動中（Windows 可能彈出「設定」——會自動處理）…');
  await nvda.start();
  await sleep(2500);
  try { cp.execSync('taskkill /IM SystemSettings.exe /F', { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
  await sleep(600);
  // 焦點自癒：點進頁面 → 用「探測句」確認 NVDA 讀的是本頁（而非瀏覽器 UI／別的視窗），
  // 不像就重點擊再試（最多 4 次）。這是實測中最可靠的判準。
  const looksWrong = (p) => /工具列|網址與搜尋列|分頁搜尋|加入書籤|視窗$|設定/.test(p || '');
  let ready = false;
  for (let attempt = 1; attempt <= 4 && !ready; attempt++) {
    console.log(`焦點嘗試 ${attempt}：`, ps('focus-click.ps1', String(b.process().pid)));
    await sleep(700);
    await nvda.clearSpokenPhraseLog();
    await nvda.press('Control+Home');
    await sleep(800);
    await nvda.next();
    await sleep(700);
    const first = (await nvda.lastSpokenPhrase() || '').trim();
    console.log('  探測句：', first.slice(0, 50) || '（無）');
    if (first && !looksWrong(first)) ready = true;
  }
  // 瀏覽模式逐行走訪（真 NVDA 的線性化——與我們的朗讀順序直接對照）
  const phr = [];
  if (ready) {
    const first = (await nvda.lastSpokenPhrase() || '').trim();
    if (first) phr.push(first);
    let same = 0, prev = null;
    for (let i = 0; i < 40; i++) {
      await nvda.next();
      await sleep(600);
      const p = (await nvda.lastSpokenPhrase() || '').trim();
      if (p === prev) { if (++same >= 3) break; } else same = 0;
      prev = p;
      if (p && p !== phr[phr.length - 1]) phr.push(p);
    }
  }
  await nvda.stop();
  await b.close();
  server.close();
  try { fs.rmSync(PS_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

  console.log('\n頁面：' + FIXTURE);
  console.log('═'.repeat(80));
  console.log('真 NVDA 逐一 Tab 念出（' + phr.length + ' 句）：');
  phr.forEach((p, i) => console.log('  ' + String(i + 1).padStart(2) + '  ' + p));
  console.log('─'.repeat(80));
  console.log('我們的模擬（可聚焦物件）：');
  ourLines.forEach((l, i) => console.log('  ' + String(i + 1).padStart(2) + '  ' + l));
  console.log('═'.repeat(80));
  // 用頁面專屬詞判斷（瀏覽器 UI 也有「按鈕／編輯區」，不能拿來判斷）
  const ok = phr.some((p) => /台中|滑桿|功能表按鈕|導覽區|多行/.test(p));
  if (!ok) {
    console.log('⚠ 本輪 NVDA 讀到的是瀏覽器 UI 而非頁面控制項（Windows 焦點時序不穩定），');
    console.log('  直接重跑一次通常即可；成功時會逐一念出「城市, 下拉式方塊, 台中」等頁面控制項。');
  }
  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify({ phrases: phr, ourLines }, null, 2));
  console.log('（原始輸出已存 test/nvda/last-run.json）');
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
