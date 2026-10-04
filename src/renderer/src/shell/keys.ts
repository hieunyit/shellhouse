import { keybindingFor } from '@shared/commands'
import { displayKeybinding, isMac } from '../lib/keybindings'

/** Phím tắt dạng "Ctrl Shift P" cho <Kbd> (macOS: ký hiệu liền nhau "⇧⌘P" → một ô). */
export function kbdKeys(id: string, overrides: Readonly<Record<string, string>>): string | null {
  const key = keybindingFor(id, overrides, isMac)
  if (!key) return null
  return isMac ? displayKeybinding(key) : key.split('+').join(' ')
}
