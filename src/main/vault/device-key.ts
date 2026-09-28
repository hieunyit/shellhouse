import type { Db } from '../store/db'
import { memzero } from './crypto'

/** Bảo vệ dữ liệu bằng keychain của hệ điều hành (Keychain / DPAPI / Secret Service). */
export interface KeyProtector {
  available(): { ok: true } | { ok: false; reason: string }
  encrypt(data: Buffer): Buffer
  decrypt(data: Buffer): Buffer
}

// Không nằm trong AppSettings (vốn được gửi sang renderer).
const ROW_KEY = 'vault.deviceKey'

/** DEK được bọc bằng keychain của máy và lưu trong DB — sao chép DB sang máy khác thì vô dụng. */
export class DeviceKeyStore {
  constructor(
    private readonly db: Db,
    private readonly protector: KeyProtector
  ) {}

  availability(): ReturnType<KeyProtector['available']> {
    return this.protector.available()
  }

  has(): boolean {
    return this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(ROW_KEY) !== undefined
  }

  save(dek: Buffer): void {
    const available = this.protector.available()
    if (!available.ok) throw new Error(available.reason)
    const sealed = this.protector.encrypt(dek)
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(ROW_KEY, sealed.toString('base64'))
  }

  /** null nếu không có hoặc không giải mã được (keychain đổi, DB chép từ máy khác...). */
  load(): Buffer | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(ROW_KEY) as
      { value: string } | undefined
    if (!row || !this.protector.available().ok) return null
    try {
      return this.protector.decrypt(Buffer.from(row.value, 'base64'))
    } catch {
      return null
    }
  }

  clear(): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(ROW_KEY)
  }
}

export { memzero }
