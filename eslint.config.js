/**
 * ESLint flat config（ESLint 9）
 *
 * 分三類環境：
 *   - 擴充套件執行端（content / popup / background）：瀏覽器 + WebExtensions 全域，
 *     另加 vendored 的全域 axe（唯讀）。
 *   - Node 端（純腳本、jsdom 單元/自我檢測測試）：僅 Node 全域。
 *   - Node + 瀏覽器端（e2e / nvda）：這些檔案以 puppeteer 的 evaluate 注入在瀏覽器
 *     情境執行的函式，因此同時會出現 document／window／chrome 等瀏覽器全域。
 * 格式相關規則交給 Prettier（eslint-config-prettier 關閉衝突項），
 * ESLint 只負責找出可能的錯誤與壞味道。lint 以 --max-warnings 0 執行，warning 亦擋 CI。
 */
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

const commonRules = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
};

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'vendor/**', 'test/e2e/output/**'] },

  js.configs.recommended,

  // 擴充套件執行端
  {
    files: ['content/**/*.js', 'popup/**/*.js', 'background/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        axe: 'readonly', // vendor/axe.min.js 先行注入
      },
    },
    rules: {
      ...commonRules,
      eqeqeq: ['warn', 'smart'],
      // 中文 UI 文案在樣板字串中會刻意使用全形空白（U+3000）作為排版間隔，非誤植
      'no-irregular-whitespace': ['error', { skipTemplates: true, skipStrings: true }],
    },
  },

  // Node 端：純腳本與 jsdom 測試（不含瀏覽器全域，避免 scripts 誤用 document/window 未被抓到）
  {
    files: ['scripts/**/*.js', 'test/unit/**/*.js', 'test/self-audit/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: commonRules,
  },

  // Node + 瀏覽器端：e2e / nvda 以 puppeteer evaluate 注入瀏覽器情境的函式
  {
    files: ['test/e2e/**/*.js', 'test/nvda/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: commonRules,
  },

  prettier,
];
