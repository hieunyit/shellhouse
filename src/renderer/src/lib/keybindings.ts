import { COMMANDS, effectiveKeybindings, eventToKeybinding } from '@shared/commands'
import { t } from '@shared/i18n'
import { useSettings } from '../stores/settings'

export const isMac = navigator.userAgent.includes('Mac OS')

let cacheFor: Readonly<Record<string, string>> | null = null
let cache = new Map<string, string>()

function bindings(): Map<string, string> {
  const overrides = useSettings.getState().settings.keybindings
  if (overrides !== cacheFor) {
    cacheFor = overrides
    cache = effectiveKeybindings(overrides, isMac)
  }
  return cache
}

/** Lệnh ứng với phím vừa bấm (theo cài đặt hiện tại), hoặc null. */
export function matchCommand(event: KeyboardEvent): string | null {
  if (event.type !== 'keydown') return null
  const key = eventToKeybinding(event)
  return key ? (bindings().get(key) ?? null) : null
}

/** Hiển thị phím cho người dùng (macOS dùng ký hiệu ⌘ ⇧ ⌥ ⌃). */
export function displayKeybinding(key: string | null): string {
  if (!key) return '—'
  if (!isMac) return key
  const symbols: Record<string, string> = { Meta: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' }
  return key
    .split('+')
    .map((p) => symbols[p] ?? p)
    .join('')
}

/**
 * Tên lệnh đã dịch (phím tắt, command palette, cài đặt phím tắt). `COMMANDS[].title` giữ tiếng Anh;
 * lệnh lạ → tiếng Anh gốc hoặc chính id.
 */
export function commandTitle(id: string): string {
  switch (id) {
    case 'tab.new':
      return t('New terminal')
    case 'tab.close':
      return t('Close tab')
    case 'tab.next':
      return t('Next tab')
    case 'tab.prev':
      return t('Previous tab')
    case 'tab.reconnect':
      return t('Reconnect tab')
    case 'tab.duplicate':
      return t('Duplicate tab')
    case 'tab.reopen':
      return t('Reopen closed tab')
    case 'sidebar.toggle':
      return t('Show / hide sidebar')
    case 'pane.splitRight':
      return t('Split right')
    case 'pane.splitDown':
      return t('Split down')
    case 'hosts.search':
      return t('Search hosts')
    case 'hosts.new':
      return t('New host')
    case 'hosts.import':
      return t('Import hosts (ssh config, MobaXterm, Termius, CSV)')
    case 'hosts.export':
      return t('Export hosts (Shellhouse YAML, OpenSSH config, CSV)')
    case 'quickconnect.focus':
      return t('Quick connect')
    case 'snippets.open':
      return t('Open snippets')
    case 'palette.open':
      return t('Command palette')
    case 'settings.open':
      return t('Open settings')
    case 'keychain.open':
      return t('Keychain: accounts and SSH keys')
    case 'vault.lock':
      return t('Lock vault')
    case 'multiexec.toggle':
      return t('MultiExec: type into all terminals')
    case 'terminal.find':
      return t('Find in terminal')
    case 'terminal.zoomIn':
      return t('Terminal: bigger text')
    case 'terminal.zoomOut':
      return t('Terminal: smaller text')
    case 'terminal.zoomReset':
      return t('Terminal: default text size')
    case 'workspaces.open':
      return t('Workspaces: save or open a layout')
    case 'modules.browse':
      return t('Modules: Browse')
    case 'diagnostics.toggle':
      return t('Toggle diagnostics')
    case 'view.focus':
      return t('Focus mode: only the terminal')
    default:
      return COMMANDS.find((c) => c.id === id)?.title ?? id
  }
}
