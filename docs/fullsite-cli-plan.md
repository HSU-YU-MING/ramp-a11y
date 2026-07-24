# 全站爬掃 CLI — 架構與範圍規劃

> 狀態：**M1–M2 已實作**（單頁＋同源 BFS 爬蟲＋逐頁/全站彙整 JSON＋PolyMigrate `--url-list`
> 橋接與逐語言報告）；M3（HTML 報告）、M4（抽共用模組）待做。　｜　建立：2026-07-23　｜
> 對應路線圖：README「待辦與路線圖」第三階段　｜　程式：[cli/ramp-scan.js](../cli/ramp-scan.js)

## 1. 定位
一支**本機 Node CLI**：給一個起始網址，爬同源頁面，對每頁跑**與擴充套件完全相同**的
Ramp 掃描與台灣規範轉譯，彙整成一份全站無障礙報告。**零基礎設施、零金流**（本機執行）。

工作代號暫定 `ramp-scan`。

## 2. 命令介面

```
npx ramp-scan <start-url> [options]

爬取控制
  --depth <n>         爬取深度（預設 2）
  --max-pages <n>     頁數上限（預設 50，安全閥）
  --include <regex>   只爬符合的 URL
  --exclude <regex>   跳過符合的 URL（登出、下載連結…）
  --sitemap           改從 sitemap.xml 取頁面清單（可選）

執行
  --concurrency <n>   同時掃描頁數（預設 1＝循序，禮貌；提高可加速）
  --delay <ms>        每次請求間隔（預設 0）
  --chrome <path>     指定 Chrome（等同 CHROME_PATH）

輸出
  --level <A|AA|AAA>  目標等級（預設 AA）
  --out <dir>         報告輸出目錄（預設 ./ramp-report）
  --format html|json|both（預設 both）
```

## 3. 管線架構（4 階段）

```
起始 URL
   │
   ▼
[1] Frontier 佇列 ── BFS、同源、深度/頁數上限、include/exclude、URL 正規化去重
   │  （每頁渲染後蒐集 <a href> 回饋佇列）
   ▼
[2] 每頁掃描 ── 復用 live-scan 原型：goto → 注入 axe+scanner → __rampA11yScan()
   │  （headless 渲染以算對比；逐頁 timeout；單頁失敗記錄後續跑，不中斷全站）
   ▼
[3] 彙整 ── 跨頁合併：全站各規則總數、依等級、最嚴重頁面、需人工複核總數、覆蓋頁數
   │
   ▼
[4] 報告 ── HTML（復用 popup 匯出版型）＋ JSON（機器可讀）
```

## 4. 程式碼復用地圖（ROI 最高的原因）

| 需要的能力 | 現成來源 | 復用程度 |
|---|---|---|
| Chrome 啟動／findChrome | `test/e2e/run-e2e.js` | 幾乎照搬 |
| axe＋scanner 注入、`__rampA11yScan()` | 已有單頁原型（live-scan） | 直接是 M1 |
| rules-map 轉譯（規則→台灣準則） | `popup.js` 的 `translateRule()` | 需抽出共用 |
| HTML 報告版型 | `popup.js` 的匯出報告產生器 | 需抽出共用 |
| 規則對應資料 | `data/rules-map.json` | 原封不動共用 |

**關鍵架構決策**：把 `translateRule()` 與報告版型抽成一個純函式共用模組（無 chrome／DOM
依賴），讓擴充套件與 CLI 共用同一份真理來源，避免日後兩邊漂移。這是唯一需動到現有程式的
地方（低風險重構，有測試保護）。

## 5. 關鍵設計決策

