# ramp-a11y 發版 SOP

ramp-a11y 有兩個成品，發法不一樣：

| 成品 | 給誰用 | 怎麼發 |
|---|---|---|
| Chrome 擴充套件「Ramp 無障礙檢測」 | 一般使用者 | **手動**上傳 zip 到 Chrome 線上應用程式商店 |
| CLI `cornhsu-ramp-scan`（npm） | 想批次掃整個網站的人 | **自動**：推 tag 後 GitHub 幫你發到 npm |

兩者版本號一定一樣（有測試守著）。

---

## A. 一次性：把 npm 認證修好（✅ 2026-10-24 已完成，v2.0.0 已用此方式發佈）

> 留著當紀錄。**重要教訓**：npm 的 Trusted Publisher 剛建立時是「Pending validation」，
> 必須在約 2 天內用它發佈一次才會生效，否則會變成 **Expired**——7 月那筆就是這樣過期的
> （設好後一直被舊鑰匙搶先，從沒用它發過）。以後若要重設，設好後要盡快發一次版。

> 背景：7 月第一次發 npm 用的舊鑰匙（`NPM_TOKEN`）被 npm 新規擋掉了。
> 改成「GitHub 每次發佈時臨時換一把 1 小時就失效的鑰匙」（Trusted Publisher），
> 以後就不用管鑰匙了。nuget 那四個專案就是這樣設的。

**你做（npm 網站，要用 YubiKey）**

1. Chrome 打開 <https://www.npmjs.com/package/cornhsu-ramp-scan/access>，要求驗證就觸碰 YubiKey。
2. 「Trusted Publisher」區塊：狀態 **Expired** 那筆按 **Delete** → 確認。
3. 按 **Add trusted publisher** → 選 **GitHub Actions**，填：
   - Organization or user：`HSU-YU-MING`
   - Repository：`ramp-a11y`
   - Workflow filename：`release.yml`
   - Environment：**留空**
4. 儲存（要求驗證就再碰一次 YubiKey）。確認新的那筆**不是** Expired。
5. 跟 Claude 說「npm 設好了」。

**Claude 做（GitHub 這邊）**

6. 刪掉 GitHub repo 裡的舊鑰匙 `NPM_TOKEN`（不刪的話，發佈還是會先拿它去試，一樣失敗）。
7. 把 `release.yml` 裡「有 token 就用 token」那段拿掉，改成跟 PolyMigrate 一樣：只走 Trusted Publisher，環境裡出現 token 就直接失敗（以後不會再被舊鑰匙偷偷搶先）。
8. 重跑 v2.0.0 的發佈，確認 npm 上出現 2.0.0。

---

## B. 每次發新版（以後照這個做）

以下以 2.1.0（11/30 規範切版）為例。

**1. 準備**（Claude 可代勞）
- 改完程式，跑快速檢查：
  ```
  npm run lint && npm run test:unit && npm run test:self && npm run test:cli && npm run test:docs
  ```
- 有動到 `content/scanner.js` 或 `popup/popup.js` 畫面相關的，再跑 `npm test`（會開真 Chrome，約 1 分鐘）。
- 有動到 NVDA 念法的，再跑 `npm run test:nvda` 和 `npm run test:nvda:live`（NVDA 會出聲）。

**2. 改版本號**（一個指令改三個檔）
```
npm run release:prep -- 2.1.0
```
- 不能比現在小、不能帶 `-beta`；它只改檔，不 commit、不推。

**3. Commit 並推上 GitHub**
```
git add -A
git commit -m "chore(release): v2.1.0"
git push
```

**4. 打 tag → npm 自動發**
```
git tag v2.1.0
git push origin v2.1.0
```
- GitHub 會先**等這個 commit 的 CI（含 e2e）全部綠燈**，才發到 npm（最多等 30 分鐘）。
- 到 GitHub → Actions → `release` 看結果；綠勾 = npm 已發。
- 檢查：`npm view cornhsu-ramp-scan version` 應該是 2.1.0。

**5. 打包擴充套件並上傳商店**（只能手動）
```
npm run pack
```
- 產出 `dist/ramp-a11y-v2.1.0.zip`。
- 到 <https://chrome.google.com/webstore/devconsole> → 選 Ramp → 套件 → 上傳新套件 → 送審。
- 權限沒變的話，隱私權那頁不用動。審查通常幾天。

**6. （選擇性）GitHub Release**
- GitHub → Releases → 從 tag `v2.1.0` 建立 → 貼更新說明。有破壞性變更一定要寫。

**7. 作品集**
- 走 portfolio-release-update，更新 cornhsu.com 上的 ramp-a11y 頁面與文件。

---

## C. 出事時

| 狀況 | 怎麼辦 |
|---|---|
| release 卡在「等 CI」然後失敗 | CI 紅了就先修；CI 被取消（cancelled）就到 Actions 重跑 CI，綠了再重跑 release |
| npm 回 404／403 | 九成是認證：確認 npm 的 Trusted Publisher 不是 Expired（過期就刪掉重建，且建好後 2 天內要發一次）、Allow npm publish 有勾、GitHub 沒有殘留 `NPM_TOKEN`（release.yml 的守門也會擋） |
| 剛發完 `npm view` 還是舊版 | npm 的 CDN／本機快取還沒更新，等幾分鐘；或直接看 `https://registry.npmjs.org/cornhsu-ramp-scan/<版本>` |
| `npm audit` 突然紅 | 有新安全公告。看是執行期還是開發用套件；照 `CLAUDE.md` 的處理方式升級，commit 寫清楚影響範圍 |
| 本機 e2e 跑一下就結束、什麼都沒印 | Node 24 + 中文路徑的已知問題，已繞過；要看有沒有印出 `==== N/M PASS ====`，不要只看結束碼 |
| 商店拒收 | 版本號沒變高，或 zip 內缺檔（`npm run test:unit` 有檢查打包清單） |
| 發錯版 | npm 不能重發同版本號；發一個更高的修正版蓋過去，不要降版 |
