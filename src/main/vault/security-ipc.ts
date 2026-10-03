import { basename } from 'node:path'
import { app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { Secret } from '../../node-shared/secret'
import { showMessageBox, showOpenDialog, showSaveDialog } from '../dialogs'
import { handle } from '../ipc/router'
import type { SettingsService } from '../settings'
import { backupDatabase, restoreBackup } from '../store/backup'
import type { Db } from '../store/db'
import type { StorePaths } from '../store'
import { inspectBackup } from '../store/restore'
import type { VaultController } from './controller'
import type { DeviceKeyStore } from './device-key'
import { runVaultOp } from './ipc'
import { WrongPasswordError, type Vault } from './vault'
import { t, tn } from '@shared/i18n'

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

  handle('vault:setRemember', isTrustedSender, async (enabled, password) => {
    if (!enabled) {
      try {
        controller.disableRemember()
        settings.update({ security: { rememberOnDevice: false } })
        return { ok: true as const }
      } catch (error) {
        return { ok: false as const, code: 'failed' as const, message: message(error) }
      }
    }
    // Bật = ai mở máy cũng vào được vault → phải nhập lại master password (vault đang mở thôi
    // chưa đủ: người khác có thể đang ngồi trước máy chưa khoá).
    if (!password)
      return {
        ok: false as const,
        code: 'wrong-password' as const,
        message: t('Enter the master password')
      }
    return runVaultOp(password, async (secret) => {
      if (!(await vault.verifyPassword(secret))) throw new WrongPasswordError()
      controller.enableRemember()
      settings.update({ security: { rememberOnDevice: true } })
    })
  })

  handle('vault:exportBackup', isTrustedSender, async () => {
    const db = deps.db()
    if (!db) return { ok: false as const, message: t('Data is not ready yet') }
    const window = deps.window()
    const stamp = new Date().toISOString().slice(0, 10)
    const options = {
      title: t('Save backup'),
      defaultPath: `shellhouse-${stamp}.shellhouse-backup`,
      filters: [{ name: t('Shellhouse backup'), extensions: ['shellhouse-backup'] }]
    }
    const picked = await showSaveDialog(window, options)
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
      title: t('Choose a backup'),
      properties: ['openFile'] as 'openFile'[],
      filters: [
        { name: t('Shellhouse backup'), extensions: ['shellhouse-backup', 'db'] },
        { name: t('All files'), extensions: ['*'] }
      ]
    }
    const picked = await showOpenDialog(window, options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return null

    const secret = Secret.fromString(password)
    const check = await inspectBackup(file, secret).finally(() => {
      secret.dispose()
    })
    if (!check.ok) return { ok: false as const, message: check.reason }

    const confirm = {
      type: 'warning' as const,
      title: t('Restore data'),
      message: tn(
        check.hosts,
        'Replace all current data with "{file}" ({n} host)?',
        'Replace all current data with "{file}" ({n} hosts)?',
        { file: basename(file) }
      ),
      detail: t('A copy of your current data is kept in the backups folder. The app will restart.'),
      buttons: [t('Restore'), t('Cancel')],
      defaultId: 1,
      cancelId: 1
    }
    const answer = await showMessageBox(window, confirm)
    if (answer.response !== 0) return null

    const db = deps.db()
    if (db) await backupDatabase(db, deps.paths.backups, 'pre-restore')
    // Khoá lưu trên máy thuộc vault cũ → không còn dùng được.
    deviceKeys.clear()
    settings.update({ security: { rememberOnDevice: false } })
    vault.lock()
    deps.closeDb()
    // DB đã đóng: dù chép lỗi (file cũ còn nguyên nhờ chép tạm rồi đổi tên) vẫn phải khởi động
    // lại — không thì app mất DB và chết đứng.
    try {
      restoreBackup(file, deps.paths.db)
      log.warn(`Restored data from ${file}; restarting`)
    } catch (error) {
      log.error(`Could not restore ${file}; restarting with the current data`, error)
    } finally {
      app.relaunch()
      app.exit(0)
    }
    return { ok: true as const, path: file }
  })
}
