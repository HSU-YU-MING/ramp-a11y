/**
 * ESLint flat config（ESLint 9）
 *
 * 分三類環境：
 *   - 擴充套件執行端（content / popup / background）：瀏覽器 + WebExtensions 全域，
 *     另加 vendored 的全域 axe（唯讀）。
 *   - Node 端（test / scripts）：Node 全域。
 * 格式相關規則交給 Prettier（eslint-config-prettier 關閉衝突項），
 * ESLint 只負責找出可能的錯誤與壞味道。
 */
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['warn', 'smart'],
      // 中文 UI 文案在樣板字串中會刻意使用全形空白（U+3000）作為排版間隔，非誤植
      'no-irregular-whitespace': ['error', { skipTemplates: true, skipStrings: true }],
    },
  },

  // Node 端（測試與打包腳本）
  // e2e／nvda 測試以 puppeteer 的 evaluate 注入在瀏覽器情境執行的函式，
  // 因此這些 Node 檔案同時會出現 document／window／chrome 等瀏覽器全域。
  {
    files: ['test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  prettier,
];
