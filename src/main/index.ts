import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  MessageChannelMain,
  nativeTheme,
  powerMonitor,
  shell as electronShell,
  type IpcMainInvokeEvent
} from 'electron'
import log from 'electron-log/main'
import { SESSION_PORT_CHANNEL } from '@shared/constants'
import type { EventChannel, EventPayload } from '@shared/ipc'
import { toForwardSpec } from '@shared/forwards'
import { checkMainNativeModules } from './diagnostics'
import { handle } from './ipc/router'
import { installAppMenu, installDevToolsShortcut } from './app-menu'
import { installEditContextMenu } from './context-menu'
import { listLocal } from './local-files'
import { openInEditor, RemoteEditFiles } from './remote-edit'
import { sessionLogFor } from './session-log-path'
import { ShellService } from './shells'
import { installGlobalGuards, secureWebPreferences } from './security'
import { isAppUrl } from './security-policy'
import { spawnElectronHost } from './session-host/electron-spawn'
import { SessionHostSupervisor } from './session-host/supervisor'
import { CorruptDatabaseError, openStore, storePaths, type Db } from './store'
import { restoreBackup } from './store/backup'
import { NewerSchemaError } from './store/migrate'
import { KnownHosts } from './known-hosts'
import { registerHostIpc } from './hosts/ipc'
import { HostService } from './hosts/service'
import { SnippetService } from './snippets'
import { SettingsService } from './settings'
import { DEFAULT_KDF, TEST_KDF } from './vault/crypto'
import { runVaultOp } from './vault/ipc'
import { Vault } from './vault/vault'
import { VaultController } from './vault/controller'
import { DeviceKeyStore } from './vault/device-key'
import { electronProtector } from './vault/electron-protector'
import { registerSecurityIpc } from './vault/security-ipc'
import { Updater } from './updater'

log.initialize()
log.transports.file.level = 'info'

const devServerUrl = process.env['ELECTRON_RENDERER_URL']
/** Bật các IPC chỉ dành cho test (giết Session Host...). Không bao giờ bật trên bản phát hành. */
const testHooks = !app.isPackaged && process.env['SHELLHOUSE_TEST_HOOKS'] === '1'

// Mỗi lần khởi chạy E2E dùng thư mục dữ liệu riêng để không đụng dữ liệu thật.
const userDataOverride = process.env['SHELLHOUSE_USER_DATA']
if (!app.isPackaged && userDataOverride) app.setPath('userData', userDataOverride)
// Thư mục home giả cho E2E (~/.ssh/config…). Trên Windows Electron không đọc biến HOME.
const homeOverride = process.env['SHELLHOUSE_HOME']
if (!app.isPackaged && homeOverride) app.setPath('home', homeOverride)

process.on('uncaughtException', (error) => {
  log.error('uncaughtException', error)
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', reason)
})

let mainWindow: BrowserWindow | null = null

/** User mặc định cho jump host không ghi user (như OpenSSH: user đang đăng nhập). */
function localUser(): string {
  return process.env['USER'] ?? process.env['USERNAME'] ?? 'root'
}

/**
 * Chỉ cho E2E: tuỳ chọn thêm cho `ssh` hệ thống (ví dụ UserKnownHostsFile tạm để không đụng
 * ~/.ssh/known_hosts thật). Không bao giờ có hiệu lực trên bản phát hành.
 */
const systemSshTestOptions: string[] | null = (() => {
  if (!testHooks) return null
  const raw = process.env['SHELLHOUSE_TEST_SSH_OPTIONS']
  if (!raw) return null
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : null
})()
let db: Db | null = null
let vault: Vault | null = null
let knownHosts: KnownHosts | null = null
let hosts: HostService | null = null
let snippets: SnippetService | null = null
let settings: SettingsService | null = null
let vaultController: VaultController | null = null
let deviceKeys: DeviceKeyStore | null = null
let updater: Updater | null = null

const shells = new ShellService()
/** Bản sao tạm khi sửa file trên server — trong userData để mỗi hồ sơ (và E2E) tách biệt. */
const remoteEdits = new RemoteEditFiles(join(app.getPath('userData'), 'remote-edit'))
const supervisor = new SessionHostSupervisor({
  spawn: spawnElectronHost,
  logger: log.scope('supervisor')
})

function send<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame || !mainWindow || event.sender !== mainWindow.webContents) return false
  // Chỉ frame gốc; app không dùng iframe nên frame con nào gửi IPC cũng là bất thường.
  if (frame.parent !== null) return false
  return isAppUrl(frame.url, devServerUrl)
}

function defaultLogDirectory(): string {
  return join(app.getPath('documents'), 'Shellhouse logs')
}

/** Thư mục log đang dùng (cài đặt hoặc mặc định). */
function logDirectory(): string {
  return settings?.get().logging.directory.trim() || defaultLogDirectory()
}

