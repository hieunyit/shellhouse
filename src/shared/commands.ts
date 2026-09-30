/** Lệnh của app — dùng cho phím tắt, command palette và trang cài đặt phím tắt. */
export interface CommandDef {
  id: string
  title: string
  /** Phím mặc định: [macOS, Windows/Linux]; null = không có. */
  keys: [string | null, string | null]
}

export const COMMANDS: readonly CommandDef[] = [
  { id: 'tab.new', title: 'New terminal', keys: ['Meta+T', 'Ctrl+Shift+T'] },
  { id: 'tab.close', title: 'Close tab', keys: ['Meta+W', 'Ctrl+Shift+W'] },
  { id: 'tab.next', title: 'Next tab', keys: ['Ctrl+Tab', 'Ctrl+Tab'] },
  { id: 'tab.prev', title: 'Previous tab', keys: ['Ctrl+Shift+Tab', 'Ctrl+Shift+Tab'] },
  { id: 'tab.reconnect', title: 'Reconnect tab', keys: ['Meta+Shift+R', 'Ctrl+Shift+R'] },
  { id: 'tab.duplicate', title: 'Duplicate tab', keys: [null, null] },
  { id: 'sidebar.toggle', title: 'Show / hide sidebar', keys: ['Meta+B', 'Ctrl+Shift+B'] },
  { id: 'pane.splitRight', title: 'Split right', keys: ['Meta+D', 'Ctrl+Shift+D'] },
  { id: 'pane.splitDown', title: 'Split down', keys: ['Meta+E', 'Ctrl+Shift+E'] },
  { id: 'hosts.search', title: 'Search hosts', keys: ['Meta+K', 'Ctrl+Shift+K'] },
  { id: 'hosts.new', title: 'New host', keys: [null, null] },
  {
    id: 'hosts.import',
    title: 'Import hosts (ssh config, MobaXterm, Termius, CSV)',
    keys: [null, null]
  },
  { id: 'quickconnect.focus', title: 'Quick connect', keys: [null, null] },
  { id: 'snippets.open', title: 'Open snippets', keys: ['Meta+S', 'Ctrl+Shift+S'] },
  { id: 'palette.open', title: 'Command palette', keys: ['Meta+Shift+P', 'Ctrl+Shift+P'] },
  { id: 'settings.open', title: 'Open settings', keys: ['Meta+,', 'Ctrl+,'] },
  { id: 'vault.lock', title: 'Lock vault', keys: ['Meta+Shift+L', 'Ctrl+Shift+L'] },
  {
    id: 'multiexec.toggle',
    title: 'MultiExec: type into all terminals',
    keys: ['Meta+Shift+M', 'Ctrl+Shift+M']
  },
  { id: 'workspaces.open', title: 'Workspaces: save or open a layout', keys: [null, null] },
  { id: 'modules.browse', title: 'Modules: Browse', keys: [null, null] },
  { id: 'diagnostics.toggle', title: 'Toggle diagnostics', keys: [null, null] }
]

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

const CODE_NAMES: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
}

/** Tên phím theo vị trí vật lý (event.code) → không phụ thuộc bố cục bàn phím / Shift. */
export function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  // Object.hasOwn: tra bảng bằng object thường với key tuỳ ý sẽ trả về hàm kế thừa từ prototype
  // (ví dụ "valueOf", "constructor") — fuzz tìm ra.
  return Object.hasOwn(CODE_NAMES, code) ? (CODE_NAMES[code] ?? null) : null
}

export interface KeyEventLike {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** "Ctrl+Shift+T" từ một sự kiện bàn phím; null nếu chỉ là phím bổ trợ. */
export function eventToKeybinding(e: KeyEventLike): string | null {
  const key = keyName(e.code)
  if (!key) return null
  const mods = [
    e.ctrlKey && 'Ctrl',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Meta'
  ].filter((m): m is string => typeof m === 'string')
  return [...mods, key].join('+')
}

/** Chuẩn hoá chuỗi người dùng/cài đặt: thứ tự modifier cố định, không phân biệt hoa thường. */
export function normalizeKeybinding(raw: string): string | null {
  const parts = raw
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  const key = parts.pop()
  if (!key) return null
  const mods = new Set(parts.map((p) => p.toLowerCase()))
  const alias: Record<string, string> = {
    cmd: 'meta',
    command: 'meta',
    control: 'ctrl',
    option: 'alt'
  }
  const normalized = MODIFIERS.filter(
    (m) => mods.has(m.toLowerCase()) || [...mods].some((x) => alias[x] === m.toLowerCase())
  )
  const keyNorm =
    key.length === 1 ? key.toUpperCase() : `${key.charAt(0).toUpperCase()}${key.slice(1)}`
  return [...normalized, keyNorm].join('+')
}

/**
 * Phím tắt hiệu lực: mặc định theo nền tảng + ghi đè của người dùng ('' = bỏ).
 * Trả về map phím → lệnh (lệnh đứng sau trong danh sách thua khi trùng — xem findConflicts).
 */
export function effectiveKeybindings(
  overrides: Readonly<Record<string, string>>,
  isMac: boolean
): Map<string, string> {
  const byKey = new Map<string, string>()
  for (const cmd of COMMANDS) {
    const raw = cmd.id in overrides ? overrides[cmd.id] : cmd.keys[isMac ? 0 : 1]
    const key = raw ? normalizeKeybinding(raw) : null
    if (key && !byKey.has(key)) byKey.set(key, cmd.id)
  }
  return byKey
}

export function keybindingFor(
  commandId: string,
  overrides: Readonly<Record<string, string>>,
  isMac: boolean
): string | null {
  const cmd = COMMANDS.find((c) => c.id === commandId)
  if (!cmd) return null
  const raw = commandId in overrides ? overrides[commandId] : cmd.keys[isMac ? 0 : 1]
  return raw ? normalizeKeybinding(raw) : null
}

/** Các phím được gán cho hơn một lệnh. */
export function findConflicts(
  overrides: Readonly<Record<string, string>>,
  isMac: boolean
): Map<string, string[]> {
  const byKey = new Map<string, string[]>()
  for (const cmd of COMMANDS) {
    const key = keybindingFor(cmd.id, overrides, isMac)
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), cmd.id])
  }
  return new Map([...byKey].filter(([, ids]) => ids.length > 1))
}

/** Phím tắt không nên dùng vì terminal/shell cần (Ctrl+C, Ctrl+D...). */
export function reservedForTerminal(key: string): boolean {
  return /^Ctrl\+[A-Z[\]\\]$/.test(key) || key === 'Ctrl+Space'
}
