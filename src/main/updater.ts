import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/updates'
import { describeUpdateError } from '../node-shared/update-errors'
import { verifyUpdateSignature } from '../node-shared/update-signature'
import { UPDATE_PUBLIC_KEYS } from './update-keys'

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

  constructor() {
    const configured = existsSync(join(process.resourcesPath, 'app-update.yml'))
    if (!app.isPackaged)
      this.status = {
        state: 'disabled',
        reason: 'Only available in installed builds (this is a development build).'
      }
    else if (!configured)
      this.status = { state: 'disabled', reason: 'This build has no release channel configured.' }
    else if (process.platform === 'linux' && UPDATE_PUBLIC_KEYS.length === 0)
      this.status = { state: 'disabled', reason: 'This build has no update signing key.' }
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
            message: `Update ${info.version} is not signed with a trusted key and was not downloaded.`
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
    // Đang chạy bản beta (x.y.z-beta.N) thì theo kênh beta — không thì sẽ không bao giờ thấy bản
    // beta mới hơn (chưa có bản stable nào).
    const beta = channel === 'beta' || app.getVersion().includes('-')
    autoUpdater.allowPrerelease = beta
    autoUpdater.channel = beta ? 'beta' : 'latest'
    // Từ beta quay về stable có thể là "hạ phiên bản".
    autoUpdater.allowDowngrade = !beta
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
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.fail(error)
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