function requireHosts(): HostService {
  if (!hosts) throw new Error('Data is not ready yet')
  return hosts
}

function requireVault(): Vault {
  if (!vault) throw new Error('The vault is not ready yet')
  return vault
}

/**
 * Mở DB. File hỏng → hỏi khôi phục từ bản sao lưu mới nhất chưa thử (file hỏng được giữ lại).
 * Trả về null nếu không mở được và người dùng chọn thoát.
 */
async function openStoreInteractive(): Promise<Db | null> {
  const paths = storePaths(app.getPath('userData'))
  const tried = new Set<string>()
  for (;;) {
    try {
      return await openStore(paths)
    } catch (error) {
      if (error instanceof NewerSchemaError) {
        dialog.showErrorBox('Could not open your data', error.message)
        return null
      }
      if (!(error instanceof CorruptDatabaseError)) throw error
      log.error(error.message)
      const candidate = error.backups.find((b) => !tried.has(b.path))
      if (!candidate) {
        dialog.showErrorBox(
          'Data is corrupted',
          `The file ${error.dbPath} is corrupted and no usable backup is left.`
        )
        return null
      }
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Data is corrupted',
        message: 'The Shellhouse data file is corrupted.',
        detail:
          `Restore the backup from ${new Date(candidate.createdAt).toLocaleString()}?\n` +
          'The corrupted file is kept next to it for inspection.',
        buttons: ['Restore', 'Quit'],
        defaultId: 0,
        cancelId: 1
      })
      if (response !== 0) return null
      tried.add(candidate.path)
      restoreBackup(candidate.path, paths.db)
      log.warn(`Restored from ${candidate.path}`)
    }
  }
}

