import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'test/fuzz/**/*.test.ts',
      // Logic thuần của renderer (typecheck theo tsconfig.web.json).
      'test/renderer/**/*.test.ts',
      'src/modules/*/test/{unit,integration}/**/*.test.ts'
    ],
    environment: 'node',
    // Runner CI (nhất là macOS Intel) chậm hơn máy dev nhiều lần: test tích hợp chạy ssh-keygen,
    // sftp-server thật — 5 giây mặc định không đủ.
    testTimeout: process.env['CI'] ? 30_000 : 5_000
  }
})
