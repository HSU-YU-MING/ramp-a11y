# Ramp（ramp-a11y）開發指南

網頁無障礙檢測 Chrome / Edge 擴充套件（MV3），以 axe-core 掃描並轉譯成台灣「網站無障礙
規範」，附 NVDA 報讀預覽。功能、安裝、測試指令、e2e 疑難排解、發版步驟、規範版本對照、
路線圖都在 [README.md](README.md)（中）／[README.en.md](README.en.md)（英）——那是使用者
與貢獻者文件，**這份只寫 README 沒有、但動手前必須知道的事**。

**已上架 Chrome 線上應用程式商店**，擴充功能 ID `bbdbehdknkmhpbolgohjlmikbfganhfm`。
線上有真實使用者，任何破壞相容性的改動都會透過商店更新推出去。

## 一個 repo，兩個獨立成品

這件事最容易搞錯，因為 `package.json` 的 `name` **不是擴充套件**：

| 成品 | 版本真相源 | 發佈方式 |
|---|---|---|
| 擴充套件 `Ramp 無障礙檢測` | `manifest.json` 的 `version` | `npm run pack` 產 zip → **人工上傳商店** |
| CLI `cornhsu-ramp-scan`（npm） | `package.json` 的 `version` | 推 `v*` tag → `release.yml` 自動發佈 |

兩者版本號**刻意保持一致**，有測試守門。`npm run release:prep -- 1.2.0` 會一次寫進
`package.json` / `package-lock.json` / `manifest.json` 三處（Chrome 商店讀 zip 內的
manifest，必填且必須高於線上版，沒辦法從 tag 推導）。**`release:prep` 刻意不 commit、
不打 tag、不 push**——發版有後果，最後那一下要人自己按。

商店上架**沒有自動化**（沒有 CWS API 憑證、沒有 OAuth client）。`release.yml` 檔頭已寫明
它只發 npm 套件。

## 安全基準線（2026-08-23 稽核結論，這些是刻意的設計）

擴充套件對使用者的承諾是「全部在本機完成、不外傳任何資料」。這件事被寫進了程式碼的形狀，
**加功能時不要破壞任何一條**：

1. **權限最小化：只有 `activeTab` / `scripting` / `storage`，`manifest.json` 裡
   完全沒有 `host_permissions` 欄位。** 不要為了方便加 `host_permissions`——
   一旦加了，商店審查與使用者信任的成本完全不同，而且會讓「只在使用者主動點擊時才取得
   分頁存取權」這個核心賣點消失。
2. **也沒有 `content_scripts`。** 一切靠 popup 用 `chrome.scripting.executeScript` 動態
   注入，這正是不需要 `<all_urls>` 就能運作的原因。不要為了省事改成宣告式注入。
3. **axe-core 是本地打包，沒有遠端程式碼。** `vendor/axe.min.js` + `vendor/axe-locale-zh_TW.js`
   都在 repo 裡（v4.10.3，MPL-2.0）。**不要從 CDN 載 script**——MV3 的 CSP 本來就不允許，
   而且遠端程式碼會直接被商店審查退件。
4. **擴充套件端沒有任何對外網路請求。** 非 vendor 程式碼裡唯一的 `fetch()` 在
   `popup/popup.js`，讀的是 `chrome.runtime.getURL('data/rules-map.json')`，
   也就是自己打包的本地檔案。不要把頁面內容送到任何外部端點（含「匿名的統計」）。
5. **頁面來源的資料進 innerHTML 前一律 `escapeHtml()`。** 唯一定義在
   `shared/report-core.js`，popup 與 CLI 都從那裡取用（**不要各自再寫一份**）。
   有專屬迴歸測試：`test/xss-fixture.html` + e2e 的 F 組。**任何新的
   「把頁面文字塞進 HTML 樣板」的地方都要走它**——這是結構性防呆，不是一次性修補。

儲存的內容也在這個承諾裡：`storage.local` 只有偏好設定（`prefs`）與人工複核自評
（`review::<url>`），`storage.session` 只有掃描結果快取（`scan_<tabId>`，關瀏覽器即清）。
`minimum_chrome_version: 102` 就是 `storage.session` 的需求，不要隨手降。

