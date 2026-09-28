import type { NativeModuleStatus } from '@shared/ipc'
import { loadNative } from './native'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Nạp và chạy thử native module dùng trong main (store + vault). */
export function checkMainNativeModules(): NativeModuleStatus[] {
  const results: NativeModuleStatus[] = []

  try {
    const Database = loadNative('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(':memory:')
    const row = db.prepare('select sqlite_version() as v').get() as { v: string }
    db.close()
    results.push({ name: 'better-sqlite3', process: 'main', ok: true, detail: `SQLite ${row.v}` })
  } catch (error) {
    results.push({ name: 'better-sqlite3', process: 'main', ok: false, detail: errorText(error) })
  }

  try {
    const sodium = loadNative('sodium-native') as typeof import('sodium-native')
    // Không dùng sodium_malloc: V8 memory cage của Electron cấm buffer ngoài heap.
    // Secret giữ trong Buffer thường và phải sodium_memzero ngay khi dùng xong.
    const key = Buffer.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
    const nonce = Buffer.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
    sodium.randombytes_buf(key)
    sodium.randombytes_buf(nonce)
    const plain = Buffer.from('shellhouse')
    const cipher = Buffer.alloc(plain.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(cipher, plain, null, null, nonce, key)
    const back = Buffer.alloc(plain.length)
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(back, null, cipher, null, nonce, key)
    sodium.sodium_memzero(key)
    const ok = back.equals(plain)
    results.push({
      name: 'sodium-native',
      process: 'main',
      ok,
      detail: ok ? 'XChaCha20-Poly1305 round-trip OK' : 'Round-trip sai'
    })
  } catch (error) {
    results.push({ name: 'sodium-native', process: 'main', ok: false, detail: errorText(error) })
  }

  return results
}
