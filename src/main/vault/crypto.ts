import { loadNative } from '../native'

type Sodium = typeof import('sodium-native')

let cached: Sodium | null = null
function sodium(): Sodium {
  cached ??= loadNative('sodium-native') as Sodium
  return cached
}

export interface KdfParams {
  /** Số vòng Argon2id. */
  ops: number
  /** Bộ nhớ Argon2id (byte). */
  mem: number
}

/** Tham số mặc định: t=3, m=64 MiB (KE-HOACH-MOI.md mục 7.1). */
export const DEFAULT_KDF: KdfParams = { ops: 3, mem: 64 * 1024 * 1024 }
/** Chỉ dùng cho test để chạy nhanh. Không bao giờ dùng cho dữ liệu thật. */
export const TEST_KDF: KdfParams = { ops: 1, mem: 8 * 1024 * 1024 }

export const KEY_BYTES = 32
export const SALT_BYTES = 16
const NONCE_BYTES = 24
const TAG_BYTES = 16

export function randomBytes(length: number): Buffer {
  const buf = Buffer.alloc(length)
  sodium().randombytes_buf(buf)
  return buf
}

export function memzero(buf: Buffer): void {
  sodium().sodium_memzero(buf)
}

/** Argon2id chạy trên threadpool của libuv — không chặn main process. */
export async function deriveKey(
  password: Buffer,
  salt: Buffer,
  params: KdfParams
): Promise<Buffer> {
  const s = sodium()
  if (salt.length !== s.crypto_pwhash_SALTBYTES) throw new Error('Wrong salt length')
  const out = Buffer.alloc(KEY_BYTES)
  await s.crypto_pwhash_async(
    out,
    password,
    salt,
    params.ops,
    params.mem,
    s.crypto_pwhash_ALG_ARGON2ID13
  )
  return out
}

export class DecryptError extends Error {
  constructor() {
    super('Decryption failed (wrong key or tampered data)')
    this.name = 'DecryptError'
  }
}

/** XChaCha20-Poly1305. Kết quả: nonce(24) || ciphertext || tag(16). */
export function seal(key: Buffer, plaintext: Buffer, ad: string): Buffer {
  const s = sodium()
  const out = Buffer.alloc(NONCE_BYTES + plaintext.length + TAG_BYTES)
  const nonce = out.subarray(0, NONCE_BYTES)
  s.randombytes_buf(nonce)
  s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    out.subarray(NONCE_BYTES),
    plaintext,
    Buffer.from(ad, 'utf8'),
    null,
    nonce,
    key
  )
  return out
}

export function open(key: Buffer, sealed: Buffer, ad: string): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new DecryptError()
  const s = sodium()
  const nonce = sealed.subarray(0, NONCE_BYTES)
  const cipher = sealed.subarray(NONCE_BYTES)
  const out = Buffer.alloc(cipher.length - TAG_BYTES)
  try {
    s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      out,
      null,
      cipher,
      Buffer.from(ad, 'utf8'),
      nonce,
      key
    )
  } catch {
    throw new DecryptError()
  }
  return out
}