CLI（`cli/ramp-scan.js`）**當然會對使用者指定的目標網站送真實請求**——那是它的工作，
`SECURITY.md` 已把它列為明確的設計邊界。預設循序、每頁間隔 250ms，別把預設值調快。

## 注入的三個地雷

- **注入順序不可調換**：`vendor/axe.min.js` → `vendor/axe-locale-zh_TW.js` →
  `content/scanner.js`。三者共用同一個 isolated world，後兩者都依賴 `window.axe`。
- **`activeTab` 的授權只有真人點工具列圖示才核發。** `chrome.action.openPopup()`
  這種程式化開啟**不算使用者手勢**，Chrome 不給授權——這就是 e2e 必須複製一份加了
  `<all_urls>` 的暫存 manifest 才能跑的原因。真正的 activeTab 授權路徑**只能人工驗證**。
- `content/scanner.js` 依賴 `axe.commons` 計算 accessible name，而 **`axe.run` 之後
  必須重新 `axe.setup()` 重建虛擬 DOM 樹**才能用。動報讀預覽相關程式碼前先確認這點。
- popup 有防重複注入的探測（先看 `window.axe` 在不在才注入），`scanner.js` 開頭也有
  `if (window.__rampA11yScan) return;`。**別把這兩個優化當成冗餘刪掉**——550KB 的
  axe.min.js 每次切分頁都重跑一次是很有感的。

## 其他地雷

### `popup.css` 的 `[hidden]` 一定要 `!important`

四個 view 靠 `hidden` 屬性切換。瀏覽器預設的 `[hidden]{display:none}` 會被 `.view-center`
之類的 display 宣告蓋掉，結果是**四種狀態同時顯示**。這個 bug 在 `c7de72f` 修過一次。

`popup.html` 底部兩支 script 順序也不能反：`shared/report-core.js` 必須在 `popup.js` 之前，
`popup.js` 直接解構 `window.RampShared`。

### 中文樣板字串裡的全形空白（U+3000）是刻意的

那是排版間隔，不是誤植。`eslint.config.js` 為此把 `no-irregular-whitespace` 設成
`{ skipTemplates: true, skipStrings: true }`。**不要把全形空白改成半形**，也不要「順手」
把那條規則收緊。

### 受保護頁面的判定是硬編碼的

`popup.js` 的 `isRestrictedUrl()` 硬列了 scheme 清單（`chrome://`、`edge://`、`about:`…）
與 host 清單（`chromewebstore.google.com` 等）。另外還有一段**用正規表示式比對 Chrome 的
英文錯誤訊息**再轉成友善繁中——**Chrome 改文案就會失效**。Chrome 大改版後若使用者回報
「錯誤訊息變成英文原文」，先看這裡。

### `pack.js` 的檔案白名單有兩份

`scripts/pack.js` 的 `INCLUDE` 陣列與 `test/e2e/run-e2e.js` 的 `buildTestExtension`
是**同一份清單抄兩處**。**新增頂層目錄時兩處都要加**，否則上架版缺檔而本機開發完全正常。

### `test:docs` 會因為你改了別的東西而紅燈

README 裡有一批「機器算得出來、但人手寫」的數字（各測試套件的項數、對應表的規則總數與
準則涵蓋數、標檢測碼的規則數、axe 版本）。`test/docs/readme-claims.js` 會拿真正的來源
比對它們。所以：

- **改了 `data/rules-map.json` 的筆數 → 兩份 README 的數字都要同步改。**
- **加/減一個測試案例 → 兩份 README 的項數都要同步改。**
- 升級 axe 版本 → `vendor/axe.min.js` 內嵌的 `axe.version` 是真相源，
  `shared/report-core.js` 的 `AXE_VERSION`、兩份 README、`THIRD-PARTY-NOTICES.md` 全要跟上，
  而且要**逐條校對 `data/rules-map.json` 的規則異動**。

