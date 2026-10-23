/**
 * 擴充套件執行所需的頂層檔案／目錄清單——唯一真相源。
 *
 * 消費端：
 *   - scripts/pack.js            上架 zip 的內容物
 *   - test/e2e/run-e2e.js        e2e 暫存副本（加 <all_urls> 的測試版 manifest）
 *
 * 過去這份清單抄在兩處，新增頂層目錄時漏改一邊的結果是「上架版缺檔而本機開發
 * 完全正常」（CLAUDE.md 點名的地雷）。抽成共用模組後兩邊不可能再漂移。
 */
'use strict';

module.exports = [
  'manifest.json',
  'popup',
  'content',
  'background',
  'data',
  'vendor',
  'icons',
  'shared',
];
