# Third-party notices ／ 第三方元件授權

本專案的程式碼以 MIT 授權（見 [LICENSE](LICENSE)）。以下元件不適用該授權，
各自依原授權條款發布。

The project's own code is MIT licensed (see [LICENSE](LICENSE)). The components
below are **not** covered by that licence and are distributed under their own terms.

## axe-core

- 檔案 ／ File: `vendor/axe.min.js`
- 版本 ／ Version: 4.10.3
- 著作權 ／ Copyright: Deque Systems, Inc.
- 授權 ／ Licence: [MPL-2.0](https://github.com/dequelabs/axe-core/blob/develop/LICENSE)
- 來源 ／ Source: https://github.com/dequelabs/axe-core

Ramp 以本地檔案形式打包 axe-core 作為檢測引擎，未修改其原始碼。升級 axe 版本時，
請一併校對 `data/rules-map.json` 的規則異動。

Ramp bundles axe-core locally as its scanning engine, unmodified. When upgrading
axe, re-verify the rule mappings in `data/rules-map.json`.