這支測試會被 `run-e2e.js` require（取 `assertE2eCount`），所以**它載入時不得有副作用**，
所有檢查都必須包在 `main()` 裡——否則跑 e2e 會連帶重跑三支單元測試。

### lint 是 `--max-warnings 0`

warning 也會擋 CI。flat config 把環境分成四類（擴充端 / Node 端 / Node+瀏覽器 / shared UMD），
globals 各不相同；Node 端**刻意不含瀏覽器全域**，好讓 scripts 誤用 `document`/`window` 被抓出來。

### `npm test` 是 e2e，不是單元測試

要快速迭代用 `npm run test:unit`（jsdom，秒級）。e2e 以 **`headless: false` 開真實視窗**，
需要 Chrome 137+（`--load-extension` 已被移除，改用 Puppeteer 的 `installExtension`）。
CI 那邊靠 xvfb + `--no-sandbox`（**只在 `process.env.CI` 為真時附加**，本機維持沙箱）。

`npm run test:nvda` 會真的把 NVDA 叫起來出聲，需要互動桌面，**不進 CI**。
`test/nvda/compare.js` 的檔頭寫著「實測踩雷後的成果，勿隨意簡化」，四個坑（NVDA 啟動時
Windows 設定頁搶焦點、語音檢視器置頂擋點擊、必須用 OS 層合成點擊才轉移鍵盤焦點、
Tab 必須用 `nvda.press()` 而非 CDP 合成鍵盤）都是真的踩過的——照做，不要簡化。

## 從 git log 挖到的教訓

### e2e 紅燈先懷疑環境，不要先改測試（`547e8d0`，2026-08-11）

CI 的 e2e 突然紅，`page.goto` 丟 `Navigating frame was detached`。**程式碼一個月沒動，
壞的是環境**——lockfile 把 `puppeteer-core` 釘在 7 月的版本，CI 的 `setup-chrome` 卻一直
抓最新 stable。當時試著改測試寫法，錯誤只是從一種換成另一種：

| 改法 | 新的錯誤 |
|---|---|
| `(await browser.pages())[0]` 後 goto | `Navigating frame was detached` |
| 改開 `newPage()` 並列舉 `pages()` 清理 | `Tab target session is not defined` |
| 不列舉、只用 `newPage()` | `Attempted to use detached Frame` |

三個訊息不同，都是同一件事：舊 puppeteer 認不得新 Chrome 的 target 結構。**最後把
`run-e2e.js` 還原成原本的寫法，只升依賴。** 下次 e2e 在沒改程式碼的情況下變紅，
第一件事是看 puppeteer-core 與 Chrome stable 的版本差距。

### e2e 的 flakiness 靠設計解決，不靠 sleep（`b323876`、`1aebe8a`、`82de081`）

- 匯出報告的下載測試曾**約 1/3 機率不落地**，固定或輪詢 sleep 都救不了（下載根本沒觸發）。
  改成 hook `URL.createObjectURL` 直接擷取報告 HTML 驗證內容——仍走真實的
  `exportReport → buildReportHtml → blob` 路徑，但不依賴 OS 下載，變確定性。
  **看到 flaky 測試想加 sleep 時，先想能不能換一個確定性的觀測點。**
- 原本 T1–T19 在單一 try 裡循序跑，**任一測試丟例外就跳 finally、後面全部不跑**。
  改成 `runStep(name, fn)` 分成 7 個自帶頁面/popup 的獨立組，並加 `closeStalePopups`。
- `headless: false` 下 **popup 失焦會 detach**，所以每組開 popup 前要 `bringToFront()`。

### 「宣稱有但實際沒作用」的選項比沒有還糟（`a822237`）

CLI 的 `--level` 一度是 no-op 卻在說明裡宣稱會過濾，是獨立審查抓出來的。同一批還修了：
`page.evaluate` 沒有逾時（掃描卡住會拖死整個爬蟲，改用 `withTimeout`）、CSV 表頭含空白
（`source_url, lang`）導致**逐語言功能靜默失效**（改為逐格 trim）。
**「靜默失效」是這個專案反覆出現的失敗模式**——加選項時想一下它壞掉的時候會不會出聲。