function registerIpc(): void {
  handle('app:getInfo', isTrustedSender, () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    testHooks,
    windowsBuild: process.platform === 'win32' ? Number(release().split('.')[2]) || null : null
  }))

  handle('sessionHost:getStatus', isTrustedSender, () => supervisor.getStatus())

  handle('diagnostics:nativeModules', isTrustedSender, async () => {
    const main = checkMainNativeModules()
    try {
      return [...main, ...(await supervisor.selfCheck())]
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return [
        ...main,
        { name: 'session-host', process: 'session-host' as const, ok: false, detail }
      ]
    }
  })

  handle('session:open', isTrustedSender, async (spec) => {
    const window = mainWindow
    if (!window) throw new Error('No window')
    const sessionId = randomUUID()
    const { port1, port2 } = new MessageChannelMain()
    const logFor = (kind: 'local' | 'ssh', label: string) =>
      sessionLogFor(requireSettings().get().logging, { kind, label }, defaultLogDirectory()) ??
      undefined
    if (spec.kind === 'local') {
      const shell = await shells.resolve(
        spec.shellId,
        requireSettings().get().terminal.defaultShell
      )
      supervisor.openSession(
        sessionId,
        {
          kind: 'local',
          cols: spec.cols,
          rows: spec.rows,
          ...(shell ? { shell: { file: shell.file, args: shell.args } } : {})
        },
        port1,
        undefined,
        logFor('local', shell?.name ?? 'Local terminal')
      )
    } else {
      // Host đã lưu: giải mã thông tin xác thực ngay tại main, không đi qua renderer.
      const resolved =
        spec.kind === 'host' ? requireHosts().resolveForConnect(spec.hostId, localUser()) : null
      const target = resolved ? resolved.target : spec.kind === 'ssh' ? spec.target : null
      if (!target) throw new Error('Invalid session spec')
      const size = { cols: spec.cols, rows: spec.rows }
      const log = logFor(
        'ssh',
        `${target.username}@${target.host}${target.port === 22 ? '' : `-${target.port}`}`
      )
      if (resolved?.mode === 'system') {
        supervisor.openSession(
          sessionId,
          {
            kind: 'system-ssh',
            ...size,
            target,
            jumps: resolved.jumps.map((j) => j.target),
            keyFile: resolved.keyFile,
            ...(systemSshTestOptions ? { testOptions: systemSshTestOptions } : {})
          },
          port1,
          undefined,
          log
        )
      } else {
        const known = (t: { host: string; port: number }): string[] =>
          knownHosts?.knownKeyTypes(t.host, t.port) ?? []
        const autoForwards =
          spec.kind === 'host'
            ? requireHosts()
                .listForwards(spec.hostId)
                .filter((f) => f.autoStart)
                .map(toForwardSpec)
            : []
        const ssh = {
          knownKeyTypes: known(target),
          ...(autoForwards.length > 0 ? { autoForwards } : {}),
          ...(resolved ? { credentials: resolved.credentials } : {}),
          ...(resolved?.keyFiles ? { keyFiles: resolved.keyFiles } : {}),
          ...(resolved?.legacyAlgorithms ? { legacyAlgorithms: true } : {}),
          ...(resolved?.storedOnly ? { storedOnly: true } : {}),
          ...(resolved && resolved.jumps.length > 0
            ? {
                jumps: resolved.jumps.map((j) => ({
                  target: j.target,
                  knownKeyTypes: known(j.target),
                  credentials: j.credentials,
                  ...(j.keyFiles ? { keyFiles: j.keyFiles } : {}),
                  ...(j.legacyAlgorithms ? { legacyAlgorithms: true } : {}),
                  ...(j.storedOnly ? { storedOnly: true } : {})
                }))
              }
            : {})
        }
        const noShell = spec.noShell === true
        supervisor.openSession(
          sessionId,
          { kind: 'ssh', ...size, target, ...(noShell ? { noShell: true } : {}) },
          port1,
          ssh,
          // Không có shell thì không có gì để ghi log.
          noShell ? undefined : log
        )
      }
      if (resolved) send('hosts:changed', null) // cập nhật "dùng gần nhất"
    }
    window.webContents.postMessage(SESSION_PORT_CHANNEL, { sessionId }, [port2])
    return { sessionId }
  })

  handle('session:close', isTrustedSender, (sessionId) => {
    supervisor.closeSession(sessionId)
  })

  registerHostIpc(
    requireHosts(),
    isTrustedSender,
    () => mainWindow,
    () => {
      send('hosts:changed', null)
    }
  )

  const requireSnippets = (): SnippetService => {
    if (!snippets) throw new Error('Data is not ready yet')
    return snippets
  }
  const requireSettings = (): SettingsService => {
    if (!settings) throw new Error('Data is not ready yet')
    return settings
  }
  // Chỉ gửi id / tên / loại — đường dẫn chương trình ở lại main.
  const shellList = async (refresh: boolean) => {
    const list = refresh ? await shells.refresh() : await shells.list()
    const preferred = requireSettings().get().terminal.defaultShell
    return {
      shells: list.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      defaultId: (list.find((s) => s.id === preferred) ?? list[0])?.id ?? null
    }
  }
  handle('shells:list', isTrustedSender, (refresh) => shellList(refresh))
  handle('settings:get', isTrustedSender, () => requireSettings().get())
  handle('settings:update', isTrustedSender, (patch) => requireSettings().update(patch))

  handle('snippets:list', isTrustedSender, () => requireSnippets().list())
  handle('snippets:save', isTrustedSender, (input) => {
    try {
      return { ok: true, id: requireSnippets().save(input) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  handle('snippets:delete', isTrustedSender, (id) => {
    requireSnippets().delete(id)
  })

  handle('vault:getState', isTrustedSender, () => requireVault().state())
  handle('vault:create', isTrustedSender, (password) =>
    runVaultOp(password, (secret) => requireVault().create(secret))
  )
  handle('vault:unlock', isTrustedSender, (password) =>
    runVaultOp(password, (secret) => requireVault().unlock(secret))
  )
  handle('vault:lock', isTrustedSender, () => {
    requireVault().lock()
  })

  handle('dialog:openFiles', isTrustedSender, async () => {
    const options = {
      title: 'Choose files to upload',
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
  handle('dialog:saveFile', isTrustedSender, async (defaultName) => {
    const options = {
      title: 'Save file',
      defaultPath: join(app.getPath('downloads'), defaultName.replace(/[\\/]/g, '_'))
    }
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options)
    return result.canceled || !result.filePath ? null : result.filePath
  })

  handle('local:list', isTrustedSender, (path) => listLocal(path, app.getPath('home')))
  handle('dialog:pickProgram', isTrustedSender, async () => {
    const options = {
      title: 'Choose an editor',
      properties: ['openFile'] as 'openFile'[],
      ...(process.platform === 'win32'
        ? { filters: [{ name: 'Programs', extensions: ['exe'] }] }
        : {})
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle('dialog:pickFolder', isTrustedSender, async (title, start) => {
    const options = {
      title,
      defaultPath: start === 'logs' ? logDirectory() : app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle('logs:openFolder', isTrustedSender, async () => {
    const dir = logDirectory()
    mkdirSync(dir, { recursive: true })
    const error = await electronShell.openPath(dir)
    if (error) throw new Error(error)
  })
  handle('files:prepareEdit', isTrustedSender, (remoteName) => remoteEdits.prepare(remoteName))
  handle('files:openInEditor', isTrustedSender, async (localPath) => {
    if (!remoteEdits.owns(localPath)) throw new Error('This file cannot be opened')
    await openInEditor(localPath, requireSettings().get().files.editor, {
      openPath: (p) => electronShell.openPath(p),
      platform: process.platform
    })
  })

  handle('clipboard:readText', isTrustedSender, () => clipboard.readText())

  handle('clipboard:writeText', isTrustedSender, (text) => clipboard.writeText(text))

  handle('test:crashSessionHost', isTrustedSender, () => {
    if (!testHooks) throw new Error('Test hooks are disabled')
    supervisor.crashForTest()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Shellhouse',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0f12' : '#f4f5f7',
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.js'))
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  installEditContextMenu(mainWindow)
  installDevToolsShortcut(mainWindow)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    log.error(`Renderer gone: ${details.reason}`)
    mainWindow?.reload()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  installGlobalGuards(devServerUrl)

  void app.whenReady().then(async () => {
    db = await openStoreInteractive()
    if (!db) {
      app.quit()
      return
    }
    // KDF nhanh chỉ cho E2E; bản phát hành không bao giờ bật được (testHooks yêu cầu !isPackaged).
    const fastKdf = testHooks && process.env['SHELLHOUSE_FAST_KDF'] === '1'
    vault = new Vault(db, fastKdf ? TEST_KDF : DEFAULT_KDF)
    vault.onChange((state) => {
      send('vault:state', state)
    })
    // Đọc thêm known_hosts của OpenSSH (chỉ đọc). E2E dùng dữ liệu cô lập nên bỏ qua file thật.
    knownHosts = new KnownHosts(
      db,
      testHooks ? [] : [join(app.getPath('home'), '.ssh', 'known_hosts')]
    )
    hosts = new HostService(db, vault)
    snippets = new SnippetService(db)
    settings = new SettingsService(db)
    // Hộp thoại hệ thống, thanh cuộn, nền cửa sổ theo cài đặt Appearance.
    nativeTheme.themeSource = settings.get().appearance.theme
    settings.onChange((s) => {
      send('settings:changed', s)
      nativeTheme.themeSource = s.appearance.theme
      mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0d0f12' : '#f4f5f7')
    })
    const settingsRef = settings
    deviceKeys = new DeviceKeyStore(db, electronProtector)
    vaultController = new VaultController(
      vault,
      deviceKeys,
      () => settingsRef.get(),
      (m) => {
        log.info(m)
      }
    )
    // "Nhớ trên máy này": mở vault bằng khoá trong keychain, không cần master password.
    if (vaultController.tryAutoUnlock())
      log.info('Unlocked the vault with the key stored on this device')
    const controllerRef = vaultController
    // Tự khoá khi máy rảnh (thời gian rảnh của toàn hệ thống) / ngủ / khoá màn hình.
    setInterval(() => {
      controllerRef.onIdle(powerMonitor.getSystemIdleTime())
    }, 30_000).unref()
    powerMonitor.on('suspend', () => controllerRef.onPowerEvent('suspend'))
    powerMonitor.on('lock-screen', () => controllerRef.onPowerEvent('lock-screen'))
    const hostKeys = knownHosts
    supervisor.onEvent((event) => {
      if (event.type === 'hostkey:check') {
        const result = hostKeys.check(event.host, event.port, Buffer.from(event.key, 'base64'))
        supervisor.send({ type: 'hostkey:result', requestId: event.requestId, result })
      } else if (event.type === 'hostkey:trust') {
        hostKeys.trust(event.host, event.port, Buffer.from(event.key, 'base64'))
        log.info(`Trusted a new host key for ${event.host}:${event.port}`)
      }
    })

    updater = new Updater()
    const updaterRef = updater
    updaterRef.setChannel(settings.get().updates.channel)
    updaterRef.onStatus((s) => {
      send('updates:status', s)
    })
    settings.onChange((s) => {
      updaterRef.setChannel(s.updates.channel)
    })
    handle('updates:status', isTrustedSender, () => updaterRef.getStatus())
    handle('updates:check', isTrustedSender, () => updaterRef.check())
    handle('updates:download', isTrustedSender, () => updaterRef.download())
    handle('updates:install', isTrustedSender, () => {
      updaterRef.install()
    })
    if (updaterRef.enabled && settings.get().updates.autoCheck) {
      setTimeout(() => void updaterRef.check(), 10_000).unref()
    }

    try {
      remoteEdits.cleanup()
    } catch (error) {
      log.warn('Could not clean up old remote-edit copies', error)
    }
    installAppMenu()
    registerIpc()
    registerSecurityIpc({
      vault,
      controller: vaultController,
      deviceKeys,
      settings,
      db: () => db,
      paths: storePaths(app.getPath('userData')),
      window: () => mainWindow,
      isTrustedSender,
      closeDb: () => {
        db?.close()
        db = null
      }
    })
    supervisor.onStatus((status) => {
      send('sessionHost:status', status)
    })
    supervisor.start()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    supervisor.stop()
    vault?.lock()
  })

  app.on('will-quit', () => {
    db?.close()
    db = null
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
