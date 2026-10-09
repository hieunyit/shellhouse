import { z } from 'zod'
import { ProxyUrl } from './proxy'
import { DEFAULT_ENVIRONMENTS, EnvironmentDef, Environments } from './environments'
import { Workspace } from './workspaces'

/** Bảng màu terminal (định dạng theo xterm.js ITheme). */
export const TerminalTheme = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  /** Tối hay sáng — để app chọn theme theo hệ thống. */
  dark: z.boolean(),
  colors: z.object({
    background: z.string(),
    foreground: z.string(),
    cursor: z.string(),
    selectionBackground: z.string(),
    black: z.string(),
    red: z.string(),
    green: z.string(),
    yellow: z.string(),
    blue: z.string(),
    magenta: z.string(),
    cyan: z.string(),
    white: z.string(),
    brightBlack: z.string(),
    brightRed: z.string(),
    brightGreen: z.string(),
    brightYellow: z.string(),
    brightBlue: z.string(),
    brightMagenta: z.string(),
    brightCyan: z.string(),
    brightWhite: z.string()
  })
})
export type TerminalTheme = z.infer<typeof TerminalTheme>

const TerminalSettings = z.object({
  /** 'system' = theo chế độ sáng/tối của hệ điều hành. */
  themeId: z.string().max(64).catch('system'),
  darkThemeId: z.string().max(64).catch('shellhouse-dark'),
  lightThemeId: z.string().max(64).catch('shellhouse-light'),
  fontFamily: z.string().min(1).max(200).catch(''),
  fontSize: z.number().int().min(8).max(32).catch(14),
  /** 1.15: dễ đọc hơn 1.0 với JetBrains Mono mà vẫn gọn (VS Code dùng ~1.2). */
  lineHeight: z.number().min(1).max(2).catch(1.15),
  cursorStyle: z.enum(['block', 'bar', 'underline']).catch('block'),
  cursorBlink: z.boolean().catch(true),
  scrollback: z.number().int().min(1000).max(100_000).catch(10_000),
  copyOnSelect: z.boolean().catch(false),
  /** Shell cho tab terminal mới (id từ danh sách dò được); '' = tự chọn. */
  defaultShell: z.string().max(80).catch(''),
  /** Chuột phải trong terminal: hiện menu (Copy/Paste…) hoặc dán ngay như PuTTY / MobaXterm. */
  rightClick: z.enum(['menu', 'paste']).catch('menu'),
  /** Gợi ý lệnh (chữ mờ sau con trỏ, → để nhận) từ lịch sử lệnh của từng host. */
  commandSuggestions: z.boolean().catch(true),
  /** Thanh CPU/RAM/ổ đĩa/mạng dưới terminal SSH (chỉ đo khi tab đang hiện; server Linux). */
  serverStats: z.boolean().catch(true),
  /** Bật cây accessibility của xterm.js để trình đọc màn hình đọc được output. Tốn thêm CPU. */
  screenReaderMode: z.boolean().catch(false),
  /** Dán văn bản nhiều dòng (shell không bật bracketed paste) → hỏi trước, tránh chạy nhầm lệnh. */
  warnMultilinePaste: z.boolean().catch(true),
  /** Đóng tab SSH đang kết nối → hỏi trước (luôn hỏi khi đang truyền file). */
  confirmCloseConnected: z.boolean().catch(true)
})

const SecuritySettings = z.object({
  /** 0 = tắt. */
  autoLockMinutes: z.number().int().min(0).max(240).catch(15),
  lockOnSuspend: z.boolean().catch(true),
  /** Lưu khoá vault vào keychain của hệ điều hành để mở app không cần master password. */
  rememberOnDevice: z.boolean().catch(false)
})

