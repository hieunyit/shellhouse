import { defineConfig } from '@playwright/test'

export default defineConfig({
  timeout: 30_000,
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'e2e', testDir: 'test/e2e' },
    { name: 'bench', testDir: 'test/bench', timeout: 300_000, retries: 0 },
    { name: 'soak', testDir: 'test/soak', retries: 0 },
    { name: 'package', testDir: 'test/package', timeout: 90_000 },
    { name: 'screens', testDir: 'test/screens', retries: 0 }
  ]
})
