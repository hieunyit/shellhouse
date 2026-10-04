import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { screen, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { t } from '@shared/i18n'
import type { RdpNativeAvailability, RdpNativeEvent } from '@shared/rdp-native'
import type { HostService } from '../hosts/service'
import { handle } from '../ipc/router'
import { RdpNativeController } from './controller'
import { helperCandidates, hwndOf } from './locate'

export interface RdpNativeIpcOptions {
  hosts: () => HostService
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  getWindow: () => BrowserWindow | null
  emit: (event: RdpNativeEvent) => void
  notifyChanged: () => void
  packaged: boolean
  resourcesPath: string
  appPath: string
  /**
   * Chỉ E2E (SHELLHOUSE_TEST_HOOKS): null = tắt engine native (test IronRDP giữ nguyên trên Windows);
   * 'selftest' = tiến trình phụ chạy chế độ giả; 'real' = control thật.
   */
  testMode: 'selftest' | 'real' | null
  testHooks: boolean
}

/** Biến toàn cục cho E2E (Playwright `app.evaluate`) — chỉ khi bật test hooks. */
export const RDP_NATIVE_TEST_GLOBAL = '__shellhouseRdpNative'

/** IPC Remote Desktop bằng control gốc của Windows (rdpNative:*). Trả controller để dọn khi thoát. */
export function registerRdpNativeIpc(options: RdpNativeIpcOptions): RdpNativeController {
  const scoped = log.scope('rdp-native')
  const candidates = helperCandidates({
    packaged: options.packaged,
    resourcesPath: options.resourcesPath,
    appPath: options.appPath,
    override: options.packaged ? undefined : process.env['SHELLHOUSE_RDP_HOST_EXE']
  })
  let found: string | null | undefined
  const helperPath = (): string | null => {
    // Dò lại khi lần trước chưa có (bản dev vừa build xong tiến trình phụ).
    if (!found) found = candidates.find((p) => existsSync(p)) ?? null
    return found
  }

  const availability = (): RdpNativeAvailability => {
    if (process.platform !== 'win32')
      return {
        available: false,
        reason: t('The native Remote Desktop control is only available on Windows')
      }
    if (options.testHooks && !options.testMode)
      return { available: false, reason: 'disabled in tests' }
    if (!helperPath())
      return {
        available: false,
        reason: t('The native Remote Desktop helper is not installed — using the built-in viewer')
      }
    return { available: true, reason: null }
  }

  const hooked = new WeakSet<BrowserWindow>()
  const controller: RdpNativeController = new RdpNativeController({
    resolve: (hostId, touch) => options.hosts().resolveRdp(hostId, touch),
    spawn: (args) => {
      const exe = helperPath()
      if (!exe) throw new Error(t('The native Remote Desktop helper is not installed'))
      return spawn(exe, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    },
    parentHandle: () => {
      const win = options.getWindow()
      if (!win || win.isDestroyed()) return null
      if (!hooked.has(win)) {
        hooked.add(win)
        // Cửa sổ đóng / renderer nạp lại / chết: cửa sổ native không được ở lại trên giao diện mới.
        const dispose = (): void => {
          controller.disposeAll()
        }
        win.on('closed', dispose)
        win.webContents.on('did-start-loading', dispose)
        win.webContents.on('render-process-gone', dispose)
      }
      return hwndOf(win.getNativeWindowHandle())
    },
    contentSize: () => {
      const win = options.getWindow()
      if (!win || win.isDestroyed()) return null
      const b = win.getContentBounds()
      const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor
      return { width: Math.round(b.width * scale), height: Math.round(b.height * scale) }
    },
    emit: options.emit,
    focusApp: () => {
      const win = options.getWindow()
      if (win && !win.isDestroyed()) win.webContents.focus()
    },
    log: scoped,
    selftest: options.testMode === 'selftest'
  })

  handle('rdpNative:available', options.isTrustedSender, () => availability())
  handle('rdpNative:prepare', options.isTrustedSender, (hostId) => controller.prepare(hostId))
  handle('rdpNative:open', options.isTrustedSender, async (request) => {
    if (!availability().available)
      return { ok: false, message: t('The native Remote Desktop control is not available') }
    const result = await controller.open(request)
    options.notifyChanged() // "dùng gần nhất"
    return result
  })
  handle('rdpNative:bounds', options.isTrustedSender, (sessionId, viewport) => {
    controller.bounds(sessionId, viewport)
  })
  handle('rdpNative:overlay', options.isTrustedSender, (sessionId, overlay) => {
    controller.overlay(sessionId, overlay)
  })
  handle('rdpNative:snapshot', options.isTrustedSender, (sessionId) =>
    controller.snapshot(sessionId)
  )
  handle('rdpNative:command', options.isTrustedSender, (sessionId, command) => {
    controller.command(sessionId, command)
  })
  handle('rdpNative:close', options.isTrustedSender, (sessionId) => {
    controller.close(sessionId)
  })

  if (options.testHooks)
    (globalThis as Record<string, unknown>)[RDP_NATIVE_TEST_GLOBAL] = {
      inspect: () => controller.inspect()
    }
  return controller
}
