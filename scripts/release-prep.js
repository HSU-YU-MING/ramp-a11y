#!/usr/bin/env node
/**
 * release-prep — 發版前把版本號一次寫到所有該寫的地方
 *
 *   npm run release:prep -- 1.2.0
 *
 * 為什麼需要這支：版本號有三個地方要一致，而且**沒得減少**——
 *   package.json      npm 發佈用（release.yml 會比對 tag 與它是否相同）
 *   package-lock.json npm ci 要對得上
 *   manifest.json     Chrome 線上應用程式商店讀的是 zip 內這個欄位，必填、
 *                     且上傳版本必須高於線上版，無法改由 tag 推導
 *
 * 既然三處不能砍，就讓「你手輸版本號」這件事只發生一次。tag 仍然是發版的
 * 觸發器與最終真相源，這支只負責讓其他三個檔案先對齊，免得推了 tag 才被
 * release.yml 擋下、還得刪 tag 重打。
 *
 * 刻意不做的事：不 commit、不打 tag、不 push。發版是有後果的動作，最後那
 * 一下要人自己按——這支只把「容易打錯字」的部分做掉。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MANIFEST = path.join(REPO, 'manifest.json');
const PKG = path.join(REPO, 'package.json');
const LOCK = path.join(REPO, 'package-lock.json');

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const target = process.argv[2];
if (!target) {
  die('請指定版本號，例如：npm run release:prep -- 1.2.0');
}

// 只收 X.Y.Z：Chrome manifest 的 version 不接受 semver 的預發布標記（1.2.0-beta.1），
// npm 則不接受 Chrome 允許的四段式以外的怪格式。三段純數字是兩邊都吃的交集。
if (!/^\d+\.\d+\.\d+$/.test(target)) {
  die(
    `版本號格式須為 X.Y.Z（收到「${target}」）。\n` +
      '  Chrome manifest 不接受預發布標記（-beta、-rc），所以這裡也不放行。',
  );
}

const current = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;

/** 逐段數字比大小，回傳 a - b 的正負。 */
function cmp(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

if (cmp(target, current) <= 0) {
  die(
    `新版本 ${target} 沒有大於目前的 ${current}。\n` +
      '  Chrome 線上應用程式商店會拒絕版本號沒有變高的上傳，退版請走「發新版蓋掉」而不是降號。',
  );
}

console.log(`版本 ${current} → ${target}`);

// package.json 與 package-lock.json 交給 npm 自己寫，格式與欄位它最清楚
// （package-lock.json 尤其不能自己 JSON.stringify 重寫——往返會掉掉 npm 的原始
// 排版，產生數千字元的假 diff）。
// --no-git-tag-version：不要 commit、不要打 tag（見檔頭：最後一下留給人按）。
//
// shell: true 是 Windows 需要的——npm 在那裡是 npm.cmd，而 Node 20 起不允許
// 不帶 shell 直接 spawn .cmd（回 EINVAL）。整句當成單一命令字串傳、不另給 args
// 陣列，是為了避開 DEP0190 警告（shell 模式下 args 不會被逸出）。
// target 已經過 ^\d+\.\d+\.\d+$ 驗證，不可能夾帶 shell 語法。
const r = spawnSync(`npm version ${target} --no-git-tag-version`, {
  cwd: REPO,
  encoding: 'utf8',
  stdio: 'pipe',
  shell: true,
});
if (r.status !== 0) {
  die(
    `npm version 失敗（結束碼 ${r.status}）：\n${(r.stderr || r.stdout || '').trim() || '(無輸出)'}`,
  );
}
console.log('  ✓ package.json、package-lock.json');

// manifest.json 用字串取代而非 JSON.stringify，避免重排欄位順序與縮排
// （這個檔案人也要讀，diff 應該只有一行）。
const manifestSrc = fs.readFileSync(MANIFEST, 'utf8');
const VERSION_FIELD = /("version"\s*:\s*")[^"]+(")/;
if (!VERSION_FIELD.test(manifestSrc)) {
  die('manifest.json 裡找不到 version 欄位，請手動檢查');
}
fs.writeFileSync(MANIFEST, manifestSrc.replace(VERSION_FIELD, `$1${target}$2`));
console.log('  ✓ manifest.json');

// 寫完再讀一次確認三處真的一致——這支腳本存在的唯一理由就是不讓它們分岔，
// 所以不能只相信自己有寫成功。
const after = {
  'package.json': JSON.parse(fs.readFileSync(PKG, 'utf8')).version,
  'package-lock.json': JSON.parse(fs.readFileSync(LOCK, 'utf8')).version,
  'manifest.json': JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version,
};
const bad = Object.entries(after).filter(([, v]) => v !== target);
if (bad.length) {
  die(`寫入後仍不一致：${bad.map(([f, v]) => `${f}=${v}`).join('、')}`);
}

console.log(`
三處版本已對齊 ${target}。接下來（請自行確認後執行）：

  npm run lint && npm run test:unit && npm run test:self && npm run test:cli && npm run test:docs
  git add -A && git commit -m "chore(release): v${target}"
  git tag v${target} && git push && git push origin v${target}

推 v${target} 這個 tag 會觸發 release.yml 自動發佈 npm 套件。
擴充套件另走 npm run pack 產生 dist/ramp-a11y-v${target}.zip，再上傳到商店。`);
