/**
 * 產生 Chrome Web Store 上架用 zip
 * 用法：npm run pack → 輸出 dist/ramp-a11y-v{版本}.zip
 * 只收錄擴充套件執行所需檔案（manifest 位於 zip 根層），
 * 排除測試、文件、開發相依等所有非必要內容。
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');

// 與 test/e2e/run-e2e.js 的 buildTestExtension 同一份清單（上架版不改 manifest）
const INCLUDE = ['manifest.json', 'popup', 'content', 'background', 'data', 'vendor', 'icons'];

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
fs.mkdirSync(DIST, { recursive: true });

const zip = new AdmZip();
for (const item of INCLUDE) {
  const full = path.join(REPO, item);
  if (fs.statSync(full).isDirectory()) zip.addLocalFolder(full, item);
  else zip.addLocalFile(full);
}

const out = path.join(DIST, `ramp-a11y-v${manifest.version}.zip`);
zip.writeZip(out);

const size = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`已產生 ${out}（${size} KB）`);
console.log('內容物：');
new AdmZip(out).getEntries().forEach((e) => {
  if (!e.isDirectory) console.log('  ' + e.entryName);
});
