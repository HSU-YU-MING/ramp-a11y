/**
 * background/service-worker.js
 * MVP 階段刻意保持極簡：所有掃描與高亮邏輯都由 popup 直接以
 * chrome.scripting.executeScript 注入執行，不需要長駐背景邏輯。
 *
 * 保留此檔案作為未來擴充點，例如：
 *  - 快捷鍵觸發掃描（chrome.commands）
 *  - 跨分頁的掃描結果快取
 *  - 匯出報告、排程批次掃描
 */
chrome.runtime.onInstalled.addListener(() => {
  // 目前無需初始化動作
});
