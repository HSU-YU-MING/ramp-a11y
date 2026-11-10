# Ramp (ramp-a11y)

[English](README.en.md) · [繁體中文](README.md)

[![CI](https://github.com/HSU-YU-MING/ramp-a11y/actions/workflows/ci.yml/badge.svg)](https://github.com/HSU-YU-MING/ramp-a11y/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/cornhsu-ramp-scan?label=cornhsu-ramp-scan)](https://www.npmjs.com/package/cornhsu-ramp-scan)
[![npm downloads](https://img.shields.io/npm/dt/cornhsu-ramp-scan)](https://www.npmjs.com/package/cornhsu-ramp-scan)

A web accessibility (a11y) checker — a Chrome / Edge browser extension (Manifest V3).

Ramp scans the page you are actually viewing (the real, post-JavaScript DOM), uses the open-source [axe-core](https://github.com/dequelabs/axe-core) engine to find WCAG issues, and explains **in Traditional Chinese** why each is a barrier and how to fix it — mapping every finding to **Taiwan's official "Website Accessibility Guidelines"** (準則 numbers and A / AA / AAA conformance levels).

> **Why this matters:** international tools (axe, WAVE, Lighthouse) report against WCAG in English but do not map to Taiwan's local regulation, inspection codes, or accreditation scheme. Ramp fills that gap: modern, in-browser, Traditional-Chinese, and mapped to the Taiwan standard.

**[Project write-up](https://cornhsu.com/ramp-a11y) · [Chrome Web Store](https://chromewebstore.google.com/detail/bbdbehdknkmhpbolgohjlmikbfganhfm) · MIT**

## Demo

![Ramp demo: one-click scan, level-grouped issue list, per-issue Traditional-Chinese explanation with NVDA screen-reader preview, click-to-highlight on the page, plus reading-order and live-region tabs](docs/ramp-demo.gif)

> Full flow on the [test fixture page](test/fixture.html): **scan → level-grouped issues → expand for "why / how to fix / NVDA preview" → click an element to highlight it on the page → switch to the "Reading Order" and "Live Regions" tabs.**

## Install

👉 **[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/bbdbehdknkmhpbolgohjlmikbfganhfm)** (works on Chrome and Edge).

Click the Ramp toolbar icon on any normal page → "開始檢測" (Start scan). Shortcut: `Ctrl+Shift+U`. To load from source, see [From source](#from-source-developers).

## Features

- **One-click scan** of the current tab, results grouped by **A / AA / AAA** level, sorted within a group by axe severity (critical → minor).
- **Taiwan-regulation mapping**: every issue is labelled with the Taiwan 準則 number, category (Perceivable / Operable / Understandable / Robust), conformance level, and — for 34 rules — the official inspection code (e.g. `HM1240200C`) so reports line up with the government's Freego tool.
- **Traditional-Chinese, educational explanations**: each finding says *why it is a barrier* and *how to fix it*, not just an error code.
- **Click-to-locate**: click an affected element and Ramp highlights it on the live page and scrolls to it (respecting `prefers-reduced-motion`).
- **NVDA screen-reader preview**: under each finding, Ramp shows how [NVDA](https://www.nvda.org.tw/) (the most common free screen reader in Taiwan) would announce the element — **name + role + value + state + set position + item count + description + table coordinates**. Wording is verified against NVDA's official `zh_TW` localization and cross-checked against **real NVDA** driven by Guidepup (two modes: Tab traversal + line-by-line browse mode).
- **Reading-order preview**: linearizes the whole page into NVDA's actual reading sequence (up to 500 stops per pass, truncation flagged), marks landmark/table/list enter-exit boundaries, and flags **order mismatches** (visual left-to-right order vs. reading order on the same row — WCAG 1.3.2).
- **Live-region monitoring**: a `MutationObserver` watches `aria-live` / `role=alert` / `status` / `log` regions and lists what NVDA would auto-announce, with priority (`assertive` vs `polite`). Monitoring auto-stops ~3 minutes after the popup closes; the latest 100 captured announcements are kept.
- **Honest self/manual split**: axe `incomplete` results are marked "needs manual review" — no misleading "fully compliant" verdict.
- **Partial scan**: set a scan range (a CSS selector such as `#dialog` or `.modal`; every match is scanned) to audit just a dialog, a component or one part of the page — or press **Pick on page**, click the region, and reopen Ramp to find the range filled in (the selector comes from axe, written like the result targets). Results and the exported report always state what was scanned; an invalid or unmatched selector sends you back with an explanation instead of silently scanning the whole page.
- **Built-in contrast checker**: every text-contrast finding shows axe's text colour, background and ratio, or why axe couldn't tell (background image, gradient, overlapping element). **Measure actual contrast** captures the visible tab (already allowed by `activeTab`; the image stays in the popup's memory), samples a ring of background pixels just outside each line of text, and reports the **worst** point, the median and how many points fall below the threshold (4.5:1, or 3:1 for large text). Measurements go into the exported report; the self-assessment still decides the verdict.
- **Manual checklist for new criteria**: the 8 criteria added by the 115 amendment that axe cannot judge are listed with when they apply, how to check them, and official check codes. Unconfirmed never counts as passed, and the CLI report lists them without affecting the exit code.
- **Manual-review self-assessment**: mark review items pass/fail, persisted per URL and included in the exported report.
- **Report export**: one-click self-contained HTML report (open to read, print to PDF; up to 20 affected elements listed per rule, with the total noted).
- **Dark mode**, **target level** (default AA), **result filter** (all / violations / review), and **scan delay** (3 / 10 s for animated or lazy-loaded pages).

## Real-world case study

Ramp scanned the home page of a **live Taiwanese central-government ministry website** (checked July 2026). It is presented anonymously out of respect for the site owner, and the content may have changed since — the point is to show the tool's output on a real page.

| Metric | Result |
|--------|--------|
| Violations | **4 rules, 23 affected elements** (all level A) |
| Best-practice advisories | 1 rule (13 elements) |
| Needs manual review | 2 rules — including **102** text-contrast cases axe could not decide automatically |

The four violations, with Ramp's simulated NVDA announcement:

1. **Images missing alt text** (1.1.1 / A / 6) — NVDA says only "圖片" (image); the information is lost.
2. **Links with no discernible text** (2.4.4 / A / 3) — NVDA says only "連結" (link); the destination is unknown.
3. **ARIA role missing a required parent** (1.3.1 / A / 11) — tab labels lack a `tablist` container, breaking screen-reader navigation.
4. **Unsupported ARIA attribute** (4.1.2 / A / 3) — `aria-pressed` on an element that does not support it, so state is unreliable.

This case highlights Ramp's three design goals: **map to the Taiwan standard**, **preview the NVDA experience**, and **stay honest** — the 102 contrast cases are flagged for manual review rather than passed or failed, because no automated tool can reliably judge text contrast over background images.

## Full-site CLI (`ramp-scan`)

The extension scans one tab. To **audit a whole site**, Ramp ships a local Node CLI that runs the **exact same** scan and Taiwan-standard mapping on every page — the extension (interactive, single-page) and the CLI (batch, whole-site) are driven by **one shared mapping core** ([`shared/report-core.js`](shared/report-core.js)), written once and reused, with the module boundary preventing drift. No backend, no hosting — it runs locally.

Published on npm as [`cornhsu-ramp-scan`](https://www.npmjs.com/package/cornhsu-ramp-scan) — no clone needed (requires **Node.js 22.12+**, following puppeteer-core, and a local Chrome; set `--chrome` / `CHROME_PATH` if it isn't auto-found):

```sh
npx cornhsu-ramp-scan https://example.com --depth 2 --format html  # zero-install
npm i -g cornhsu-ramp-scan && ramp-scan https://example.com        # or install globally
npm run scan -- --url-list url_inventory.csv --format html         # from a repo checkout
```

It emits structured **JSON** and a self-contained **HTML** report styled like the extension's export (site summary → most common barriers → per-page detail). For CI, pass `--fail-on violations` to exit with code 3 when a violation **within the `--level` target and mapped to a Taiwan criterion** is found (beyond-target, unmapped and best-practice findings don't count). Exit codes: `0` scan completed, `1` usage error (unknown flag, bad value, missing or empty list file, start URL or whole list filtered out — all caught before Chrome launches), `2` scan error (single-page failure, or **all** pages failed in multi-page mode; partial failures stay 0 and are recorded in the report), `3` `--fail-on` triggered — see `--help`. `--include`/`--exclude` filter discovered links and list entries (the crawl **start page is always scanned**); `--scope <css>` / `--scope-exclude <css>` scan only that region of every page (a page where the selector matches nothing is recorded as failed, never silently scanned whole; an invalid selector is a usage error, exit 1); Chrome's sandbox is kept by default (`--no-sandbox` to opt out in containers; added automatically when the `CI` env var is truthy — `CI=false`/`0` doesn't count). This turns a dev-time single-page pre-check into an automatable, whole-site localized audit — the piece that lets Ramp slot into a delivery pipeline.

**Composes with [PolyMigrate](https://github.com/HSU-YU-MING/cornhsu-polymigrate).** `--url-list` reads the `url_inventory.csv` produced by PolyMigrate (my i18n-first static-site migrator); when the list carries a `lang` column, Ramp additionally reports accessibility **per language** — so a migrated multilingual site can be audited for its Chinese and English versions separately (e.g. the zh page failing rules the en page doesn't). Two tools, one workflow: migrate the multilingual site, then audit each language's accessibility.

> **Use responsibly:** crawling sends real requests. **Sequential by default, 250 ms spacing**; `--concurrency` speeds crawls up but raises instantaneous load on the server. Scan sites you own or are authorized to test, and bound load with `--delay` / `--concurrency` / `--max-pages`. Architecture and scope: [docs/fullsite-cli-plan.md](docs/fullsite-cli-plan.md).

## Permissions

Ramp does **not** request persistent all-sites access. It uses only:

- `activeTab` — temporary access to the current tab, granted only when you click the icon (the contrast checker's screenshot uses it too; no extra permission).
- `scripting` — to inject axe-core and the scanner.
- `storage` — session cache of scan results (cleared when the browser closes), plus local storage for preferences and per-URL manual-review self-assessments (persistent, keeping the 200 most recent URLs; removed together with the extension).

Everything stays in your browser — all analysis runs locally and no data is sent to any server.

## From source (developers)

1. Clone this repo.
2. Open `chrome://extensions/` (Edge: `edge://extensions/`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).

## Development & testing

```sh
npm install
npm run lint         # ESLint (flat config)
npm run format:check # Prettier
npm run test:unit    # Pure-function unit tests (jsdom, no Chrome): 182 checks
npm run test:self    # Static a11y contract test on the popup: 13 checks
npm run test:cli     # Full-site CLI pure-function tests (URL/CSV/aggregate/target-split): 84 checks
npm run test:docs    # README claim guard (test counts / check-code count / axe version)
npm test             # End-to-end (needs local Chrome; CHROME_PATH to override): 67 checks
npm run test:nvda    # Real-NVDA comparison (interactive desktop; see test/nvda/)
npm run test:nvda:live  # Real-NVDA live-region (dynamic announcement) comparison
```

Everything except e2e/nvda runs automatically on every push/PR via [GitHub Actions](.github/workflows/ci.yml); e2e also runs in CI under xvfb with a stable Chrome. See the Traditional-Chinese README for e2e troubleshooting.

Releasing: the version lives in three places that none of them can drop — `package.json`, `package-lock.json`, and `manifest.json` (the Chrome Web Store reads the version from the manifest inside the zip, so it cannot be derived from the tag). `npm run release:prep -- 2.0.0` writes all three at once, then prints the remaining steps. Pushing a `v*` tag triggers [release.yml](.github/workflows/release.yml) to publish the npm package.

## Limitations (important)

- **Automated checks cover only ~30–40%** of accessibility problems. Keyboard flow, real screen-reader experience, and whether content is *appropriate* still require human review.
- Results are **not** equivalent to any official accessibility accreditation; apply through the official process if you need a badge.
- The mapping table covers **72 entries** (71 actual axe rules plus a documentation-only entry for 2.4.7 Focus Visible) across **26 criteria** of the Taiwan standard, of which **25 auto-detectable**; the rest (keyboard traps, caption quality, reading order, …) inherently require manual testing.
- Cross-origin iframe content is out of scope (MVP limitation).
- Shadow DOM: the issue scan handles it (via axe; click-to-highlight may not locate those elements), but reading order and live-region monitoring do not descend into shadow roots yet.

## Standards & versions

Ramp targets the 115 amendment of Taiwan's "Website Accessibility Guidelines":

| Version | Aligns with | Success criteria | Applies |
|---------|-------------|------------------|---------|
| 110.07 | WCAG 2.1 | 78 | applied until 2026-11-29 |
| 115 amendment | WCAG 2.2 | 87 (adds 9; 4.1.1 keeps its number marked "removed as obsolete", so 86 apply) | **current, effective 2026-11-30** |

4.1.1 is no longer checked. 2.5.8 is checked by axe's `target-size` rule, and the other 8 new criteria appear as a manual checklist. Official PDFs are included under `docs/`.

The download page of Freego, the official checker, still said 110.07 when checked on 2026-11-08. Confirm which version the official process accepts before applying for a badge.

## License & credits

- Code: [MIT License](LICENSE).
- Engine: [axe-core](https://github.com/dequelabs/axe-core) **v4.10.3** (MPL-2.0), bundled locally in `vendor/axe.min.js`. Re-verify `data/rules-map.json` when upgrading axe.
- Full third-party terms: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
