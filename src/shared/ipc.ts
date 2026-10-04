import { z } from 'zod'
import { NativeModuleStatus } from './session-host-protocol'
import { SessionSpec } from './stream-protocol'
import { LocalListing } from './local-files'
import { SerialPortInfo } from './serial'
import {
  AccountDeleteResolution,
  AccountInput,
  GroupInput,
  HostInput,
  HostTree,
  ImportCandidate,
  FileImportScan,
  MutationResult
} from './hosts'
import { SavedForward, SavedForwardInput } from './forwards'
import { RdpCheckResult, RdpLaunchRequest, RdpLaunchResult, RdpStatusEvent } from './rdp'
import {
  RdpViewOpenRequest,
  RdpViewOpenResult,
  RdpViewPrepare,
  RdpViewProbeRequest,
  RdpViewProbeResult
} from './rdp-viewer'
import { SnippetInput, SnippetSummary } from './snippets'
import { AppSettings, SettingsPatch } from './settings'
import type { UpdateStatus } from './updates'

export { NativeModuleStatus }

export const SessionHostState = z.enum(['starting', 'running', 'restarting', 'stopped'])
export type SessionHostState = z.infer<typeof SessionHostState>

export const SessionHostStatus = z.object({
  state: SessionHostState,
  pid: z.number().int().nullable(),
  restarts: z.number().int(),
  lastExit: z
    .object({ code: z.number().int().nullable(), reason: z.string(), at: z.number() })
    .nullable()
})
export type SessionHostStatus = z.infer<typeof SessionHostStatus>

export const VaultState = z.enum(['uninitialized', 'locked', 'unlocked'])
export type VaultState = z.infer<typeof VaultState>

export const MIN_MASTER_PASSWORD = 8
const MasterPassword = z.string().min(1).max(1024)

/** Lỗi dự kiến trả về dưới dạng giá trị (IPC làm méo message của Error). */
export const VaultResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['wrong-password', 'too-short', 'busy', 'exists', 'failed']),
    message: z.string()
  })
])
export type VaultResult = z.infer<typeof VaultResult>

export const VaultSecurity = z.object({
  rememberAvailable: z.boolean(),
  rememberUnavailableReason: z.string().nullable(),
  rememberEnabled: z.boolean()
})
export type VaultSecurity = z.infer<typeof VaultSecurity>

export const FileResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), message: z.string() })
])
export type FileResult = z.infer<typeof FileResult>

export const AppInfo = z.object({
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  packaged: z.boolean(),
  testHooks: z.boolean(),
  /** Số build Windows (ví dụ 26200) — cho xterm.js biết cách ConPTY hoạt động. null ngoài Windows. */
  windowsBuild: z.number().int().nullable(),
  /** Ngôn ngữ giao diện đang dùng (đã giải 'system') và locale định dạng ngày / số. */
  language: z.enum(['en', 'vi']),
  locale: z.string(),
  /** Ngôn ngữ hệ điều hành sẽ chọn khi cài đặt là 'system' — để ghi "Theo hệ thống (…)". */
  systemLanguage: z.enum(['en', 'vi'])
})
export type AppInfo = z.infer<typeof AppInfo>

const ModuleIdArg = z.string().regex(/^[a-z0-9-]{1,40}$/)
const ModuleStateSchema = z.object({ id: z.string(), enabled: z.boolean(), seen: z.boolean() })
export type ModuleStateInfo = z.infer<typeof ModuleStateSchema>

/**
 * Hợp đồng IPC renderer ↔ main. Mỗi kênh khai báo schema tham số và kết quả;
 * main validate tham số, test validate kết quả.
 */