const AppearanceSettings = z.object({
  /** Giao diện app: theo hệ điều hành, hoặc cố định sáng/tối. */
  theme: z.enum(['system', 'light', 'dark']).catch('system'),
  /** Ngôn ngữ giao diện; 'system' = theo hệ điều hành. Đổi có hiệu lực sau khi khởi động lại. */
  language: z.enum(['system', 'en', 'vi']).catch('system'),
  /** Ẩn thanh bên (danh sách host) để terminal rộng hơn. */
  sidebarHidden: z.boolean().catch(false),
  /** Mục "Favorites" / "Recent" ở đầu thanh bên (host đã có trong cây nhóm — lặp lại cho nhanh). */
  showFavorites: z.boolean().catch(true),
  showRecent: z.boolean().catch(true),
  /** Mục "Needs attention" trên Home (vấn đề của cluster Kubernetes đang mở / đang theo dõi). */
  homeAttention: z.boolean().catch(true),
  /**
   * Home › Infrastructure: mở app là tự kết nối tới cluster / Docker đang theo dõi (mặc định: nguồn
   * thuộc môi trường Production) để lấy trạng thái.
   */
  homeMonitor: z.boolean().catch(true),
  /** Mở app: trang Home hay một terminal local; chưa chọn = Home. */
  startup: z.enum(['home', 'terminal']).optional().catch(undefined),
  /** Mật độ hiển thị: hàng 32 px (comfortable, mặc định) hay 28 px (compact). */
  density: z.enum(['comfortable', 'compact']).catch('comfortable')
})

const FileSettings = z.object({
  /** Chương trình mở file khi sửa file trên server; '' = ứng dụng mặc định của hệ điều hành. */
  editor: z.string().max(1024).catch(''),
  /** Sửa file văn bản bằng editor trong app (false = luôn mở bằng editor trên máy). */
  inApp: z.boolean().catch(true),
  /** Bấm đúp file trong SFTP: mở để sửa (tự tải lên khi lưu) hoặc tải về. */
  doubleClick: z.enum(['edit', 'download']).catch('edit'),
  /** Số yêu cầu SFTP cùng lúc khi duyệt / tạo / xoá thư mục (sftp-server xử lý tuần tự: >16 ít lợi). */
  sftpRequests: z.number().int().min(2).max(16).catch(8),
  /** Số file SFTP truyền cùng lúc. */
  sftpTransfers: z.number().int().min(1).max(8).catch(4)
})

const LoggingSettings = z.object({
  /** Tự ghi output của phiên ra file: tắt, chỉ phiên SSH, hoặc mọi phiên (kể cả terminal local). */
  mode: z.enum(['off', 'ssh', 'all']).catch('off'),
  /** '' = Documents/Shellhouse logs. */
  directory: z.string().max(1024).catch(''),
  /** Bỏ mã màu / điều khiển terminal → file văn bản thường, dễ đọc và tìm kiếm. */
  stripAnsi: z.boolean().catch(true)
})

const UpdateSettings = z.object({
  channel: z.enum(['stable', 'beta']).catch('stable'),
  autoCheck: z.boolean().catch(true)
})

/** Mạng (Settings › Network): proxy cho S3, Kubernetes API, kiểm tra cập nhật. */
const NetworkSettings = z.object({
  /** system = biến môi trường HTTPS_PROXY… (và proxy hệ thống cho cập nhật); none = thẳng. */
  proxyMode: z.enum(['system', 'none', 'manual']).catch('system'),
  proxyUrl: ProxyUrl.catch(''),
  /** Không đi qua proxy: localhost, .corp.local, 10.0.0.0/8… (cách nhau bằng dấu phẩy). */
  noProxy: z.string().max(2000).catch('localhost,127.0.0.1,::1'),
  /** Bỏ qua lỗi chứng chỉ khi kiểm tra / tải bản cập nhật. */
  updatesInsecure: z.boolean().catch(false)
})

/**
 * Trạng thái + cấu hình riêng của một module (ADR-014 mục 3.9). Trường cấu hình do schema của
 * module đọc (`looseObject` giữ nguyên các trường lõi không biết).
 */
export const ModuleEntry = z.looseObject({
  /** undefined = theo `enabledByDefault` của manifest. */
  enabled: z.boolean().optional().catch(undefined),
  /** Đã mở thẻ / trang chi tiết (bỏ nhãn NEW). */
  seen: z.boolean().optional().catch(undefined),
  /** Lần gợi ý bật gần nhất (ms) — tối đa 1 lần / 30 ngày. */
  suggestedAt: z.number().optional().catch(undefined),
  /** "Don't suggest again". */
  neverSuggest: z.boolean().optional().catch(undefined)
})
export type ModuleEntry = z.infer<typeof ModuleEntry>

