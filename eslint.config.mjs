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

// Lớp màu Tailwind (có thể kèm biến thể hover:, dark:…) — chặn trong giao diện mới.
const COLOR_UTILS =
  'bg|text|border|border-[trblxy]|border-[se]|ring|ring-offset|outline|fill|stroke|from|via|to|shadow|divide|decoration|accent|caret|placeholder'
const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white'
const RAW_COLOR_CLASS = `/(^|[\\s:!])(${COLOR_UTILS})-(${PALETTE})(-[0-9]+)?(?=$|[\\s/])/`
const ARBITRARY_COLOR_CLASS = `/(^|[\\s:!])(${COLOR_UTILS})-\\[(#|rgb|hsl|oklch|color)/`
const LEGACY_TOKEN_CLASS = `/(^|[\\s:!])(bg|text|border|ring|outline|fill|stroke|divide)-(canvas|surface|elevated|subtle|line|line-strong|fg|muted|faint|accent|accent-solid|accent-soft|accent-fg|danger|danger-soft|danger-solid|warning|warning-soft|success|success-soft|terminal)(\\/[0-9]+)?(\\s|$)/`

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
        './components/panels.tsx',
        './lib/format.ts',
        './lib/platform.ts',
        // Design system (thiết kế v0.5) — component dùng chung, không có store của lõi.
        './ds'
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
  {
    // design/: prototype HTML / script tham khảo của thiết kế, không phải mã của app.
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'design/**'
    ]
  },
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
    // Giao diện mới (design system + shell): chỉ dùng token (bg-ds-surface-1, text-ds-fg-2…), không
    // dùng màu Tailwind thô (text-red-500, bg-green-50…), mã màu tuỳ ý (bg-[#fff]) hay token của giao
    // diện cũ (bg-surface, text-muted…) — quy tắc màu theo ngữ nghĩa (text-ds-success, bg-ds-env-dev-soft…)
    // chỉ giữ được nhất quán khi màu đi qua token.
    files: ['src/renderer/src/ds/**/*.{ts,tsx}', 'src/renderer/src/shell/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Không render HTML từ dữ liệu. Xem mục 7.3 kế hoạch.'
        },
        ...['Literal', 'TemplateElement'].flatMap((node) => {
          const value = node === 'Literal' ? 'value' : 'value.raw'
          return [
            {
              selector: `${node}[${value}=${RAW_COLOR_CLASS}]`,
              message:
                'Dùng token của design system (bg-ds-*, text-ds-*, border-ds-*…), không dùng màu Tailwind thô.'
            },
            {
              selector: `${node}[${value}=${ARBITRARY_COLOR_CLASS}]`,
              message: 'Không dùng mã màu tuỳ ý trong class — thêm token vào ds/tokens.css.'
            },
            {
              selector: `${node}[${value}=${LEGACY_TOKEN_CLASS}]`,
              message:
                'Giao diện mới dùng token --ds-* (bg-ds-surface-1, text-ds-fg-2…), không dùng token của giao diện cũ.'
            }
          ]
        })
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
