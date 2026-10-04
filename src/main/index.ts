import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
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
import type { EventChannel, EventPayload, InvokeResult } from '@shared/ipc'
import { toForwardSpec } from '@shared/forwards'
import { checkMainNativeModules } from './diagnostics'
import { handle } from './ipc/router'
import { installAppMenu, installDevToolsShortcut } from './app-menu'
import { installEditContextMenu } from './context-menu'
import { CommandHistory } from './command-history'
import { MainModuleRegistry } from '../modules/registry/main'
import { MAIN_MODULES } from '../modules/registry/all-main'
import { ModuleProgramGrants } from './module-grants'
import { showMessageBox, showOpenDialog, showSaveDialog } from './dialogs'
import { ListedDirs, listLocal } from './local-files'
import { openInEditor, RemoteEditFiles } from './remote-edit'
import { sessionLogFor } from './session-log-path'
import { ShellService } from './shells'
import { installGlobalGuards, secureWebPreferences } from './security'
import { resolveLanguage, resolveLocale, setLanguage, t, type Language } from '@shared/i18n'
import { formatDateTime } from '@shared/i18n/format'
import { isAppUrl } from './security-policy'
import { spawnElectronHost } from './session-host/electron-spawn'
import { SessionHostSupervisor } from './session-host/supervisor'
import { CorruptDatabaseError, dailyBackupIfDue, openStore, storePaths, type Db } from './store'
import { restoreBackup } from './store/backup'
import { NewerSchemaError } from './store/migrate'
import { KnownHosts } from './known-hosts'
import { registerHostIpc } from './hosts/ipc'
import { registerRdpIpc } from './rdp/ipc'
import { registerRdpViewIpc } from './rdp-viewer/ipc'
import { registerRdpNativeIpc } from './rdp-native/ipc'
import type { RdpNativeController } from './rdp-native/controller'
import type { RdpLauncher } from './rdp/launcher'
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
import { listWslDistros, wslFileExists, type WslDistro } from './wsl'
import { TmuxSlots } from './tmux-slots'
import { applyWindowTheme, windowBackground, windowChromeOptions } from './window-chrome'

log.initialize()
log.transports.file.level = 'info'

const devServerUrl = process.env['ELECTRON_RENDERER_URL']
/** File renderer của bản build — URL duy nhất (ngoài dev server) được gọi IPC / ở lại cửa sổ. */
const rendererIndexHtml = join(__dirname, '../renderer/index.html')
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
/** Chỉ cho E2E: các đường dẫn coi như có trên máy khi dò dấu hiệu module (không đọc máy thật). */
const testDetect: string[] | null = (() => {
  if (!testHooks) return null
  const parsed: unknown = JSON.parse(process.env['SHELLHOUSE_TEST_DETECT'] ?? '[]')
  return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
})()
/**
 * Chỉ cho E2E: danh sách distro WSL giả. Khi chạy test luôn dùng danh sách giả (mặc định rỗng) —
 * không gọi wsl.exe thật của máy CI (chậm / khác nhau giữa các runner Windows).
 */
const testWsl: WslDistro[] | null = (() => {
  if (!testHooks) return null
  const raw = process.env['SHELLHOUSE_TEST_WSL']
  return raw ? (JSON.parse(raw) as WslDistro[]) : []
})()
const wslDistros = (): Promise<WslDistro[]> =>
  testWsl ? Promise.resolve(testWsl) : listWslDistros()
let db: Db | null = null
let vault: Vault | null = null
let knownHosts: KnownHosts | null = null
let hosts: HostService | null = null
/** Phiên SSH của host đã lưu đang chờ báo hệ điều hành server (sessionId → hostId). */
const osSessions = new Map<string, string>()
let snippets: SnippetService | null = null
let history: CommandHistory | null = null
let modules: MainModuleRegistry | null = null
let programGrants: ModuleProgramGrants | null = null
let rdpLauncher: RdpLauncher | null = null
let rdpNative: RdpNativeController | null = null

function requireModules(): MainModuleRegistry {
  if (!modules) throw new Error(t('Data is not ready yet'))
  return modules
}
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
  return isAppUrl(frame.url, devServerUrl, rendererIndexHtml)
}

