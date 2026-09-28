import { describe, expect, it } from 'vitest'
import { applyPatch, DEFAULT_SETTINGS, type AppSettings } from '@shared/settings'
import { Secret } from '../../src/node-shared/secret'
import { DeviceKeyStore, type KeyProtector } from '../../src/main/vault/device-key'
import { idleLockDue, VaultController } from '../../src/main/vault/controller'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { Vault } from '../../src/main/vault/vault'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'

/** "Keychain" giả: XOR với một byte — đủ để kiểm tra luồng, và có thể giả lập hỏng. */
function fakeProtector(state: { ok: boolean; key: number }): KeyProtector {
  return {
    available: () => (state.ok ? { ok: true } : { ok: false, reason: 'không có keychain' }),
    encrypt: (d) => Buffer.from(d.map((b) => b ^ state.key)),
    decrypt: (d) => Buffer.from(d.map((b) => b ^ state.key))
  }
}

async function setup(settings: Partial<AppSettings['security']> = {}) {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  const keychain = { ok: true, key: 0x5a }
  const store = new DeviceKeyStore(db, fakeProtector(keychain))
  let current = applyPatch(DEFAULT_SETTINGS, { security: settings })
  const controller = new VaultController(vault, store, () => current)
  const setSettings = (s: Partial<AppSettings['security']>): void => {
    current = applyPatch(current, { security: s })
  }
  return { db, vault, store, keychain, controller, setSettings }
}

describe('idleLockDue', () => {
  it('0 = tắt; đủ phút thì khoá', () => {
    expect(idleLockDue(10_000, 0)).toBe(false)
    expect(idleLockDue(14 * 60, 15)).toBe(false)
    expect(idleLockDue(15 * 60, 15)).toBe(true)
  })
})

describe('VaultController', () => {
  it('nhớ trên máy: khởi động lại thì tự mở; tắt thì khoá lưu bị xoá', async () => {
    const { vault, store, controller } = await setup({ rememberOnDevice: true })
    controller.enableRemember()
    expect(store.has()).toBe(true)
    vault.lock()
    expect(controller.tryAutoUnlock()).toBe(true)
    expect(vault.state()).toBe('unlocked')

    controller.disableRemember()
    vault.lock()
    expect(controller.tryAutoUnlock()).toBe(false)
    expect(vault.state()).toBe('locked')
  })

  it('không tự mở nếu cài đặt tắt, dù có khoá lưu', async () => {
    const { vault, controller, setSettings } = await setup({ rememberOnDevice: true })
    controller.enableRemember()
    setSettings({ rememberOnDevice: false })
    vault.lock()
    expect(controller.tryAutoUnlock()).toBe(false)
  })

  it('keychain đổi (khoá giải ra sai) → xoá khoá lưu, yêu cầu password', async () => {
    const { vault, store, keychain, controller } = await setup({ rememberOnDevice: true })
    controller.enableRemember()
    vault.lock()
    keychain.key = 0x11 // giả lập DB chép sang máy khác
    expect(controller.tryAutoUnlock()).toBe(false)
    expect(store.has()).toBe(false)
    expect(vault.state()).toBe('locked')
  })

  it('không có keychain an toàn → không bật được, nêu lý do', async () => {
    const { keychain, controller } = await setup()
    keychain.ok = false
    expect(() => {
      controller.enableRemember()
    }).toThrow(/không có keychain/)
  })

  it('tự khoá khi máy rảnh đủ lâu và khi ngủ (nếu bật)', async () => {
    const { vault, controller, setSettings } = await setup({
      autoLockMinutes: 5,
      lockOnSuspend: true
    })
    expect(controller.onIdle(60)).toBe(false)
    expect(controller.onIdle(5 * 60)).toBe(true)
    expect(vault.state()).toBe('locked')
    await vault.unlock(Secret.fromString('master-password'))
    setSettings({ lockOnSuspend: false })
    expect(controller.onPowerEvent('suspend')).toBe(false)
    setSettings({ lockOnSuspend: true })
    expect(controller.onPowerEvent('lock-screen')).toBe(true)
    expect(vault.state()).toBe('locked')
  })

  it('khoá lưu trên máy không phải DEK dạng rõ trong DB', async () => {
    const { db, vault, controller } = await setup({ rememberOnDevice: true })
    controller.enableRemember()
    const dek = vault.exportKey()
    const row = db.prepare("SELECT value FROM settings WHERE key = 'vault.deviceKey'").get() as {
      value: string
    }
    expect(Buffer.from(row.value, 'base64').equals(dek)).toBe(false)
  })
})
