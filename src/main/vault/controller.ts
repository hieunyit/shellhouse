import type { AppSettings } from '@shared/settings'
import type { Secret } from '../../node-shared/secret'
import type { DeviceKeyStore } from './device-key'
import { InvalidDeviceKeyError, type Vault } from './vault'

export type LockReason = 'idle' | 'suspend' | 'lock-screen' | 'manual'

/** Có nên tự khoá theo thời gian máy rảnh không. */
export function idleLockDue(idleSeconds: number, autoLockMinutes: number): boolean {
  return autoLockMinutes > 0 && idleSeconds >= autoLockMinutes * 60
}

/**
 * Điều phối vault với cài đặt bảo mật: tự mở bằng khoá lưu trên máy khi khởi động, tự khoá khi
 * máy rảnh / ngủ / khoá màn hình, bật/tắt "nhớ trên máy này".
 */
export class VaultController {
  constructor(
    private readonly vault: Vault,
    private readonly deviceKeys: DeviceKeyStore,
    private readonly getSettings: () => AppSettings,
    private readonly log: (message: string) => void = () => undefined
  ) {}

  /** Gọi một lần khi khởi động. true nếu đã tự mở. */
  tryAutoUnlock(): boolean {
    if (!this.getSettings().security.rememberOnDevice || this.vault.state() !== 'locked')
      return false
    const dek = this.deviceKeys.load()
    if (!dek) return false
    try {
      this.vault.unlockWithKey(dek)
      return true
    } catch (error) {
      if (error instanceof InvalidDeviceKeyError) {
        this.log(
          'The key stored on this device is invalid — removing it and asking for the master password'
        )
        this.deviceKeys.clear()
        return false
      }
      throw error
    }
  }

  /** Bật "nhớ trên máy này": cần vault đang mở. */
  enableRemember(): void {
    const dek = this.vault.exportKey()
    try {
      this.deviceKeys.save(dek)
    } finally {
      dek.fill(0)
    }
  }

  /** Tắt: xoá khoá khỏi máy ngay. */
  disableRemember(): void {
    this.deviceKeys.clear()
  }

  /** Gọi định kỳ với thời gian máy rảnh (giây). */
  onIdle(idleSeconds: number): boolean {
    if (this.vault.state() !== 'unlocked') return false
    if (!idleLockDue(idleSeconds, this.getSettings().security.autoLockMinutes)) return false
    this.lock('idle')
    return true
  }

  onPowerEvent(event: 'suspend' | 'lock-screen'): boolean {
    if (this.vault.state() !== 'unlocked' || !this.getSettings().security.lockOnSuspend)
      return false
    this.lock(event)
    return true
  }

  lock(reason: LockReason): void {
    this.log(`Locking vault (${reason})`)
    this.vault.lock()
  }

  async changePassword(current: Secret, next: Secret): Promise<void> {
    await this.vault.changePassword(current, next)
  }
}