const ModuleOptions = z.object({
  /** Gợi ý bật module khi phát hiện dấu hiệu (Docker trên server…). */
  suggest: z.boolean().catch(true)
})

/** Khoá nguồn của module: "k8s:<context>", "docker:<endpoint>", "s3:<account>". */
const SourceKey = z.string().regex(/^[a-z0-9-]{1,40}:.{1,200}$/)
const SourceEnvironments = z.record(SourceKey, z.string().min(1).max(32))

export const AppSettings = z.object({
  appearance: AppearanceSettings.catch(AppearanceSettings.parse({})),
  terminal: TerminalSettings.catch(TerminalSettings.parse({})),
  security: SecuritySettings.catch(SecuritySettings.parse({})),
  updates: UpdateSettings.catch(UpdateSettings.parse({})),
  network: NetworkSettings.catch(NetworkSettings.parse({})),
  files: FileSettings.catch(FileSettings.parse({})),
  logging: LoggingSettings.catch(LoggingSettings.parse({})),
  /** Ghi đè phím tắt: commandId → tổ hợp phím ('' = bỏ phím tắt). */
  keybindings: z.record(z.string().max(64), z.string().max(64)).catch({}),
  customThemes: z.array(TerminalTheme).max(100).catch([]),
  /** Bố cục tab đã lưu (mở lại bằng bảng lệnh). */
  workspaces: z.array(Workspace).max(50).catch([]),
  modules: z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), ModuleEntry).catch({}),
  moduleOptions: ModuleOptions.catch(ModuleOptions.parse({})),
  /** Môi trường (Settings › Environments) — luôn có Production. */
  environments: Environments.catch(DEFAULT_ENVIRONMENTS.map((e) => ({ ...e }))),
  /**
   * Môi trường của nguồn trong module (cluster, Docker endpoint, tài khoản S3): khoá
   * `<module>:<id nguồn>` → id môi trường.
   */
  sourceEnvironments: SourceEnvironments.catch({}),
  /**
   * Theo dõi ở Home (tự kết nối khi mở app) — ghi đè mặc định "Production thì theo dõi": khoá
   * `<module>:<id nguồn>` → bật / tắt.
   */
  sourceMonitor: z.record(SourceKey, z.boolean()).catch({})
})
export type AppSettings = z.infer<typeof AppSettings>

export const DEFAULT_SETTINGS: AppSettings = AppSettings.parse({})

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Cài đặt cũ → mới. 1.2: `files.s3Requests / s3Transfers` → `modules.s3.requests / transfers`
 * (ADR-014 mục 5.2 bước 5) — giữ giá trị người dùng đã chọn.
 */
function migrateLegacy(raw: object): object {
  const files = (raw as { files?: unknown }).files
  if (!isRecord(files) || (files['s3Requests'] === undefined && files['s3Transfers'] === undefined))
    return raw
  const modules = (raw as { modules?: unknown }).modules
  const allModules = isRecord(modules) ? modules : {}
  const s3 = isRecord(allModules['s3']) ? allModules['s3'] : {}
  return {
    ...raw,
    modules: {
      ...allModules,
      s3: {
        ...(files['s3Requests'] !== undefined ? { requests: files['s3Requests'] } : {}),
        ...(files['s3Transfers'] !== undefined ? { transfers: files['s3Transfers'] } : {}),
        ...s3
      }
    }
  }
}

/** Đọc cài đặt từ JSON bất kỳ: trường hỏng rơi về mặc định, không làm mất trường khác. */
export function parseSettings(raw: unknown): AppSettings {
  // Mảng cũng là "object" trong JS — phải loại ra (fuzz tìm ra: '[]' trong DB làm app crash).
  const base = migrateLegacy(
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  )
  const parsed = AppSettings.safeParse(base)
  return parsed.success ? parsed.data : AppSettings.parse({})
}

