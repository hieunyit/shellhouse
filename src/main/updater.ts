import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, session } from 'electron'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/updates'
import { describeUpdateError } from '../node-shared/update-errors'
import { verifyUpdateSignature } from '../node-shared/update-signature'
import { UPDATE_PUBLIC_KEYS } from './update-keys'
import { t } from '@shared/i18n'
import type { NetworkSettings } from '@shared/proxy'

/** URL proxy → luật của Chromium: bỏ thông tin đăng nhập, socks5h → socks5. */
function chromiumProxy(url: string): string {
  const u = new URL(url)
  const scheme = u.protocol.replace(/:$/, '').replace('socks5h', 'socks5')
  return `${scheme}://${u.host}`
}

/** user:pass trong URL proxy (đã giải mã) — null nếu không có. */
function proxyCredentials(url: string): { username: string; password: string } | null {
  const u = new URL(url)
  return u.username
    ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
    : null
}

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
    // Proxy cần đăng nhập (407): trả user:pass từ URL proxy tự nhập; không có thì để lỗi hiện ra.
    autoUpdater.on('login', (authInfo, callback) => {
      if (authInfo.isProxy && this.proxyLogin)
        callback(this.proxyLogin.username, this.proxyLogin.password)
      // Gọi không tham số = huỷ đăng nhập (Electron) — kiểu của electron-updater đòi đủ hai.
      else (callback as () => void)()
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

  /** Cài đặt mạng đã áp (so sánh để chỉ áp khi đổi). */
  private networkKey = ''
  /** Số phiên mạng đã tạo (mỗi lần đổi cài đặt một partition mới). */
  private sessions = 0
  /** Đăng nhập proxy (user:pass trong URL) — Chromium không nhận trong luật proxy, hỏi qua 'login'. */
  private proxyLogin: { username: string; password: string } | null = null

  /**
   * Proxy + bỏ qua lỗi chứng chỉ cho phiên mạng RIÊNG của electron-updater (không ảnh hưởng phần
   * còn lại của app). Bỏ qua chứng chỉ vẫn an toàn tương đối: bản cài còn được kiểm chữ ký (Windows:
   * nhà phát hành, macOS: ký app, Linux: chữ ký ed25519 của file kênh).
   *
   * Mỗi lần đổi cài đặt dùng một session MỚI: Chromium nhớ kết quả kiểm tra chứng chỉ theo session
   * (kể cả kết quả của setCertificateVerifyProc) — bật "bỏ qua" sau một lần kiểm tra lỗi sẽ không có
   * tác dụng tới khi khởi động lại app nếu dùng lại session cũ.
   */
  setNetwork(network: NetworkSettings): void {
    const key = JSON.stringify(network)
    if (key === this.networkKey) return
    this.networkKey = key
    const manual = network.proxyMode === 'manual' && network.proxyUrl !== ''
    const config: Electron.ProxyConfig =
      network.proxyMode === 'none'
        ? { mode: 'direct' }
        : manual
          ? {
              mode: 'fixed_servers',
              // Chromium nhận "scheme://host:port" (không nhận user:pass trong URL).
              proxyRules: chromiumProxy(network.proxyUrl),
              proxyBypassRules: network.noProxy
            }
          : { mode: 'system' }
    this.proxyLogin = manual ? proxyCredentials(network.proxyUrl) : null
    const net = session.fromPartition(`electron-updater-${String(++this.sessions)}`, {
      cache: false
    })
    void net.setProxy(config).catch((error: unknown) => {
      log.scope('updater').warn('Could not set the update proxy', error)
    })
    if (network.updatesInsecure)
      net.setCertificateVerifyProc((_request, callback) => {
        callback(0)
      })
    // electron-updater giữ session trong httpExecutor.cachedSession (tạo lần đầu từ partition cố
    // định "electron-updater") — thay bằng session mới.
    const executor = (autoUpdater as unknown as { httpExecutor?: { cachedSession?: unknown } })
      .httpExecutor
    if (executor && 'cachedSession' in executor) executor.cachedSession = net
    else log.scope('updater').warn('electron-updater changed: network settings not applied')
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
