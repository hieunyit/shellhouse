import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import importX, { createNodeResolver } from 'eslint-plugin-import-x'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node }
    },
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [
        createNodeResolver({ extensions: ['.ts', '.tsx', '.d.ts', '.js', '.mjs', '.json'] })
      ]
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'error',
      // Ranh giới process: mỗi process chỉ được import shared/ và code của chính nó.
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './src/renderer', from: './src/main' },
            { target: './src/renderer', from: './src/session-host' },
            { target: './src/renderer', from: './src/preload' },
            { target: './src/renderer', from: './src/node-shared' },
            { target: './src/preload', from: './src/node-shared' },
            { target: './src/node-shared', from: './src/main' },
            { target: './src/node-shared', from: './src/session-host' },
            { target: './src/node-shared', from: './src/renderer' },
            { target: './src/session-host', from: './src/main' },
            { target: './src/session-host', from: './src/renderer' },
            { target: './src/main', from: './src/session-host' },
            { target: './src/main', from: './src/renderer' },
            { target: './src/preload', from: './src/main' },
            { target: './src/preload', from: './src/session-host' },
            { target: './src/shared', from: './src/main' },
            { target: './src/shared', from: './src/session-host' },
            { target: './src/shared', from: './src/renderer' },
            { target: './src/shared', from: './src/preload' }
          ]
        }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Không render HTML từ dữ liệu. Xem mục 7.3 kế hoạch.'
        }
      ]
    }
  },
  {
    files: ['test/**/*.ts'],
    rules: { 'no-console': 'off' }
  },
  {
    files: ['*.config.{ts,js}', 'eslint.config.mjs'],
    ...tseslint.configs.disableTypeChecked
  },
  {
    // Script build/phát hành chạy bằng node trực tiếp, không qua TypeScript.
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: { ...tseslint.configs.disableTypeChecked.rules, 'no-console': 'off' }
  }
)
