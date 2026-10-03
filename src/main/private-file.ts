import { randomBytes } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'

/** Ghi file chỉ chủ sở hữu đọc được (0600), kể cả khi đè lên file đã có quyền rộng hơn. */
export function writePrivateFile(path: string, data: Buffer | string): void {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, data, { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}