/**
 * Patch sâu 1 cấp cho các nhóm cài đặt — dạng renderer được gửi qua `settings:update`. Không có
 * `files.editor` (chương trình main sẽ chạy: chỉ đặt qua hộp thoại của main, `files:chooseEditor`),
 * `security.rememberOnDevice` (bật/tắt qua `vault:setRemember` để khoá trên máy luôn khớp),
 * `logging.directory` (nơi main ghi file: chỉ qua hộp thoại, `logs:chooseFolder`) và
 * `network.updatesInsecure` (tắt kiểm chứng chỉ: main hỏi xác nhận, `updates:setInsecure`).
 * Trường lạ bị zod bỏ đi, không báo lỗi.
 */
export const SettingsPatch = z.object({
  appearance: AppearanceSettings.partial().optional(),
  terminal: TerminalSettings.partial().optional(),
  security: SecuritySettings.omit({ rememberOnDevice: true }).partial().optional(),
  updates: UpdateSettings.partial().optional(),
  network: NetworkSettings.omit({ updatesInsecure: true }).partial().optional(),
  files: FileSettings.omit({ editor: true }).partial().optional(),
  logging: LoggingSettings.omit({ directory: true }).partial().optional(),
  keybindings: z.record(z.string().max(64), z.string().max(64)).optional(),
  customThemes: z.array(TerminalTheme).max(100).optional(),
  workspaces: z.array(Workspace).max(50).optional(),
  /** Mỗi module: gộp nông với giá trị hiện có. */
  modules: z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), ModuleEntry).optional(),
  moduleOptions: ModuleOptions.partial().optional(),
  /** Thay cả danh sách. */
  environments: z.array(EnvironmentDef).min(1).max(20).optional(),
  /** Gộp vào bảng hiện có; giá trị null = bỏ môi trường của nguồn đó. */
  sourceEnvironments: z.record(SourceKey, z.string().max(32).nullable()).optional(),
  /** Gộp vào bảng hiện có; null = về mặc định (theo môi trường). */
  sourceMonitor: z.record(SourceKey, z.boolean().nullable()).optional()
})
export type SettingsPatch = z.infer<typeof SettingsPatch>

/** Patch chỉ main dùng: thêm các trường renderer không được tự đặt. */
export type MainSettingsPatch = Omit<
  SettingsPatch,
  'security' | 'files' | 'network' | 'logging'
> & {
  security?: Partial<AppSettings['security']> | undefined
  files?: Partial<AppSettings['files']> | undefined
  network?: Partial<AppSettings['network']> | undefined
  logging?: Partial<AppSettings['logging']> | undefined
}

export function applyPatch(current: AppSettings, patch: MainSettingsPatch): AppSettings {
  return parseSettings({
    ...current,
    appearance: { ...current.appearance, ...patch.appearance },
    terminal: { ...current.terminal, ...patch.terminal },
    security: { ...current.security, ...patch.security },
    updates: { ...current.updates, ...patch.updates },
    network: { ...current.network, ...patch.network },
    files: { ...current.files, ...patch.files },
    logging: { ...current.logging, ...patch.logging },
    keybindings: patch.keybindings ?? current.keybindings,
    customThemes: patch.customThemes ?? current.customThemes,
    workspaces: patch.workspaces ?? current.workspaces,
    environments: patch.environments ?? current.environments,
    sourceEnvironments: patch.sourceEnvironments
      ? Object.fromEntries(
          Object.entries({ ...current.sourceEnvironments, ...patch.sourceEnvironments }).filter(
            (e): e is [string, string] => e[1] !== null
          )
        )
      : current.sourceEnvironments,
    sourceMonitor: patch.sourceMonitor
      ? Object.fromEntries(
          Object.entries({ ...current.sourceMonitor, ...patch.sourceMonitor }).filter(
            (e): e is [string, boolean] => e[1] !== null
          )
        )
      : current.sourceMonitor,
    modules: patch.modules
      ? {
          ...current.modules,
          ...Object.fromEntries(
            Object.entries(patch.modules).map(([id, entry]) => [
              id,
              { ...current.modules[id], ...entry }
            ])
          )
        }
      : current.modules,
    moduleOptions: { ...current.moduleOptions, ...patch.moduleOptions }
  })
}