function defaultLogDirectory(): string {
  return join(app.getPath('documents'), 'Shellhouse logs')
}

/** Thư mục log đang dùng (cài đặt hoặc mặc định). */
function logDirectory(): string {
  return settings?.get().logging.directory.trim() || defaultLogDirectory()
}

function requireHosts(): HostService {
  if (!hosts) throw new Error(t('Data is not ready yet'))
  return hosts
}

function requireVault(): Vault {
  if (!vault) throw new Error(t('The vault is not ready yet'))
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
      return await openStore(paths, { dailyBackup: false })
    } catch (error) {
      if (error instanceof NewerSchemaError) {
        dialog.showErrorBox(t('Could not open your data'), error.message)
        return null
      }
      if (!(error instanceof CorruptDatabaseError)) throw error
      log.error(error.message)
      const candidate = error.backups.find((b) => !tried.has(b.path))
      if (!candidate) {
        dialog.showErrorBox(
          t('Data is corrupted'),
          t('The file {path} is corrupted and no usable backup is left.', { path: error.dbPath })
        )
        return null
      }
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: t('Data is corrupted'),
        message: t('The Shellhouse data file is corrupted.'),
        detail: t(
          'Restore the backup from {date}?\nThe corrupted file is kept next to it for inspection.',
          { date: formatDateTime(candidate.createdAt) }
        ),
        buttons: [t('Restore'), t('Quit')],
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

/** Module muốn chạy chương trình trên máy: dùng lựa chọn đã nhớ, không thì hỏi người dùng. */
async function decideProgramGrant(request: {
  module: string
  binary: string
  path: string
  sha256: string
}): Promise<boolean> {
  const grants = programGrants
  const manifest = modules?.manifests().find((m) => m.id === request.module)
  if (!grants || !manifest) return false
  const known = grants.decision(request.module, request.path, request.sha256)
  if (known !== null) return known
  const options = {
    type: 'question' as const,
    title: t('Allow program'),
    message: t('Allow the {module} module to run “{program}”?', {
      module: manifest.name,
      program: request.binary
    }),
    detail: `${request.path}\n\n${t(
      'Shellhouse asks once for each program. If the program file changes, you will be asked again.'
    )}`,
    buttons: [t('Allow'), t("Don't allow")],
    defaultId: 0,
    cancelId: 1
  }
  const { response } = await showMessageBox(mainWindow, options)
  const allowed = response === 0
  grants.remember(request.module, request.path, request.sha256, allowed)
  log.info(`Module ${request.module}: ${allowed ? 'allowed' : 'denied'} ${request.path}`)
  return allowed
}

/**
 * Ngôn ngữ giao diện, chốt một lần lúc khởi động (đổi trong Settings → khởi động lại). Biến môi
 * trường SHELLHOUSE_LANG (test e2e, người dùng) thắng cài đặt.
 */
let uiLanguage: Language = 'en'
let uiLocale = 'en-US'
let systemLanguage: Language = 'en'

function applyLanguage(setting: 'system' | Language): void {
  const system = app.getPreferredSystemLanguages()
  const preferred = system.length > 0 ? system : [app.getLocale()]
  systemLanguage = resolveLanguage('system', preferred)
  const forced = process.env['SHELLHOUSE_LANG']
  uiLanguage = resolveLanguage(forced === 'en' || forced === 'vi' ? forced : setting, preferred)
  uiLocale = resolveLocale(uiLanguage, preferred)
  setLanguage(uiLanguage, uiLocale)
}

function registerIpc(): void {
  handle('app:relaunch', isTrustedSender, () => {
    app.relaunch()
    app.quit()
  })
  handle('app:getInfo', isTrustedSender, () => ({
    language: uiLanguage,
    locale: uiLocale,
    systemLanguage,
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

  const tmuxSlots = new TmuxSlots()

  handle('session:open', isTrustedSender, async (spec) => {
    const window = mainWindow
    if (!window) throw new Error('No window')
    const sessionId = randomUUID()
    const { port1, port2 } = new MessageChannelMain()
    try {
      // Host Telnet / Serial (null = SSH hoặc không phải host đã lưu).
      const direct = spec.kind === 'host' ? requireHosts().resolveDirect(spec.hostId) : null
      const logFor = (kind: 'local' | 'ssh', label: string) =>
        sessionLogFor(requireSettings().get().logging, { kind, label }, defaultLogDirectory()) ??
        undefined
      // Terminal của module trên kết nối SSH: module phải đang bật và chạy được trên SSH.
      const moduleTerminal =
        spec.kind === 'host' || spec.kind === 'ssh' ? spec.moduleTerminal : undefined
      if (moduleTerminal && !requireModules().isEnabled(moduleTerminal.module))
        throw new Error(t('The {module} module is turned off', { module: moduleTerminal.module }))
      if (spec.kind === 'module') {
        // Module kiểm tham số và giải mã secret tại main; config chỉ đi thẳng sang Session Host.
        const config = requireModules().resolveSession(spec.module, spec.sessionKind, spec.params)
        supervisor.openSession(
          sessionId,
          {
            kind: 'module',
            module: spec.module,
            sessionKind: spec.sessionKind,
            cols: spec.cols,
            rows: spec.rows,
            config,
            ...(spec.terminal !== undefined ? { terminal: spec.terminal } : {})
          },
          port1
        )
      } else if (spec.kind === 'local') {
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
      } else if (direct) {
        // Telnet / Serial: không có user, mật khẩu, jump host.
        const size = { cols: spec.cols, rows: spec.rows }
        if (direct.protocol === 'telnet') {
          supervisor.openSession(
            sessionId,
            { kind: 'telnet', ...size, target: { host: direct.host, port: direct.port } },
            port1,
            undefined,
            logFor('ssh', `${direct.host}-telnet`)
          )
        } else {
          supervisor.openSession(
            sessionId,
            { kind: 'serial', ...size, serial: direct.serial },
            port1,
            undefined,
            logFor('ssh', direct.serial.path)
          )
        }
        send('hosts:changed', null)
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
          const tmux =
            spec.kind === 'host' && resolved?.tmux && !noShell && !moduleTerminal
              ? tmuxSlots.take(sessionId, spec.hostId)
              : null
          if (spec.kind === 'host') osSessions.set(sessionId, spec.hostId)
          supervisor.openSession(
            sessionId,
            {
              kind: 'ssh',
              ...size,
              target,
              ...(noShell ? { noShell: true } : {}),
              ...(moduleTerminal ? { moduleTerminal } : {}),
              sftpLimits: {
                requests: requireSettings().get().files.sftpRequests,
                transfers: requireSettings().get().files.sftpTransfers
              }
            },
            port1,
            {
              ...ssh,
              ...(tmux ? { tmux } : {}),
              ...(spec.kind === 'host' ? { detectOs: true } : {})
            },
            // Không có shell thì không có gì để ghi log.
            noShell ? undefined : log
          )
        }
        if (resolved) send('hosts:changed', null) // cập nhật "dùng gần nhất"
      }
    } catch (error) {
      // Không mở được (Session Host chưa sẵn sàng, spec sai…): trả số tmux, đóng cả hai đầu cổng.
      tmuxSlots.release(sessionId)
      port1.close()
      port2.close()
      throw error
    }
    window.webContents.postMessage(SESSION_PORT_CHANNEL, { sessionId }, [port2])
    return { sessionId }
  })

  handle('session:close', isTrustedSender, (sessionId) => {
    tmuxSlots.release(sessionId)
    osSessions.delete(sessionId)
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
  // Remote Desktop: mở client RDP của hệ điều hành (E2E: client giả, ghi kế hoạch ra file).
  rdpLauncher = registerRdpIpc({
    hosts: requireHosts,
    isTrustedSender,
    getWindow: () => mainWindow,
    notifyChanged: () => {
      send('hosts:changed', null)
    },
    emit: (event) => {
      send('rdp:status', event)
    },
    tempDir: join(app.getPath('userData'), 'rdp-temp'),
    home: app.getPath('home'),
    stubRecordFile:
      testHooks && process.env['SHELLHOUSE_TEST_RDP'] === 'stub'
        ? join(app.getPath('userData'), 'rdp-test-launch.json')
        : null
  })

  // Remote Desktop trong tab trên Windows: control RDP gốc (mstscax) trong tiến trình phụ, gắn vào
  // cửa sổ app. E2E: tắt (giữ test IronRDP) trừ khi SHELLHOUSE_TEST_RDP_NATIVE = selftest | real.
  const nativeTest = process.env['SHELLHOUSE_TEST_RDP_NATIVE']
  rdpNative = registerRdpNativeIpc({
    hosts: requireHosts,
    isTrustedSender,
    getWindow: () => mainWindow,
    emit: (event) => {
      send('rdpNative:event', event)
    },
    notifyChanged: () => {
      send('hosts:changed', null)
    },
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    testHooks,
    testMode: testHooks && (nativeTest === 'selftest' || nativeTest === 'real') ? nativeTest : null
  })

  // Remote Desktop trong tab: IronRDP (WASM) ở renderer ↔ proxy RDCleanPath trong Session Host.
  if (db)
    registerRdpViewIpc({
      db,
      hosts: requireHosts,
      supervisor,
      isTrustedSender,
      notifyChanged: () => {
        send('hosts:changed', null)
      }
    })

  const requireSnippets = (): SnippetService => {
    if (!snippets) throw new Error(t('Data is not ready yet'))
    return snippets
  }
  const requireSettings = (): SettingsService => {
    if (!settings) throw new Error(t('Data is not ready yet'))
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
      title: t('Choose files to upload'),
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[]
    }
    const result = await showOpenDialog(mainWindow, options)
    return result.canceled ? [] : result.filePaths
  })
  handle('dialog:saveFile', isTrustedSender, async (defaultName) => {
    const options = {
      title: t('Save file'),
      defaultPath: join(app.getPath('downloads'), defaultName.replace(/[\\/]/g, '_'))
    }
    const result = await showSaveDialog(mainWindow, options)
    return result.canceled || !result.filePath ? null : result.filePath
  })

  const requireHistory = (): CommandHistory => {
    if (!history) throw new Error(t('Data is not ready yet'))
    return history
  }
  handle('modules:list', isTrustedSender, () => requireModules().states())
  handle('modules:setEnabled', isTrustedSender, (id, enabled) =>
    requireModules().setEnabled(id, enabled)
  )
  handle('modules:removeData', isTrustedSender, (id) => {
    requireModules().removeData(id)
    programGrants?.forget(id)
  })
  handle(
    'modules:invoke',
    isTrustedSender,
    (id, name, args) =>
      requireModules().invoke(id, name, args) as Promise<InvokeResult<'modules:invoke'>>
  )
  handle('modules:detectLocal', isTrustedSender, () =>
    requireModules().detectLocal(
      testDetect ? (p) => testDetect.includes(p) : existsSync,
      app.getPath('home'),
      {
        running: async () => (await wslDistros()).filter((d) => d.running).map((d) => d.name),
        // E2E: "wsl:<distro>:<đường dẫn>" trong SHELLHOUSE_TEST_DETECT = file có trong distro.
        exists: testDetect ? (d, p) => testDetect.includes(`wsl:${d}:${p}`) : wslFileExists
      }
    )
  )
  handle('history:list', isTrustedSender, (target) => requireHistory().list(target))
  handle('history:record', isTrustedSender, (target, command) => {
    // Tắt gợi ý trong cài đặt = không ghi nữa.
    if (requireSettings().get().terminal.commandSuggestions)
      requireHistory().record(target, command)
  })
  handle('history:clear', isTrustedSender, (target) => {
    requireHistory().clear(target)
  })
  handle('serial:list', isTrustedSender, async () => {
    // Nạp khi cần (module native) — không làm chậm lúc khởi động.
    const { SerialPort } = await import('serialport')
    // friendlyName chỉ có trên Windows ("USB Serial Port (COM3)").
    type RawPort = {
      path: string
      manufacturer?: string | undefined
      serialNumber?: string | undefined
      friendlyName?: string | undefined
    }
    const ports = (await SerialPort.list()) as RawPort[]
    return ports.map((p) => ({
      path: p.path,
      description: [p.friendlyName ?? p.manufacturer, p.serialNumber].filter(Boolean).join(' · ')
    }))
  })
  const listedDirs = new ListedDirs()
  handle('local:list', isTrustedSender, async (path) => {
    const listing = await listLocal(path, app.getPath('home'))
    listedDirs.remember(listing.path)
    return listing
  })
  handle('local:trash', isTrustedSender, async (paths) => {
    // Chỉ mục trong thư mục renderer vừa duyệt; vào Thùng rác (khôi phục được), không xoá hẳn.
    if (!paths.every((p) => listedDirs.allows(p))) throw new Error(t('This item cannot be moved'))
    for (const p of paths) await electronShell.trashItem(p)
  })
  // Editor ngoài là chương trình main sẽ chạy → chỉ đặt qua hộp thoại của main.
  handle('files:chooseEditor', isTrustedSender, async () => {
    const result = await showOpenDialog(mainWindow, {
      title: t('Choose an editor'),
      properties: ['openFile'],
      ...(process.platform === 'win32'
        ? { filters: [{ name: t('Programs'), extensions: ['exe'] }] }
        : {})
    })
    const program = result.canceled ? null : (result.filePaths[0] ?? null)
    return program ? requireSettings().update({ files: { editor: program } }) : null
  })
  handle('files:resetEditor', isTrustedSender, () =>
    requireSettings().update({ files: { editor: '' } })
  )
  handle('dialog:pickFolder', isTrustedSender, async (title, start) => {
    const options = {
      title,
      defaultPath: start === 'logs' ? logDirectory() : app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    }
    const result = await showOpenDialog(mainWindow, options)
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
    if (!remoteEdits.owns(localPath)) throw new Error(t('This file cannot be opened'))
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

/** Tải lại renderer tối đa chừng này lần trong cửa sổ thời gian dưới. */
const MAX_RENDERER_RELOADS = 3
const RENDERER_CRASH_WINDOW_MS = 60_000

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Shellhouse',
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    // Không có thanh tiêu đề của hệ điều hành: thanh trên cùng của app là vùng kéo (window-chrome.ts).
    ...windowChromeOptions(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.js'), [
      `--shellhouse-lang=${uiLanguage}`,
      `--shellhouse-locale=${uiLocale}`
    ])
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  installEditContextMenu(mainWindow)
  installDevToolsShortcut(mainWindow)
  // Renderer chết → tải lại, nhưng không lặp vô hạn nếu nó chết ngay khi nạp (crash loop).
  const crashes: number[] = []
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    log.error(`Renderer gone: ${details.reason}`)
    const now = Date.now()
    crashes.push(now)
    while (crashes.length > 0 && now - (crashes[0] ?? now) > RENDERER_CRASH_WINDOW_MS)
      crashes.shift()
    if (crashes.length > MAX_RENDERER_RELOADS) {
      dialog.showErrorBox(
        t('Shellhouse stopped working'),
        t(
          'The window crashed {n} times in a row ({reason}). Restart Shellhouse; if it keeps happening, check the log file.',
          { n: crashes.length, reason: details.reason }
        )
      )
      return
    }
    mainWindow?.reload()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(rendererIndexHtml)
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

  installGlobalGuards(devServerUrl, rendererIndexHtml)

  void app.whenReady().then(async () => {
    // Chưa đọc được cài đặt (DB chưa mở): hộp thoại lỗi DB theo ngôn ngữ hệ thống; đặt lại theo
    // cài đặt ngay khi có.
    applyLanguage('system')
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
    history = new CommandHistory(db)
    settings = new SettingsService(db)
    applyLanguage(settings.get().appearance.language)
    programGrants = new ModuleProgramGrants(db)
    modules = new MainModuleRegistry(MAIN_MODULES, {
      db,
      appData: app.getPath('userData'),
      vault,
      settings,
      emit: (module, name, data) => {
        send('modules:event', { module, name, data })
      },
      onStatesChanged: (states) => {
        send('modules:changed', states)
        supervisor.send({
          type: 'modules:enabled',
          ids: states.filter((m) => m.enabled).map((m) => m.id)
        })
      },
      log: (level, message) => {
        log[level](`[modules] ${message}`)
      },
      listWslDistros: wslDistros,
      ownsEditFile: (path) => remoteEdits.owns(path),
      // Cùng thư mục nhà với phần còn lại của app (E2E đổi bằng SHELLHOUSE_HOME).
      home: app.getPath('home'),
      showOpenDialog: async (options) => {
        const properties: ('openFile' | 'multiSelections' | 'showHiddenFiles')[] = options.multiple
          ? ['openFile', 'multiSelections', 'showHiddenFiles']
          : ['openFile', 'showHiddenFiles']
        const opts = {
          title: options.title,
          properties,
          ...(options.filters ? { filters: options.filters } : {}),
          defaultPath: app.getPath('home')
        }
        const result = await showOpenDialog(mainWindow, opts)
        return result.canceled ? [] : result.filePaths
      }
    })
    modules.start()
    // Hộp thoại hệ thống, thanh cuộn, nền cửa sổ theo cài đặt Appearance.
    nativeTheme.themeSource = settings.get().appearance.theme
    settings.onChange((s) => {
      send('settings:changed', s)
      nativeTheme.themeSource = s.appearance.theme
      if (mainWindow)
        applyWindowTheme(mainWindow, process.platform, nativeTheme.shouldUseDarkColors)
    })
    // Theme "System" và hệ điều hành đổi sáng / tối → nút điều khiển cửa sổ đổi màu theo.
    nativeTheme.on('updated', () => {
      if (mainWindow)
        applyWindowTheme(mainWindow, process.platform, nativeTheme.shouldUseDarkColors)
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
    const modulesRef = modules
    supervisor.onEvent((event) => {
      if (event.type === 'hostkey:check') {
        const result = hostKeys.check(event.host, event.port, Buffer.from(event.key, 'base64'))
        supervisor.send({ type: 'hostkey:result', requestId: event.requestId, result })
      } else if (event.type === 'session:os') {
        // Icon distro của host: chỉ ghi / báo renderer khi khác lần trước.
        const hostId = osSessions.get(event.sessionId)
        osSessions.delete(event.sessionId)
        if (hostId && hosts?.setOs(hostId, event.os)) send('hosts:changed', null)
      } else if (event.type === 'hostkey:trust') {
        hostKeys.trust(event.host, event.port, Buffer.from(event.key, 'base64'))
        log.info(`Trusted a new host key for ${event.host}:${event.port}`)
      } else if (event.type === 'module:request') {
        void modulesRef.hostRequest(event.module, event.name, event.params).then(
          (result) => {
            supervisor.send({
              type: 'module:response',
              requestId: event.requestId,
              ok: true,
              result
            })
          },
          (error: unknown) => {
            supervisor.send({
              type: 'module:response',
              requestId: event.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        )
      } else if (event.type === 'module:grant') {
        // Lỗi (hộp thoại, DB…) = từ chối — Session Host không được chờ mãi.
        void decideProgramGrant(event)
          .catch((error: unknown) => {
            log.error(`Module ${event.module}: could not decide on ${event.path}`, error)
            return false
          })
          .then((allowed) => {
            supervisor.send({ type: 'module:grant-result', requestId: event.requestId, allowed })
          })
      }
    })
    // Session Host (khởi động lại) cần biết module nào đang bật.
    supervisor.onStatus((status) => {
      if (status.state === 'running')
        supervisor.send({
          type: 'modules:enabled',
          ids: modulesRef
            .states()
            .filter((m) => m.enabled)
            .map((m) => m.id)
        })
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

    // Việc dọn dẹp không cần cho lần vẽ đầu tiên — chạy sau khi đã mở cửa sổ.
    remoteEdits.cleanup().catch((error: unknown) => {
      log.warn('Could not clean up old remote-edit copies', error)
    })
    setTimeout(() => {
      if (!db) return
      dailyBackupIfDue(db, storePaths(app.getPath('userData')).backups).catch((error: unknown) => {
        log.warn('Daily backup failed', error)
      })
    }, 5_000).unref()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    rdpLauncher?.disposeAll()
    rdpNative?.disposeAll()
    modules?.stop()
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
