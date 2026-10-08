import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

const dirs: string[] = []

/** Thư mục tạm, tự xoá sau mỗi test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shellhouse-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  // Windows: tiến trình con (sftp-server.exe, shell) có thể chưa kịp thoát và còn giữ file → EPERM /
  // EBUSY. Thử lại vài lần thay vì làm hỏng test vì bước dọn dẹp.
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
})
