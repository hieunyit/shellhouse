// Chỉ khai báo phần API đang dùng. Bổ sung khi dùng thêm.
declare module 'sodium-native' {
  export const crypto_aead_xchacha20poly1305_ietf_ABYTES: number
  export const crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number
  export const crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number
  // sodium_malloc cố ý không khai báo: không chạy được trong Electron (V8 memory cage).
  export function sodium_memzero(buf: Buffer): void
  export function randombytes_buf(buf: Buffer): void
  export function sodium_memcmp(a: Buffer, b: Buffer): boolean
  export const crypto_pwhash_ALG_ARGON2ID13: number
  export const crypto_pwhash_SALTBYTES: number
  export const crypto_pwhash_OPSLIMIT_MIN: number
  export const crypto_pwhash_MEMLIMIT_MIN: number
  export function crypto_pwhash_async(
    out: Buffer,
    passwd: Buffer,
    salt: Buffer,
    opslimit: number,
    memlimit: number,
    alg: number
  ): Promise<void>
  export function crypto_aead_xchacha20poly1305_ietf_encrypt(
    c: Buffer,
    m: Buffer,
    ad: Buffer | null,
    nsec: null,
    npub: Buffer,
    k: Buffer
  ): number
  export function crypto_aead_xchacha20poly1305_ietf_decrypt(
    m: Buffer,
    nsec: null,
    c: Buffer,
    ad: Buffer | null,
    npub: Buffer,
    k: Buffer
  ): number
}