| 議題 | 決策 |
|---|---|
| 爬取策略 | BFS；預設同源；深度＋頁數雙上限 |
| URL 去重 | 正規化（去 fragment、統一結尾斜線）後放 Set |
| 非 HTML | 依副檔名＋content-type 跳過 pdf/圖片/下載 |
| 禮貌性 | concurrency 上限、可選 delay、可選遵守 robots.txt、自訂 UA 標明是掃描器 |
| 登入頁 | v1 不做（CLI 無使用者瀏覽器 session）；預留 `--storage-state` 吃登入狀態檔當 v1.1 |
| 容錯 | 逐頁 timeout；單頁失敗記為「掃描失敗頁」，全站繼續 |
| 渲染 | headless new（會渲染 → 對比可算），與擴充套件一致 |

## 6. 報告內容

- **全站摘要**：掃描頁數、違規總數、依等級分佈、各規則排行、問題最多頁面 Top N、需人工複核總數。
- **逐頁明細**：每頁 URL、該頁各規則 findings（含台灣準則對應）、代表元素。
- **格式**：HTML（沿用擴充套件報告樣式）＋ JSON（給 CI／後續分析）。

## 7. 範圍界線

**v1 要做**：同源 BFS 爬取、深度/頁數上限、逐頁 axe＋台灣對應、彙整 HTML＋JSON 報告、容錯續跑。
**v1 不做（明確排除）**：登入後爬取、跨來源、JS 路由連結探索（只抓 `<a href>`）、排程、任何 hosting。

## 8. 里程碑

| M | 內容 | 狀態 |
|---|---|---|
| M1 | 單 URL CLI ＋ 參數 ＋ JSON 輸出 | ✅ 已完成 |
| M2 | Frontier 爬蟲（BFS、去重、上限、同源、容錯）＋全站彙整 JSON ＋ `--url-list` PolyMigrate 橋接與逐語言報告 | ✅ 已完成 |
| M3 | HTML 報告（復用擴充套件匯出版型渲染 site/page JSON） | ✅ 已完成 |
| M4 | 抽共用模組（shared/report-core.js）、擴充套件與 CLI 皆改用、加測試、README | ✅ 已完成 |

> M2 一併完成了原列於 M3 的「彙整」（siteSummary＋topRules＋worstPages＋byLanguage JSON）。
> M3 加上 `--format json｜html｜both`：HTML 沿用擴充套件匯出報告的配色與 .issue/.badge/.stats
> 樣式，全站版含執行摘要表、逐語言彙整表、最常見障礙（去重、每規則含修正建議與 NVDA 預覽
> 詳列一次）、最糟頁面、逐頁 `<details>` 明細；單頁版沿用 M1 結構。
>
> **後續加入**：`--concurrency`（預設 1 循序、向後相容）——清單模式用可測的 `mapPool`（結果依序）；
> 爬蟲模式用動態池（started/active 協調並行結束時機，精確封頂 maxPages）。提高並行加速但降低禮貌性。
>
> M4 把真正相同的核心抽成 [shared/report-core.js](../shared/report-core.js)（UMD，供瀏覽器
> `<script>` 與 Node `require` 共用）：`resolveMapping`（規則→台灣準則對應）、`escapeHtml`、
> `nvdaParts`。擴充套件 popup 與 CLI 皆改用之，消除各持一份的漂移風險；報告「版型」因兩者
> 本質不同（互動單頁 vs 靜態全站）而各自保留。新增 CLI 純函式測試（test:cli，20 項）與共用
> 模組測試（併入 test:unit），並把 shared/ 一併納入打包（pack.js）與 e2e 測試副本清單。

## 9. 風險與因應

| 風險 | 因應 |
|---|---|
| 共用邏輯漂移（CLI 與擴充套件各一份） | M4 抽共用純函式模組，兩邊 import 同一份 |
| 掃別人網站的禮貌／法務 | 預設保守 concurrency、標明 UA、可選 robots；README 加使用倫理聲明 |
| 大型網站爆量 | 頁數上限預設 50、串流寫報告 |
| 擴充套件是 vanilla JS（`<script>` 載入，非 module） | 共用模組設計成純資料＋純函式、兩種載入方式都吃，或加輕量 build；M4 先做技術驗證 |