### `npm audit fix` 不動就用 `overrides`（`ed23f5b`）

`js-yaml` / `brace-expansion` 的 high 警示都在 eslint 底下的 dev 相依，
`npm audit --omit=dev` 是乾淨的，`js-yaml` 的實際暴露面甚至是零（flat config 不會載
`.eslintrc.yaml`）。但 `npm audit fix` 與 `npm update` 都判定「up to date」不肯動，
最後用 `package.json` 的 `overrides` 精準指定修補版。下次遇到同樣情況照這條路走，
並在 commit 裡寫清楚實際暴露面。

## 時限性待辦（有硬期限）

**2026-11-30 是台灣「網站無障礙規範」115 年修正版的生效日**，當天要發 v1.2.0 做版本切換：

- 移除 `content/scanner.js` 中 `duplicate-id` 的重新啟用（新版已刪除準則 4.1.1）
- 退役 `data/rules-map.json` 裡的 `duplicate-id` 條目
- 清掉 4.1.1 與 2.5.8 條目的過渡期附註（`noteZh`）
- 兩份 README 的標準版本對照表改以 115 年修正版為現行版

改動會連帶讓 `test:docs` 的規則總數守門紅燈，那是預期內的，一起改數字。

## 技術債留帳

- **e2e 只做到「分組隔離」，沒有每案例隔離。** `1aebe8a` 的 commit 明講這是「便宜版隔離」，
  真正的每案例完全隔離是更大的重寫，**暫緩**。前一組留下的殘留 popup 靠 `closeStalePopups`
  清，不是根治。
- **商店上架是手動的**，`npm run pack` 之後要人去後台上傳、等審查（`SECURITY.md` 已把
  「審查通常數日、無法保證」列為安全揭露的落差期）。這是刻意接受的，不是待辦。
- **`vendor/` 沒有自動同步腳本**，只有 README〈vendor 檔案的取得與更新〉裡的手動 curl 指令。
- `.claude/settings.local.json` 裡的 46 條 allow 規則路徑**全是舊的 `D:\ramp-a11y\`**，
  專案搬到 `D:\擴充功能\chrome擴充\ramp-a11y` 之後就對不上了，等於失效。`.claude/` 已被
  gitignore，影響只在本機——想清就清。

## 現況與文件不符之處

`D:\網站\portfolio\doc\ramp-a11y.md`（作品集上的專案文件）是 **repo README 的舊副本**，
停在 2026-07-23 之前：完全沒提到 `cli/`（`cornhsu-ramp-scan` 一次都沒出現），測試清單
少了 `test:self` / `test:cli` / `test:docs`、項數也是舊的，路線圖還把「全站爬掃 CLI」寫成
未完成、把規範切換版本寫成 v1.1.0（README 現在是 v1.2.0，因為 v1.1.0 已經拿去上架了）。
**這個 repo 這邊是對的**；要修的是作品集那份（走 `portfolio-release-update` 的流程）。

## 開工慣例

- 快速迴圈：`npm run lint && npm run test:unit && npm run test:self`（秒級，不需 Chrome）。
- 動到 `content/scanner.js` 或 `popup/popup.js` 的渲染路徑 → 一定要跑 `npm test`（e2e）。
- 動到 `data/rules-map.json`、測試項數、axe 版本 → 一定要跑 `npm run test:docs`。
- 動到 NVDA 報讀用詞 → 用詞的真相源是 **NVDA 官方正體中文翻譯（`zh_TW`）**，不是自己覺得
  順口的講法。過去六個落差都是真 NVDA 對照才抓出來的，改用詞前先跑 `npm run test:nvda`。
- 這個專案**不用 TODO/FIXME 註解**（全專案 0 個），技術債寫在 commit message 裡並明說
  「暫緩」的理由。沿用這個習慣。
- 收尾：改到功能面 → **兩份 README 都要同步**（中文那份詳盡、英文那份精簡，別只改一邊）。
