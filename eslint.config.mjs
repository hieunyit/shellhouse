import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import importX, { createNodeResolver } from 'eslint-plugin-import-x'
import globals from 'globals'
import { readdirSync } from 'node:fs'

// Module chính thức (ADR-014 mục 3.1): mỗi thư mục trong src/modules trừ registry.
const MODULES = readdirSync('src/modules', { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'registry')
  .map((d) => d.name)

/** Ranh giới import của module: lõi chỉ đi qua registry; module không đụng module khác. */
const moduleZones = [
  // Lõi → module: chỉ qua src/modules/registry.
  ...['main', 'session-host', 'renderer', 'preload', 'shared', 'node-shared'].map((core) => ({
    target: `./src/${core}`,
    from: './src/modules',
    except: ['./registry'],
    message: 'Core code talks to modules only through src/modules/registry (ADR-014).'
  })),
  ...MODULES.flatMap((id) => [
    {
      target: `./src/modules/${id}`,
      from: './src/modules',
      except: ['./registry', `./${id}`],
      message: 'A module cannot import another module (ADR-014).'
    },
    // Phần main của module: không đọc vault / DB / cài đặt của lõi — chỉ qua ctx.
    {
      target: `./src/modules/${id}/main`,
      from: './src/main',
      message: 'Use ctx (db, secrets, settings) instead (ADR-014).'
    },
    { target: `./src/modules/${id}/main`, from: './src/session-host' },
    { target: `./src/modules/${id}/main`, from: './src/renderer' },
    { target: `./src/modules/${id}/session-host`, from: './src/main' },
    { target: `./src/modules/${id}/session-host`, from: './src/renderer' },
    { target: `./src/modules/${id}/renderer`, from: './src/main' },
    { target: `./src/modules/${id}/renderer`, from: './src/session-host' },
    { target: `./src/modules/${id}/renderer`, from: './src/node-shared' },
    { target: `./src/modules/${id}/renderer`, from: './src/preload' },
    // Renderer của module chỉ dùng thành phần UI dùng chung, không đụng store của lõi.
    {
      target: `./src/modules/${id}/renderer`,
      from: './src/renderer/src',
      except: [
        './components/ui.tsx',
        './components/ContextMenu.tsx',
        './components/files',
        './components/SortMenu.tsx',
        './components/LogViewer.tsx',
        './lib/format.ts',
        './lib/platform.ts'
      ],
      message:
        'Module UI uses src/modules/registry/renderer-kit and shared UI components only (ADR-014).'
    },
    { target: `./src/modules/${id}/shared`, from: './src/main' },
    { target: `./src/modules/${id}/shared`, from: './src/session-host' },
    { target: `./src/modules/${id}/shared`, from: './src/renderer' },
    { target: `./src/modules/${id}/shared`, from: './src/node-shared' },
    {
      target: `./src/modules/${id}/manifest.ts`,
      from: './src',
      except: ['./modules/registry/types.ts']
    }
  ])
]

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
            { target: './src/shared', from: './src/preload' },
            ...moduleZones
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
    // Alias @renderer không được ESLint phân giải → không kiểm được ranh giới; module dùng đường
    // dẫn tương đối.
    files: ['src/modules/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@renderer/*'], message: 'Use relative imports in modules.' }] }
      ]
    }
  },
  {
    files: ['src/modules/*/renderer/**/*.{ts,tsx}', 'src/modules/registry/renderer*.{ts,tsx}'],
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
    files: ['src/modules/*/test/**/*.ts'],
    rules: { 'no-console': 'off' }
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
