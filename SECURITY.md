# 安全性政策 ／ Security Policy

## 支援範圍 ／ Scope

本政策涵蓋 Chrome／Edge 擴充套件 **Ramp**、npm 套件 **cornhsu-ramp-scan**，
以及本 repo 的原始碼。**僅維護最新版本**，不回補舊版。

Covers the Ramp browser extension, the `cornhsu-ramp-scan` npm package, and this
repository's source. **Only the latest released version is maintained.**

## 非目標 ／ Not a security tool

Ramp 是**無障礙**檢測工具。它的報告不是、也不應被當作安全性評估、弱點掃描
或合規佐證。「未發現違規」只代表 axe-core 沒有自動偵測到無障礙問題。

Ramp is an **accessibility** scanner. Its reports are not a security assessment
and must not be presented as one.

## 回報方式 ／ Reporting

請**不要**開公開 issue。改用 GitHub 的私密回報：
[Security → Report a vulnerability](https://github.com/HSU-YU-MING/ramp-a11y/security/advisories/new)。

Please do **not** open a public issue. Use GitHub private vulnerability
reporting: [Security → Report a vulnerability](https://github.com/HSU-YU-MING/ramp-a11y/security/advisories/new).

本專案由一人維護，盡力而為：

- 收到後 **14 天內**回覆確認
- 確認成立後，修補與發佈依通道而定——npm 套件通常數小時內可發出新版；
  瀏覽器擴充套件需經 Chrome 線上應用程式商店審查，**通常數日、無法保證**。
  若漏洞影響擴充套件，這段落差期請預期存在。

Maintained by one person, best effort: acknowledgement within **14 days**.
Fixes ship to npm within hours; extension fixes must clear Chrome Web Store
review, which typically takes days and cannot be guaranteed.

## 已知的設計邊界（非漏洞）／ Known by-design boundaries

以下是刻意的設計，回報前請先確認不屬於這幾項：

- 擴充套件只要求 `activeTab`／`scripting`／`storage`，掃描全在本機完成，
  不傳送任何資料到外部伺服器；結果存在 session storage，關閉瀏覽器即清除。
- CLI（`ramp-scan`）會**對你指定的網站送出實際 HTTP 請求**。掃描對象的授權
  由使用者自負，見 README 的〈使用倫理〉。
- 產出的 HTML 報告會包含目標頁面的字串片段（元素選擇器、文字內容）。這些
  內容一律經 `escapeHtml` 逸出；若你找到可繞過的情形，那正是我們要收的回報。
- 檢測引擎 axe-core 以本地檔案打包於 `vendor/`（MV3 CSP 不允許遠端載入），
  升級由本專案自行處理。axe-core 本身的漏洞請回報給
  [Deque](https://github.com/dequelabs/axe-core/security)。