export const invokeContract = {
  'app:getInfo': { args: z.tuple([]), result: AppInfo },
  /** Khởi động lại app (đổi ngôn ngữ giao diện). */
  'app:relaunch': { args: z.tuple([]), result: z.void() },
  'sessionHost:getStatus': { args: z.tuple([]), result: SessionHostStatus },
  'diagnostics:nativeModules': { args: z.tuple([]), result: z.array(NativeModuleStatus) },
  'test:crashSessionHost': { args: z.tuple([]), result: z.void() },
  /** Mở session; MessagePort được gửi riêng qua kênh `session:port`. */
  'session:open': { args: z.tuple([SessionSpec]), result: z.object({ sessionId: z.string() }) },
  'session:close': { args: z.tuple([z.uuid()]), result: z.void() },
  // Renderer bị sandbox và mọi quyền trình duyệt bị từ chối, nên clipboard đi qua main.
  'hosts:tree': { args: z.tuple([]), result: HostTree },
  'hosts:save': { args: z.tuple([HostInput]), result: MutationResult },
  'hosts:delete': { args: z.tuple([z.string().max(64)]), result: z.void() },
  'hosts:move': {
    args: z.tuple([z.string().max(64), z.string().max(64).nullable()]),
    result: z.void()
  },
  'hosts:moveMany': {
    args: z.tuple([z.array(z.string().max(64)).max(1000), z.string().max(64).nullable()]),
    result: MutationResult
  },
  'hosts:deleteMany': { args: z.tuple([z.array(z.string().max(64)).max(1000)]), result: z.void() },
  'hosts:setFavorite': {
    args: z.tuple([z.array(z.string().max(64)).max(1000), z.boolean()]),
    result: z.void()
  },
  'hosts:tag': {
    args: z.tuple([
      z.array(z.string().max(64)).max(1000),
      z.array(z.string().trim().min(1).max(40)).max(20),
      z.array(z.string().max(40)).max(100)
    ]),
    result: MutationResult
  },
  /** Thứ tự mới của host trong một nhóm (host từ nhóm khác được chuyển vào). */
  'hosts:reorder': {
    args: z.tuple([z.string().max(64).nullable(), z.array(z.string().max(64)).max(1000)]),
    result: MutationResult
  },
  'hosts:duplicate': { args: z.tuple([z.string().max(64)]), result: MutationResult },
  /** Lưu mật khẩu vừa đăng nhập thành công ở hộp hỏi mật khẩu ("Save password in vault"). */
  'hosts:setPassword': {
    args: z.tuple([z.string().max(64), z.string().min(1).max(4096)]),
    result: MutationResult
  },
  'groups:reorder': {
    args: z.tuple([z.string().max(64).nullable(), z.array(z.string().max(64)).max(1000)]),
    result: MutationResult
  },
  /** Shell local có trên máy (PowerShell, cmd, WSL…). `true` = dò lại. */
  'shells:list': {
    args: z.tuple([z.boolean()]),
    result: z.object({
      shells: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          kind: z.enum(['powershell', 'cmd', 'wsl', 'bash', 'posix'])
        })
      ),
      defaultId: z.string().nullable()
    })
  },
  'groups:save': { args: z.tuple([GroupInput]), result: MutationResult },
  'groups:delete': { args: z.tuple([z.string().max(64)]), result: z.void() },
  /** Chuyển nhóm vào nhóm khác (null = cấp cao nhất). */
  'groups:move': {
    args: z.tuple([z.string().max(64), z.string().max(64).nullable()]),
    result: MutationResult
  },
  /** Main mở hộp thoại chọn file (renderer không đọc được file). */
  'keys:importFromFile': { args: z.tuple([]), result: MutationResult.nullable() },
  'keys:delete': { args: z.tuple([z.string().max(64)]), result: MutationResult },
  /** Tài khoản dùng chung (Settings → Accounts); danh sách nằm trong `hosts:tree`. */
  'accounts:save': { args: z.tuple([AccountInput]), result: MutationResult },
  'accounts:duplicate': { args: z.tuple([z.string().max(64)]), result: MutationResult },
  /** Tài khoản đang có host dùng: phải kèm cách xử lý (chuyển sang tài khoản khác / chép vào host). */
  'accounts:delete': {
    args: z.tuple([z.string().max(64), AccountDeleteResolution.nullable()]),
    result: MutationResult
  },
  'sshConfig:scan': { args: z.tuple([]), result: z.array(ImportCandidate) },
  'sshConfig:import': {
    args: z.tuple([z.array(z.string().max(255)).max(1000)]),
    result: z.object({ imported: z.number().int(), skipped: z.array(z.string()) })
  },
  /** true = cho người dùng chọn file; false = vị trí mặc định (%APPDATA%\MobaXterm). */
  'mobaxterm:scan': { args: z.tuple([z.boolean()]), result: FileImportScan },
  /** Nhập từ file vừa quét (main giữ đường dẫn — renderer không truyền đường dẫn). */
  /** CSV (Termius…): luôn cho người dùng chọn file. */
  'csv:scan': { args: z.tuple([]), result: FileImportScan },
  'csv:import': {
    args: z.tuple([z.array(z.string().max(1024)).max(5000)]),
    result: z.object({ imported: z.number().int(), skipped: z.array(z.string()) })
  },
  /** File "Shellhouse YAML" (Export hosts): luôn cho người dùng chọn file. */
  'yaml:scan': { args: z.tuple([]), result: FileImportScan },
  'yaml:import': {
    args: z.tuple([z.array(z.string().max(1024)).max(5000)]),
    result: z.object({ imported: z.number().int(), skipped: z.array(z.string()) })
  },
  'mobaxterm:import': {
    args: z.tuple([z.array(z.string().max(1024)).max(5000)]),
    result: z.object({ imported: z.number().int(), skipped: z.array(z.string()) })
  },
  'forwards:list': { args: z.tuple([z.string().max(64)]), result: z.array(SavedForward) },
  'forwards:save': { args: z.tuple([SavedForwardInput]), result: MutationResult },
  'forwards:delete': { args: z.tuple([z.string().max(64)]), result: z.void() },
  /** Hộp thoại của hệ điều hành — renderer không tự chọn đường dẫn trên máy. */
  'dialog:openFiles': { args: z.tuple([]), result: z.array(z.string()) },
  'dialog:saveFile': { args: z.tuple([z.string().max(255)]), result: z.string().nullable() },
  /** Lưu một file văn bản (xuất danh sách host…): main hỏi chỗ lưu rồi ghi; null = huỷ. */
  'dialog:saveText': {
    args: z.tuple([z.string().max(255), z.string().max(20_000_000)]),
    result: z.string().nullable()
  },
  /** Trạng thái các module (ADR-014). */
  'modules:list': { args: z.tuple([]), result: z.array(ModuleStateSchema) },
  /** Bật / tắt module — có hiệu lực ngay; lỗi bật (migration…) trả về dạng Error. */
  'modules:setEnabled': {
    args: z.tuple([ModuleIdArg, z.boolean()]),
    result: z.array(ModuleStateSchema)
  },
  /** Xoá toàn bộ dữ liệu của module (đã tắt). */
  'modules:removeData': { args: z.tuple([ModuleIdArg]), result: z.void() },
  /**
   * Gọi handler `module:<id>:<name>` — tham số do schema của module kiểm ở main. Kết quả là JSON
   * (kiểu `unknown` ở đây làm TS mất suy luận kiểu literal của mọi handler khác).
   */
  'modules:invoke': {
    args: z.tuple([
      ModuleIdArg,
      z.string().regex(/^[a-zA-Z][\w-]{0,40}$/),
      z.array(z.unknown()).max(16)
    ]),
    result: z.json().optional()
  },
  /** Dấu hiệu trên máy (kubeconfig, socket Docker…) của module đang tắt — gợi ý bật (3.12.4). */
  'modules:detectLocal': { args: z.tuple([]), result: z.array(ModuleIdArg) },
  /** Lịch sử lệnh của một đích (gợi ý khi gõ), mới nhất trước. */
  'history:list': { args: z.tuple([z.string().min(1).max(300)]), result: z.array(z.string()) },
  'history:record': {
    args: z.tuple([z.string().min(1).max(300), z.string().max(1000)]),
    result: z.void()
  },
  /** null = xoá tất cả. */
  'history:clear': { args: z.tuple([z.string().max(300).nullable()]), result: z.void() },
  /** Cổng serial đang có trên máy (COM3, /dev/ttyUSB0…). */
  'serial:list': { args: z.tuple([]), result: z.array(SerialPortInfo) },
  /** Liệt kê thư mục trên máy (null = thư mục home) cho SFTP hai cột. */
  'local:list': { args: z.tuple([z.string().max(4096).nullable()]), result: LocalListing },
  /** Đưa file / thư mục trên máy vào Thùng rác (F6 "Move" trong trình quản lý file hai cột). */
  'local:trash': {
    args: z.tuple([z.array(z.string().min(1).max(4096)).max(1000)]),
    result: z.void()
  },
  /**
   * Chọn editor ngoài bằng hộp thoại của main và lưu luôn vào cài đặt (renderer không bao giờ tự
   * đặt đường dẫn chương trình main sẽ chạy). null = huỷ.
   */
  'files:chooseEditor': { args: z.tuple([]), result: AppSettings.nullable() },
  /** Bỏ editor đã chọn → ứng dụng mặc định của hệ điều hành. */
  'files:resetEditor': { args: z.tuple([]), result: AppSettings },
  /** Chọn thư mục (mở sẵn ở thư mục log hoặc Downloads); null = huỷ. */
  'dialog:pickFolder': {
    args: z.tuple([z.string().max(100), z.enum(['logs', 'downloads'])]),
    result: z.string().nullable()
  },
  /** Mở thư mục log phiên trong trình quản lý file (tạo nếu chưa có). */
  'logs:openFolder': { args: z.tuple([]), result: z.void() },
  /** Sửa file trên server: main cấp đường dẫn tạm cho tên file. */
  'files:prepareEdit': { args: z.tuple([z.string().min(1).max(255)]), result: z.string() },
  /** Mở bằng editor trong cài đặt — chỉ file do `files:prepareEdit` cấp. */
  'files:openInEditor': { args: z.tuple([z.string().max(4096)]), result: z.void() },
  'settings:get': { args: z.tuple([]), result: AppSettings },
  'settings:update': { args: z.tuple([SettingsPatch]), result: AppSettings },
  'snippets:list': { args: z.tuple([]), result: z.array(SnippetSummary) },
  'snippets:save': { args: z.tuple([SnippetInput]), result: MutationResult },
  'snippets:delete': { args: z.tuple([z.string().max(64)]), result: z.void() },
  'keys:generate': {
    args: z.tuple([
      z.object({
        name: z.string().trim().min(1).max(100),
        type: z.enum(['ed25519', 'rsa', 'ecdsa']),
        /** Kiểm chi tiết theo loại key trong keygen.ts (KEY_BITS). */
        bits: z.number().int().min(256).max(4096).optional(),
        passphrase: z.string().max(1024).optional()
      })
    ]),
    result: MutationResult
  },
  'keys:publicKey': { args: z.tuple([z.string().max(64)]), result: z.string() },
  /** Lưu private key ra file (hộp thoại của main); null = huỷ. */
  'keys:exportPrivate': { args: z.tuple([z.string().max(64)]), result: FileResult.nullable() },
  'updates:status': { args: z.tuple([]), result: z.custom<UpdateStatus>() },
  'updates:check': { args: z.tuple([]), result: z.void() },
  'updates:download': { args: z.tuple([]), result: z.void() },
  'updates:install': { args: z.tuple([]), result: z.void() },
  'vault:getState': { args: z.tuple([]), result: VaultState },
  'vault:create': { args: z.tuple([MasterPassword]), result: VaultResult },
  'vault:unlock': { args: z.tuple([MasterPassword]), result: VaultResult },
  'vault:lock': { args: z.tuple([]), result: z.void() },
  'vault:security': { args: z.tuple([]), result: VaultSecurity },
  'vault:changePassword': { args: z.tuple([MasterPassword, MasterPassword]), result: VaultResult },
  /** Bật cần master password (null khi tắt). */
  'vault:setRemember': {
    args: z.tuple([z.boolean(), MasterPassword.nullable()]),
    result: VaultResult
  },
  /** null = người dùng huỷ hộp thoại. */
  'vault:exportBackup': { args: z.tuple([]), result: FileResult.nullable() },
  'vault:restoreBackup': { args: z.tuple([MasterPassword]), result: FileResult.nullable() },
  /** Remote Desktop: client có trên máy chưa, cần hỏi mật khẩu không, có tunnel SSH không. */
  'rdp:check': { args: z.tuple([z.string().max(64)]), result: RdpCheckResult },
  /** Mở client RDP của hệ điều hành (tunnel SSH, nếu có, renderer đã mở trước). */
  'rdp:launch': { args: z.tuple([RdpLaunchRequest]), result: RdpLaunchResult },
  /** Disconnect: đóng client (nếu Shellhouse giữ tiến trình), dọn file tạm / mục cmdkey. */
  'rdp:stop': { args: z.tuple([z.string().max(64)]), result: z.void() },
  /** Import: chọn file .rdp (hộp thoại của main) và quét. */
  'rdp:scan': { args: z.tuple([]), result: FileImportScan },
  'rdp:import': {
    args: z.tuple([z.array(z.string().max(1024)).max(5000)]),
    result: z.object({ imported: z.number().int(), skipped: z.array(z.string()) })
  },
  /** Remote Desktop trong tab: thông tin host để vẽ màn kết nối (không có mật khẩu). */
  'rdpView:prepare': { args: z.tuple([z.string().max(64)]), result: RdpViewPrepare },
  /** Dò chứng chỉ TLS của server (TOFU). */
  'rdpView:probe': { args: z.tuple([RdpViewProbeRequest]), result: RdpViewProbeResult },
  /** Tin chứng chỉ vừa dò (hostId, dấu SHA-256). */
  'rdpView:trust': {
    args: z.tuple([z.string().max(64), z.string().max(128)]),
    result: z.void()
  },
  /** Token proxy dùng một lần + thông tin đăng nhập cho IronRDP. */
  'rdpView:open': { args: z.tuple([RdpViewOpenRequest]), result: RdpViewOpenResult },
  'clipboard:readText': { args: z.tuple([]), result: z.string() },
  'clipboard:writeText': { args: z.tuple([z.string().max(16 * 1024 * 1024)]), result: z.void() }
} as const

