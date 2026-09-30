import { defineConfig } from '@playwright/test'

export default defineConfig({
  timeout: 30_000,
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  // CI: reporter `github` biến lỗi thành annotation — đọc được trên trang GitHub không cần tải log.
  reporter: process.env['CI'] ? [['list'], ['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    // Test E2E của module nằm cạnh module (src/modules/<id>/test/e2e).
    {
      name: 'e2e',
      testDir: '.',
      testMatch: ['test/e2e/**/*.spec.ts', 'src/modules/*/test/e2e/**/*.spec.ts']
    },
    { name: 'bench', testDir: 'test/bench', timeout: 300_000, retries: 0 },
    { name: 'soak', testDir: 'test/soak', retries: 0 },
    { name: 'package', testDir: 'test/package', timeout: 90_000 },
    { name: 'screens', testDir: 'test/screens', retries: 0 }
  ]
})
