import { z } from 'zod'

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
  /** Bật cây accessibility của xterm.js để trình đọc màn hình đọc được output. Tốn thêm CPU. */
  screenReaderMode: z.boolean().catch(false)
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
  theme: z.enum(['system', 'light', 'dark']).catch('system')
})

const FileSettings = z.object({
  /** Chương trình mở file khi sửa file trên server; '' = ứng dụng mặc định của hệ điều hành. */
  editor: z.string().max(1024).catch(''),
  /** Bấm đúp file trong SFTP: mở để sửa (tự tải lên khi lưu) hoặc tải về. */
  doubleClick: z.enum(['edit', 'download']).catch('edit')
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

export const AppSettings = z.object({
  appearance: AppearanceSettings.catch(AppearanceSettings.parse({})),
  terminal: TerminalSettings.catch(TerminalSettings.parse({})),
  security: SecuritySettings.catch(SecuritySettings.parse({})),
  updates: UpdateSettings.catch(UpdateSettings.parse({})),
  files: FileSettings.catch(FileSettings.parse({})),
  logging: LoggingSettings.catch(LoggingSettings.parse({})),
  /** Ghi đè phím tắt: commandId → tổ hợp phím ('' = bỏ phím tắt). */
  keybindings: z.record(z.string().max(64), z.string().max(64)).catch({}),
  customThemes: z.array(TerminalTheme).max(100).catch([])
})
export type AppSettings = z.infer<typeof AppSettings>

export const DEFAULT_SETTINGS: AppSettings = AppSettings.parse({})

/** Đọc cài đặt từ JSON bất kỳ: trường hỏng rơi về mặc định, không làm mất trường khác. */
export function parseSettings(raw: unknown): AppSettings {
  // Mảng cũng là "object" trong JS — phải loại ra (fuzz tìm ra: '[]' trong DB làm app crash).
  const base = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const parsed = AppSettings.safeParse(base)
  return parsed.success ? parsed.data : AppSettings.parse({})
}

/** Patch sâu 1 cấp cho các nhóm cài đặt. */
export const SettingsPatch = z.object({
  appearance: AppearanceSettings.partial().optional(),
  terminal: TerminalSettings.partial().optional(),
  security: SecuritySettings.partial().optional(),
  updates: UpdateSettings.partial().optional(),
  files: FileSettings.partial().optional(),
  logging: LoggingSettings.partial().optional(),
  keybindings: z.record(z.string().max(64), z.string().max(64)).optional(),
  customThemes: z.array(TerminalTheme).max(100).optional()
})
export type SettingsPatch = z.infer<typeof SettingsPatch>

export function applyPatch(current: AppSettings, patch: SettingsPatch): AppSettings {
  return parseSettings({
    ...current,
    appearance: { ...current.appearance, ...patch.appearance },
    terminal: { ...current.terminal, ...patch.terminal },
    security: { ...current.security, ...patch.security },
    updates: { ...current.updates, ...patch.updates },
    files: { ...current.files, ...patch.files },
    logging: { ...current.logging, ...patch.logging },
    keybindings: patch.keybindings ?? current.keybindings,
    customThemes: patch.customThemes ?? current.customThemes
  })
}