export type InvokeChannel = keyof typeof invokeContract
export type InvokeArgs<C extends InvokeChannel> = z.infer<(typeof invokeContract)[C]['args']>
export type InvokeResult<C extends InvokeChannel> = z.infer<(typeof invokeContract)[C]['result']>

/** Sự kiện main → renderer. */
export const eventContract = {
  'sessionHost:status': SessionHostStatus,
  'vault:state': VaultState,
  /** Danh sách host/nhóm/key thay đổi → renderer tải lại. */
  'hosts:changed': z.null(),
  'settings:changed': AppSettings,
  'updates:status': z.custom<UpdateStatus>(),
  /** Module bật / tắt. */
  'modules:changed': z.array(ModuleStateSchema),
  /** Sự kiện của module (`ctx.events.emit`). */
  'modules:event': z.object({ module: z.string(), name: z.string(), data: z.unknown() }),
  /** Client RDP đã thoát / đã giao cho ứng dụng khác. */
  'rdp:status': RdpStatusEvent
} as const

export type EventChannel = keyof typeof eventContract
export type EventPayload<C extends EventChannel> = z.infer<(typeof eventContract)[C]>

/** API mà preload phơi ra `window.shellhouse`. */
export interface ShellhouseApi {
  /** Ngôn ngữ / locale giao diện — có sẵn đồng bộ trước lần vẽ đầu (main truyền qua argv). */
  language: 'en' | 'vi'
  locale: string
  getInfo(): Promise<AppInfo>
  relaunch(): Promise<void>
  getSessionHostStatus(): Promise<SessionHostStatus>
  checkNativeModules(): Promise<NativeModuleStatus[]>
  crashSessionHostForTest(): Promise<void>
  onSessionHostStatus(listener: (status: SessionHostStatus) => void): () => void
  /**
   * Mở session. MessagePort không đi qua contextBridge được nên đến riêng qua
   * window.postMessage (type = PORT_MESSAGE_TYPE); xem renderer/src/lib/sessions.ts.
   */
  openSession(spec: SessionSpec): Promise<{ sessionId: string }>
  closeSession(sessionId: string): Promise<void>
  hostTree(): Promise<HostTree>
  saveHost(input: HostInput): Promise<MutationResult>
  deleteHost(id: string): Promise<void>
  moveHost(id: string, groupId: string | null): Promise<void>
  saveGroup(input: GroupInput): Promise<MutationResult>
  deleteGroup(id: string): Promise<void>
  moveGroup(id: string, parentId: string | null): Promise<MutationResult>
  listShells(refresh?: boolean): Promise<InvokeResult<'shells:list'>>
  moveHosts(ids: string[], groupId: string | null): Promise<MutationResult>
  deleteHosts(ids: string[]): Promise<void>
  setFavorite(ids: string[], favorite: boolean): Promise<void>
  tagHosts(ids: string[], add: string[], remove: string[]): Promise<MutationResult>
  reorderHosts(groupId: string | null, orderedIds: string[]): Promise<MutationResult>
  duplicateHost(id: string): Promise<MutationResult>
  setHostPassword(id: string, password: string): Promise<MutationResult>
  reorderGroups(parentId: string | null, orderedIds: string[]): Promise<MutationResult>
  importKeyFromFile(): Promise<MutationResult | null>
  deleteKey(id: string): Promise<MutationResult>
  saveAccount(input: AccountInput): Promise<MutationResult>
  duplicateAccount(id: string): Promise<MutationResult>
  deleteAccount(id: string, resolution: AccountDeleteResolution | null): Promise<MutationResult>
  scanSshConfig(): Promise<ImportCandidate[]>
  importSshConfig(aliases: string[]): Promise<{ imported: number; skipped: string[] }>
  scanMobaXterm(pick: boolean): Promise<FileImportScan>
  scanCsv(): Promise<FileImportScan>
  importCsv(aliases: string[]): Promise<{ imported: number; skipped: string[] }>
  scanShellhouseYaml(): Promise<FileImportScan>
  importShellhouseYaml(aliases: string[]): Promise<{ imported: number; skipped: string[] }>
  importMobaXterm(aliases: string[]): Promise<{ imported: number; skipped: string[] }>
  onHostsChanged(listener: () => void): () => void
  listForwards(hostId: string): Promise<SavedForward[]>
  saveForward(input: SavedForwardInput): Promise<MutationResult>
  deleteForward(id: string): Promise<void>
  pickFilesToUpload(): Promise<string[]>
  pickSaveLocation(defaultName: string): Promise<string | null>
  /** Hỏi chỗ lưu rồi ghi văn bản vào đó (UTF-8). Trả đường dẫn đã lưu, null = huỷ. */
  saveTextFile(defaultName: string, text: string): Promise<string | null>
  /** Chọn editor ngoài (hộp thoại của main, lưu luôn); null = huỷ. */
  chooseEditor(): Promise<AppSettings | null>
  resetEditor(): Promise<AppSettings>
  listLocal(path: string | null): Promise<LocalListing>
  trashLocal(paths: string[]): Promise<void>
  listSerialPorts(): Promise<SerialPortInfo[]>
  commandHistory(target: string): Promise<string[]>
  modules(): Promise<ModuleStateInfo[]>
  setModuleEnabled(id: string, enabled: boolean): Promise<ModuleStateInfo[]>
  removeModuleData(id: string): Promise<void>
  /** Gọi IPC của module (`module:<id>:<name>`). */
  invokeModule(id: string, name: string, args: unknown[]): Promise<unknown>
  detectLocalModules(): Promise<string[]>
  onModulesChanged(listener: (states: ModuleStateInfo[]) => void): () => void
  onModuleEvent(
    listener: (event: { module: string; name: string; data: unknown }) => void
  ): () => void
  recordCommand(target: string, command: string): Promise<void>
  clearCommandHistory(target: string | null): Promise<void>
  pickFolder(title: string, start: 'logs' | 'downloads'): Promise<string | null>
  openLogFolder(): Promise<void>
  prepareRemoteEdit(remoteName: string): Promise<string>
  openInEditor(localPath: string): Promise<void>
  /** Đường dẫn của file kéo thả từ hệ điều hành. */
  pathForFile(file: File): string
  getSettings(): Promise<AppSettings>
  updateSettings(patch: SettingsPatch): Promise<AppSettings>
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void
  listSnippets(): Promise<SnippetSummary[]>
  saveSnippet(input: SnippetInput): Promise<MutationResult>
  deleteSnippet(id: string): Promise<void>
  generateKey(options: {
    name: string
    type: 'ed25519' | 'rsa' | 'ecdsa'
    bits?: number
    passphrase?: string
  }): Promise<MutationResult>
  publicKey(id: string): Promise<string>
  exportPrivateKey(id: string): Promise<FileResult | null>
  updateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  vaultState(): Promise<VaultState>
  createVault(password: string): Promise<VaultResult>
  unlockVault(password: string): Promise<VaultResult>
  lockVault(): Promise<void>
  vaultSecurity(): Promise<VaultSecurity>
  changeMasterPassword(current: string, next: string): Promise<VaultResult>
  /** Bật cần nhập lại master password; tắt thì `password` = null. */
  setRememberOnDevice(enabled: boolean, password: string | null): Promise<VaultResult>
  exportBackup(): Promise<FileResult | null>
  restoreBackup(password: string): Promise<FileResult | null>
  onVaultState(listener: (state: VaultState) => void): () => void
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
  rdpCheck(hostId: string): Promise<RdpCheckResult>
  rdpLaunch(request: RdpLaunchRequest): Promise<RdpLaunchResult>
  rdpStop(launchId: string): Promise<void>
  onRdpStatus(listener: (event: RdpStatusEvent) => void): () => void
  scanRdpFiles(): Promise<FileImportScan>
  importRdpFiles(aliases: string[]): Promise<{ imported: number; skipped: string[] }>
  rdpViewPrepare(hostId: string): Promise<RdpViewPrepare>
  rdpViewProbe(request: RdpViewProbeRequest): Promise<RdpViewProbeResult>
  rdpViewTrust(hostId: string, fingerprint: string): Promise<void>
  rdpViewOpen(request: RdpViewOpenRequest): Promise<RdpViewOpenResult>
}
