# Third-party notices ／ 第三方元件授權

本專案的程式碼以 MIT 授權（見 [LICENSE](LICENSE)）。以下元件不適用該授權，
各自依原授權條款發布。

The project's own code is MIT licensed (see [LICENSE](LICENSE)). The components
below are **not** covered by that licence and are distributed under their own terms.

## axe-core

- 檔案 ／ Files: `vendor/axe.min.js`、`vendor/axe-locale-zh_TW.js`
- 版本 ／ Version: 4.10.3
- 著作權 ／ Copyright: Deque Systems, Inc.
- 授權 ／ Licence: [MPL-2.0](https://github.com/dequelabs/axe-core/blob/develop/LICENSE)
- 來源 ／ Source: https://github.com/dequelabs/axe-core

Ramp 以本地檔案形式打包 axe-core 作為檢測引擎：`axe.min.js` 為官方發行檔、未修改；
`axe-locale-zh_TW.js` 是官方 `locales/zh_TW.json` 語言包包上一層
`window.axe.configure(...)` 載入外殼（產製指令見 README〈vendor 檔案的取得與更新〉），
語言內容本身未修改。升級 axe 版本時，請一併校對 `data/rules-map.json` 的規則異動。

Ramp bundles axe-core locally as its scanning engine: `axe.min.js` is the official
build, unmodified; `axe-locale-zh_TW.js` wraps the official `locales/zh_TW.json`
in a `window.axe.configure(...)` loader shell (see the README for the exact
command), with the locale content itself unmodified. When upgrading axe,
re-verify the rule mappings in `data/rules-map.json`.
