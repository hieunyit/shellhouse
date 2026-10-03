import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/updates'
import { describeUpdateError } from '../node-shared/update-errors'
import { verifyUpdateSignature } from '../node-shared/update-signature'
import { UPDATE_PUBLIC_KEYS } from './update-keys'
import { t } from '@shared/i18n'

/**
 * Cập nhật tự động qua electron-updater.
 * - Chỉ chạy ở bản đã đóng gói có cấu hình phát hành (app-update.yml do electron-builder tạo).
 * - Không tự tải: người dùng bấm "Tải về" rồi "Khởi động lại để cập nhật".
 * - Toàn vẹn: sha512 trong file kênh (HTTPS); Windows kiểm tra chữ ký nhà phát hành, macOS yêu cầu
 *   app được ký. Linux: file kênh phải có chữ ký ed25519 hợp lệ (ADR-0008), không thì từ chối.
 */
export class Updater {
  private status: UpdateStatus
  private readonly listeners = new Set<(s: UpdateStatus) => void>()
  /** Phiên bản đã qua kiểm tra chữ ký (Linux); chỉ phiên bản này được phép tải. */
  private verifiedVersion: string | null = null
  /** Kênh người dùng chọn lần gần nhất (null = chưa đặt). */
  private requestedChannel: 'stable' | 'beta' | null = null
  /** Vừa chuyển beta → stable trong phiên này: cho phép hạ phiên bản ĐÚNG MỘT lần kiểm tra. */
  private downgradeOnce = false
  /**
   * Tăng mỗi lần setChannel bật downgradeOnce: chỉ lần kiểm tra BẮT ĐẦU sau lúc đó mới được dùng
   * (và xoá) quyền hạ phiên bản — lần kiểm tra định kỳ đang chạy dở không xoá mất nó.
   */
  private downgradeToken = 0
  /** Lần kiểm tra đang chạy (electron-updater gộp lần gọi trùng vào lần đang chạy → nối đuôi). */
  private checking: Promise<void> | null = null

  constructor() {
    const configured = existsSync(join(process.resourcesPath, 'app-update.yml'))
    if (!app.isPackaged)
      this.status = {
        state: 'disabled',
        reason: t('Only available in installed builds (this is a development build).')
      }
    else if (!configured)
      this.status = {
        state: 'disabled',
        reason: t('This build has no release channel configured.')
      }
    else if (process.platform === 'linux' && UPDATE_PUBLIC_KEYS.length === 0)
      this.status = { state: 'disabled', reason: t('This build has no update signing key.') }
    else this.status = { state: 'idle' }

    autoUpdater.logger = log.scope('updater')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => {
      this.set({ state: 'checking' })
    })
    autoUpdater.on('update-not-available', () => {
      this.set({ state: 'none', checkedAt: Date.now() })
    })
    autoUpdater.on('update-available', (info) => {
      if (process.platform === 'linux') {
        const signature = (info as unknown as Record<string, unknown>)['shellhouseSignature']
        const ok = verifyUpdateSignature(info.version, info.files, signature, UPDATE_PUBLIC_KEYS)
        if (!ok) {
          this.verifiedVersion = null
          log.warn(`Rejected update ${info.version}: missing or invalid signature`)
          this.set({
            state: 'error',
            message: t(
              'Update {version} is not signed with a trusted key and was not downloaded.',
              { version: info.version }
            )
          })
          return
        }
      }
      this.verifiedVersion = info.version
      this.set({ state: 'available', version: info.version })
    })
    autoUpdater.on('download-progress', (p) => {
      this.set({ state: 'downloading', percent: Math.floor(p.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ state: 'ready', version: info.version })
    })
    autoUpdater.on('error', (error) => {
      this.fail(error)
    })
  }

  get enabled(): boolean {
    return this.status.state !== 'disabled'
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  onStatus(listener: (s: UpdateStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setChannel(channel: 'stable' | 'beta'): void {
    // Gọi lại mỗi khi bất kỳ cài đặt nào đổi — chỉ xử lý khi kênh thật sự đổi.
    if (channel === this.requestedChannel) return
    // Người dùng chủ động từ beta về stable: lần kiểm tra kế tiếp được về bản stable dù số phiên
    // bản thấp hơn. Ngoài trường hợp đó KHÔNG BAO GIỜ hạ phiên bản (file kênh bị thay bằng bản cũ
    // có lỗ hổng → không cài lùi).
    if (this.requestedChannel === 'beta' && channel === 'stable') {
      this.downgradeOnce = true
      this.downgradeToken++
    }
    this.requestedChannel = channel
    // Đang chạy bản beta (x.y.z-beta.N) thì theo kênh beta — không thì sẽ không bao giờ thấy bản
    // beta mới hơn (chưa có bản stable nào). Trừ khi vừa chủ động chọn về stable.
    const beta = channel === 'beta' || (!this.downgradeOnce && app.getVersion().includes('-'))
    if (beta) this.downgradeOnce = false
    autoUpdater.allowPrerelease = beta
    autoUpdater.channel = beta ? 'beta' : 'latest'
    // Setter `channel` của electron-updater tự bật allowDowngrade → phải đặt lại SAU nó.
    autoUpdater.allowDowngrade = this.downgradeOnce
  }

  /** Lỗi đầy đủ (URL, header, stack) chỉ vào log; người dùng thấy một câu ngắn. */
  private fail(error: unknown): void {
    log.scope('updater').warn(error)
    const outcome = describeUpdateError(error)
    if (outcome.kind === 'none') this.set({ state: 'none', checkedAt: Date.now() })
    else this.set({ state: 'error', message: outcome.message })
  }

  async check(): Promise<void> {
    if (!this.enabled) return
    // Lần đang chạy có thể bắt đầu trước khi đổi kênh (cấu hình cũ) → chờ nó xong rồi kiểm tra lại.
    while (this.checking) await this.checking
    const run = this.runCheck()
    this.checking = run
    try {
      await run
    } finally {
      if (this.checking === run) this.checking = null
    }
  }

  private async runCheck(): Promise<void> {
    // Lần này dùng quyền hạ phiên bản nào (null = không có).
    const token = this.downgradeOnce ? this.downgradeToken : null
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.fail(error)
    } finally {
      // Quyền hạ phiên bản chỉ dùng cho một lần kiểm tra (bản tìm được đã nằm trong updateInfo) —
      // và chỉ lần kiểm tra bắt đầu SAU khi người dùng đổi kênh mới được xoá nó.
      if (token !== null && token === this.downgradeToken) {
        this.downgradeOnce = false
        autoUpdater.allowDowngrade = false
      }
    }
  }

  async download(): Promise<void> {
    if (this.status.state !== 'available' || this.status.version !== this.verifiedVersion) return
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.fail(error)
    }
  }

  install(): void {
    if (this.status.state === 'ready') autoUpdater.quitAndInstall()
  }

  private set(status: UpdateStatus): void {
    this.status = status
    for (const l of this.listeners) l(status)
  }
}
