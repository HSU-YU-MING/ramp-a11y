# Ramp（ramp-a11y）

網頁無障礙（Web Accessibility / a11y）檢測工具 —— Chrome / Edge 瀏覽器擴充套件（Manifest V3）。

掃描你目前瀏覽的網頁（JavaScript 執行後的實際 DOM），以開源檢測引擎 [axe-core](https://github.com/dequelabs/axe-core) 找出 WCAG 無障礙問題，並以**繁體中文**說明問題成因與修正方式，對應到**台灣「網站無障礙規範」**的準則編號與 A / AA / AAA 檢測等級。

## 功能

- 一鍵掃描當前分頁，依 **A / AA / AAA 等級分組**呈現違規項目，同組內依 axe 嚴重度（critical → minor）排序
- 頂部統計列：違規總數、各等級數量、最佳實務建議數、需人工複核數
- 每項問題提供繁中的「為什麼是障礙」與「如何修正」，並標示台灣規範準則編號、類別（可感知／可操作／可理解／強健）與影響程度
- 點擊受影響元素 → 在原網頁**高亮定位**並自動捲動過去（尊重使用者的減少動態效果設定）
- axe 判定為 incomplete 的項目標示為「**需人工複核**」
- 內建 axe 官方 **zh_TW 語言包**：未在對應表中的規則也以繁中顯示，僅標示「未對應台灣規範準則」
- axe 的**最佳實務建議**（非 WCAG 失敗項）獨立分組，不灌水「違規」數字
- **結果快取**：popup 關閉重開時，同一分頁、同一網址的上次結果會自動還原，不必重掃
- 受保護頁面（`chrome://`、擴充功能商店等）與掃描失敗有明確的繁中錯誤提示

## 權限說明

本擴充套件**不要求「所有網站」的常駐權限**，只使用：

- `activeTab`：使用者主動點擊圖示時，才臨時取得當前分頁的存取權
- `scripting`：注入 axe-core 與掃描腳本
- `storage`：以 session storage 快取掃描結果（關閉瀏覽器即清除，不落地、不外傳）

所有檢測都在你的瀏覽器本機完成，不傳送任何資料到外部伺服器。

## 安裝（載入未封裝項目 / Load unpacked）

1. 下載或 clone 本專案到本機資料夾。
2. 開啟 Chrome，網址列輸入 `chrome://extensions/`（Edge 為 `edge://extensions/`）。
3. 開啟右上角的「**開發人員模式**」。
4. 點擊「**載入未封裝項目**」（Load unpacked）。
5. 選擇本專案的資料夾（含 `manifest.json` 的那一層，即 `ramp-a11y/`）。
6. 工具列出現 Ramp 圖示後，開啟任一一般網頁，點擊圖示 →「開始檢測」。

## 測試素材頁

[test/fixture.html](test/fixture.html) 是一個**故意**塞滿已知違規的測試頁，覆蓋對應表中的每一條規則（缺 alt、低對比、無 label、重複 id⋯），可用來驗證檢測、翻譯與高亮定位都正常。

用瀏覽器直接開啟該檔案（`file://`）測試前，需在 `chrome://extensions/` 的 Ramp 詳細資料頁開啟「**允許存取檔案網址**」；或用任一本機伺服器（如 `npx serve test`）以 http 開啟。

## 功能截圖

> （截圖佔位：初始畫面）
>
> （截圖佔位：檢測結果面板 — 依等級分組與統計列）
>
> （截圖佔位：點擊元素後在頁面上高亮定位）

## 專案結構

```
ramp-a11y/
├── manifest.json            # MV3 設定：權限、popup、圖示
├── popup/                   # 介面（四種狀態：初始／載入中／結果／錯誤）
├── content/scanner.js       # 注入頁面的掃描與高亮函式
├── background/service-worker.js  # 極簡背景腳本（保留擴充彈性）
├── data/rules-map.json      # axe 規則 → 台灣「網站無障礙規範」對應表
├── vendor/
│   ├── axe.min.js           # 本地打包的 axe-core（MV3 CSP 不允許遠端載入）
│   └── axe-locale-zh_TW.js  # axe 官方 zh_TW 語言包（包裝為可注入的 JS）
├── test/fixture.html        # 故意違規的測試素材頁
└── icons/                   # 擴充套件圖示（佔位圖）
```

## vendor 檔案的取得與更新

兩個 vendor 檔案皆來自 npm 套件 `axe-core@4.10.3`，更新版本時重跑以下步驟並校對 `rules-map.json`：

```sh
# 1. 檢測引擎本體
curl -sL -o vendor/axe.min.js https://cdn.jsdelivr.net/npm/axe-core@4.10.3/axe.min.js

# 2. 官方 zh_TW 語言包，包裝成注入用 JS（在 axe.min.js 之後注入）
curl -sL -o /tmp/zh_TW.json https://cdn.jsdelivr.net/npm/axe-core@4.10.3/locales/zh_TW.json
{ printf 'if (window.axe) {\n  window.axe.configure({\n    locale: '; cat /tmp/zh_TW.json; printf '\n  });\n}\n'; } > vendor/axe-locale-zh_TW.js
```

## 限制聲明（重要）

- **自動化檢測僅能涵蓋約三到四成的無障礙問題。** 鍵盤操作動線、報讀軟體實際體驗、內容語意是否恰當等，仍必須以人工方式複核。
- 本工具的檢測結果**不等同**於任何官方無障礙標章或認證（如 NCC「無障礙網路空間服務網」的標章檢測）；如需申請標章，請依官方流程送測。
- 「需人工複核」項目代表 axe 無法自動判定，不代表沒有問題。
- 跨來源 iframe 內的內容目前不在掃描範圍內（MVP 限制）。
- 對應表目前收錄 16 條常見規則的台灣準則對應與策展解說；其餘規則經 axe zh_TW 語言包以繁中顯示，但未對應台灣準則編號。
- axe 預設包含部分 WCAG 2.2 新規則，觸發時會列在「未對應台灣準則」區（台灣現行規範對齊 WCAG 2.1 的 78 條準則）。
- 台灣規範仍沿用 WCAG 4.1.1（剖析），因此本工具明確重新啟用 axe 4.10 已預設停用的 `duplicate-id` 規則。
- 準則 2.4.7「焦點可見」沒有對應的 axe 自動化規則，鍵盤焦點是否明顯**一律需要人工檢測**（對應表保留該條目作為規範文件用途）。

## 授權與致謝

- 檢測引擎：[axe-core](https://github.com/dequelabs/axe-core) **v4.10.3**（MPL-2.0），以本地檔案形式打包於 `vendor/axe.min.js`。升級 axe 版本時請一併校對 `data/rules-map.json` 的規則異動。
