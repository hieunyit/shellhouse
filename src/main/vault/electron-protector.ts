import { safeStorage } from 'electron'
import type { KeyProtector } from './device-key'

/** safeStorage của Electron. Trên Linux không có Secret Service thì chỉ là "basic_text" → từ chối. */
export const electronProtector: KeyProtector = {
  available: () => {
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        ok: false,
        reason: 'The operating system does not provide a keychain to store the key securely.'
      }
    }
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend()
      if (backend === 'basic_text' || backend === 'unknown') {
        return {
          ok: false,
          reason:
            'No secure keychain found (GNOME Keyring / KWallet). The key would only be obfuscated, not encrypted, so this option is disabled.'
        }
      }
    }
    return { ok: true }
  },
  encrypt: (data) => safeStorage.encryptString(data.toString('base64')),
  decrypt: (data) => Buffer.from(safeStorage.decryptString(data), 'base64')
}
