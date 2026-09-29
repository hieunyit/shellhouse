import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** Ma trận tương thích với SSH server thật (Docker). Không nằm trong `pnpm test`. */
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['test/compat/**/*.test.ts'],
    globalSetup: ['test/compat/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 20 * 60_000,
    // Một luồng: các test dùng chung container.
    fileParallelism: false
  }
})
