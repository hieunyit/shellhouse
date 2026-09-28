import { Secret } from '../../node-shared/secret'
import type { Db } from '../store/db'
import {
  DEFAULT_KDF,
  DecryptError,
  deriveKey,
  KEY_BYTES,
  memzero,
  open,
  randomBytes,
  SALT_BYTES,
  seal,
  type KdfParams
} from './crypto'

export type VaultState = 'uninitialized' | 'locked' | 'unlocked'

export const MIN_PASSWORD_LENGTH = 8
const FORMAT_VERSION = 1
const DEK_AD = `vault|dek|v${FORMAT_VERSION}`
const CHECK_AD = `vault|check|v${FORMAT_VERSION}`
const CHECK_PLAINTEXT = Buffer.from('shellhouse-dek-check')

export class WrongPasswordError extends Error {
  constructor() {
    super('Sai master password')
    this.name = 'WrongPasswordError'
  }
}

export class PasswordTooShortError extends Error {
  constructor() {
    super(`Master password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    this.name = 'PasswordTooShortError'
  }
}

export class VaultExistsError extends Error {
  constructor() {
    super('The vault already exists')
    this.name = 'VaultExistsError'
  }
}

export class VaultBusyError extends Error {
  constructor() {
    super('The vault is busy')
    this.name = 'VaultBusyError'
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super('The vault is locked')
    this.name = 'VaultLockedError'
  }
}

/** Vị trí của một trường mã hoá — dùng làm AD để không tráo được ciphertext giữa các dòng/trường. */
export interface FieldRef {
  table: string
  id: string
  field: string
}

interface MetaRow {
  format_version: number
  kdf: string
  kdf_params: string
  salt: Buffer
  wrapped_dek: Buffer
  dek_check: Buffer | null
}

export class InvalidDeviceKeyError extends Error {
  constructor() {
    super('The key stored on this device is no longer valid')
    this.name = 'InvalidDeviceKeyError'
  }
}

function fieldAd(ref: FieldRef): string {
  for (const part of [ref.table, ref.id, ref.field]) {
    if (!part || part.includes('|')) throw new Error(`Invalid FieldRef: ${part}`)
  }
  return `${ref.table}|${ref.id}|${ref.field}|v${FORMAT_VERSION}`
}

function parseKdfParams(raw: string): KdfParams {
  const parsed = JSON.parse(raw) as Partial<KdfParams>
  if (typeof parsed.ops !== 'number' || typeof parsed.mem !== 'number') {
    throw new Error('Corrupted kdf_params')
  }
  return { ops: parsed.ops, mem: parsed.mem }
}

/**
 * Vault: mọi secret được mã hoá bằng DEK ngẫu nhiên; DEK được bọc bằng KEK = Argon2id(master password).
 * DEK chỉ nằm trong main process và bị ghi đè bằng 0 khi khoá.
 */
export class Vault {
  private dek: Buffer | null = null
  private busy = false
  private readonly listeners = new Set<(state: VaultState) => void>()

  constructor(
    private readonly db: Db,
    private readonly kdf: KdfParams = DEFAULT_KDF
  ) {}

  state(): VaultState {
    if (this.dek) return 'unlocked'
    return this.readMeta() ? 'locked' : 'uninitialized'
  }

  onChange(listener: (state: VaultState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async create(password: Secret): Promise<void> {
    if (password.length < MIN_PASSWORD_LENGTH) throw new PasswordTooShortError()
    await this.exclusive(async () => {
      if (this.readMeta()) throw new VaultExistsError()
      const salt = randomBytes(SALT_BYTES)
      const dek = randomBytes(KEY_BYTES)
      const kek = await deriveKey(password.reveal(), salt, this.kdf)
      try {
        const wrapped = seal(kek, dek, DEK_AD)
        this.db
          .prepare(
            `INSERT INTO vault_meta (id, format_version, kdf, kdf_params, salt, wrapped_dek, dek_check)
             VALUES (1, ?, 'argon2id', ?, ?, ?, ?)`
          )
          .run(
            FORMAT_VERSION,
            JSON.stringify(this.kdf),
            salt,
            wrapped,
            seal(dek, CHECK_PLAINTEXT, CHECK_AD)
          )
      } finally {
        memzero(kek)
      }
      this.dek = dek
    })
    this.emit()
  }

  async unlock(password: Secret): Promise<void> {
    if (this.dek) return
    await this.exclusive(async () => {
      const dek = await this.unwrap(password)
      this.ensureCheck(dek)
      this.dek = dek
    })
    this.emit()
  }

  /** Mở bằng DEK lấy từ keychain của máy ("nhớ trên máy này"). Nhận quyền sở hữu buffer. */
  unlockWithKey(dek: Buffer): void {
    if (this.dek) {
      memzero(dek)
      return
    }
    const meta = this.readMeta()
    if (!meta?.dek_check || dek.length !== KEY_BYTES) {
      memzero(dek)
      throw new InvalidDeviceKeyError()
    }
    try {
      if (!open(dek, meta.dek_check, CHECK_AD).equals(CHECK_PLAINTEXT))
        throw new InvalidDeviceKeyError()
    } catch {
      memzero(dek)
      throw new InvalidDeviceKeyError()
    }
    this.dek = dek
    this.emit()
  }

  /** Bản sao DEK để lưu vào keychain. Người gọi phải memzero sau khi dùng. */
  exportKey(): Buffer {
    return Buffer.from(this.requireDek())
  }

  /** Kiểm tra master password mà không đổi trạng thái (ví dụ trước khi tắt "nhớ trên máy"). */
  async verifyPassword(password: Secret): Promise<boolean> {
    try {
      const dek = await this.unwrap(password)
      memzero(dek)
      return true
    } catch (error) {
      if (error instanceof WrongPasswordError) return false
      throw error
    }
  }

  lock(): void {
    if (!this.dek) return
    memzero(this.dek)
    this.dek = null
    this.emit()
  }

  /** Chỉ bọc lại DEK — không phải mã hoá lại từng secret. */
  async changePassword(current: Secret, next: Secret): Promise<void> {
    if (next.length < MIN_PASSWORD_LENGTH) throw new PasswordTooShortError()
    await this.exclusive(async () => {
      const dek = await this.unwrap(current)
      const salt = randomBytes(SALT_BYTES)
      const kek = await deriveKey(next.reveal(), salt, this.kdf)
      try {
        this.db
          .prepare(
            `UPDATE vault_meta SET kdf = 'argon2id', kdf_params = ?, salt = ?, wrapped_dek = ?,
                    dek_check = ? WHERE id = 1`
          )
          .run(
            JSON.stringify(this.kdf),
            salt,
            seal(kek, dek, DEK_AD),
            seal(dek, CHECK_PLAINTEXT, CHECK_AD)
          )
      } finally {
        memzero(kek)
      }
      if (this.dek) memzero(this.dek)
      this.dek = dek
    })
    this.emit()
  }

  encrypt(ref: FieldRef, plaintext: Buffer): Buffer {
    return seal(this.requireDek(), plaintext, fieldAd(ref))
  }

  encryptString(ref: FieldRef, plaintext: string): Buffer {
    const buf = Buffer.from(plaintext, 'utf8')
    try {
      return this.encrypt(ref, buf)
    } finally {
      buf.fill(0)
    }
  }

  decrypt(ref: FieldRef, sealed: Buffer): Secret {
    return Secret.adopt(open(this.requireDek(), sealed, fieldAd(ref)))
  }

  private async unwrap(password: Secret): Promise<Buffer> {
    const meta = this.readMeta()
    if (!meta) throw new Error('The vault has not been created')
    if (meta.format_version !== FORMAT_VERSION || meta.kdf !== 'argon2id') {
      throw new Error(`Unsupported vault format: v${meta.format_version}/${meta.kdf}`)
    }
    const kek = await deriveKey(password.reveal(), meta.salt, parseKdfParams(meta.kdf_params))
    try {
      return open(kek, meta.wrapped_dek, DEK_AD)
    } catch (error) {
      if (error instanceof DecryptError) throw new WrongPasswordError()
      throw error
    } finally {
      memzero(kek)
    }
  }

  /** Vault tạo từ bản cũ chưa có dek_check → bổ sung khi mở khoá bằng password. */
  private ensureCheck(dek: Buffer): void {
    if (this.readMeta()?.dek_check) return
    this.db
      .prepare('UPDATE vault_meta SET dek_check = ? WHERE id = 1')
      .run(seal(dek, CHECK_PLAINTEXT, CHECK_AD))
  }

  private requireDek(): Buffer {
    if (!this.dek) throw new VaultLockedError()
    return this.dek
  }

  private readMeta(): MetaRow | undefined {
    return this.db
      .prepare(
        'SELECT format_version, kdf, kdf_params, salt, wrapped_dek, dek_check FROM vault_meta WHERE id = 1'
      )
      .get() as MetaRow | undefined
  }

  /** Không cho hai thao tác Argon2 chạy song song (chống spam unlock và race). */
  private async exclusive(fn: () => Promise<void>): Promise<void> {
    if (this.busy) throw new VaultBusyError()
    this.busy = true
    try {
      await fn()
    } finally {
      this.busy = false
    }
  }

  private emit(): void {
    const state = this.state()
    for (const listener of this.listeners) listener(state)
  }
}
