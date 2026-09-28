import { effectiveKeybindings, eventToKeybinding } from '@shared/commands'
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
