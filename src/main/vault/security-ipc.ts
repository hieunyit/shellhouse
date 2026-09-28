import { basename } from 'node:path'
import { app, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { Secret } from '../../node-shared/secret'
import { handle } from '../ipc/router'
import type { SettingsService } from '../settings'
import { backupDatabase, restoreBackup } from '../store/backup'
import type { Db } from '../store/db'
import type { StorePaths } from '../store'
import { inspectBackup } from '../store/restore'
import type { VaultController } from './controller'
import type { DeviceKeyStore } from './device-key'
import { runVaultOp } from './ipc'
import type { Vault } from './vault'

export interface SecurityIpcDeps {
  vault: Vault
  controller: VaultController
  deviceKeys: DeviceKeyStore
  settings: SettingsService
  db: () => Db | null
  paths: StorePaths
  window: () => BrowserWindow | null
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  /** Đóng DB trước khi thay file (khôi phục). */
  closeDb: () => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function registerSecurityIpc(deps: SecurityIpcDeps): void {
  const { vault, controller, deviceKeys, settings, isTrustedSender } = deps

  handle('vault:security', isTrustedSender, () => {
    const availability = deviceKeys.availability()
    return {
      rememberAvailable: availability.ok,
      rememberUnavailableReason: availability.ok ? null : availability.reason,
      rememberEnabled: settings.get().security.rememberOnDevice && deviceKeys.has()
    }
  })

  handle('vault:changePassword', isTrustedSender, (current, next) =>
    runVaultOp(current, (currentSecret) => {
      const nextSecret = Secret.fromString(next)
      return controller.changePassword(currentSecret, nextSecret).finally(() => {
        nextSecret.dispose()
      })
    })
  )

  handle('vault:setRemember', isTrustedSender, (enabled) => {
    try {
      if (enabled) controller.enableRemember()
      else controller.disableRemember()
      settings.update({ security: { rememberOnDevice: enabled } })
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, code: 'failed' as const, message: message(error) }
    }
  })

  handle('vault:exportBackup', isTrustedSender, async () => {
    const db = deps.db()
    if (!db) return { ok: false as const, message: 'Data is not ready yet' }
    const window = deps.window()
    const stamp = new Date().toISOString().slice(0, 10)
    const options = {
      title: 'Save backup',
      defaultPath: `shellhouse-${stamp}.shellhouse-backup`,
      filters: [{ name: 'Shellhouse backup', extensions: ['shellhouse-backup'] }]
    }
    const picked = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return null
    try {
      // Sao lưu online: mật khẩu/key trong file vẫn mã hoá bằng master password hiện tại.
      await db.backup(picked.filePath)
      return { ok: true as const, path: picked.filePath }
    } catch (error) {
      return { ok: false as const, message: message(error) }
    }
  })

  handle('vault:restoreBackup', isTrustedSender, async (password) => {
    const window = deps.window()
    const options = {
      title: 'Choose a backup',
      properties: ['openFile'] as 'openFile'[],
      filters: [
        { name: 'Shellhouse backup', extensions: ['shellhouse-backup', 'db'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return null

    const secret = Secret.fromString(password)
    const check = await inspectBackup(file, secret).finally(() => {
      secret.dispose()
    })
    if (!check.ok) return { ok: false as const, message: check.reason }

    const confirm = {
      type: 'warning' as const,
      title: 'Restore data',
      message: `Replace all current data with "${basename(file)}" (${check.hosts} host${check.hosts === 1 ? '' : 's'})?`,
      detail: 'A copy of your current data is kept in the backups folder. The app will restart.',
      buttons: ['Restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const answer = window
      ? await dialog.showMessageBox(window, confirm)
      : await dialog.showMessageBox(confirm)
    if (answer.response !== 0) return null

    const db = deps.db()
    if (db) await backupDatabase(db, deps.paths.backups, 'pre-restore')
    // Khoá lưu trên máy thuộc vault cũ → không còn dùng được.
    deviceKeys.clear()
    settings.update({ security: { rememberOnDevice: false } })
    vault.lock()
    deps.closeDb()
    restoreBackup(file, deps.paths.db)
    log.warn(`Restored data from ${file}; restarting`)
    app.relaunch()
    app.exit(0)
    return { ok: true as const, path: file }
  })
}
