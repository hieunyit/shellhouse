import { Clipboard, Columns2, Copy, Eraser, Rows2, TextSelect } from 'lucide-react'
import { create } from 'zustand'
import { t } from '@shared/i18n'
import { ContextMenu } from '../components/ContextMenu'
import { isMac } from '../lib/keybindings'
import { useTabs } from '../stores/tabs'
import { controllers } from './registry'

/** Menu chuột phải của terminal — một bản cho cả app (hiện đúng cả khi terminal đang ở MultiExec). */
export const useTerminalMenu = create<{
  menu: { tabId: string; x: number; y: number } | null
  open: (tabId: string, x: number, y: number) => void
  close: () => void
}>((set) => ({
  menu: null,
  open: (tabId, x, y) => {
    set({ menu: { tabId, x, y } })
  },
  close: () => {
    set({ menu: null })
  }
}))

const COPY_HINT = isMac ? '⌘C' : 'Ctrl+Shift+C'
const PASTE_HINT = isMac ? '⌘V' : 'Ctrl+Shift+V'

export function TerminalMenu(): React.JSX.Element | null {
  const menu = useTerminalMenu((s) => s.menu)
  if (!menu) return null
  const controller = controllers.get(menu.tabId)
  const close = (): void => {
    useTerminalMenu.getState().close()
  }
  const split = (direction: 'right' | 'below'): void => {
    useTabs.getState().activate(menu.tabId)
    useTabs.getState().split(direction)
  }
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      onClose={close}
      entries={[
        {
          id: 'term-copy',
          label: t('Copy'),
          icon: <Copy size={14} />,
          hint: COPY_HINT,
          disabled: !controller?.hasSelection(),
          onSelect: () => controller?.copySelection()
        },
        {
          id: 'term-paste',
          label: t('Paste'),
          icon: <Clipboard size={14} />,
          hint: PASTE_HINT,
          onSelect: () => controller?.pasteFromClipboard()
        },
        {
          id: 'term-select-all',
          label: t('Select all'),
          icon: <TextSelect size={14} />,
          onSelect: () => controller?.selectAll()
        },
        'separator',
        {
          id: 'term-clear',
          label: t('Clear terminal'),
          icon: <Eraser size={14} />,
          onSelect: () => controller?.clear()
        },
        'separator',
        {
          id: 'term-split-right',
          label: t('Split right'),
          icon: <Columns2 size={14} />,
          onSelect: () => {
            split('right')
          }
        },
        {
          id: 'term-split-down',
          label: t('Split down'),
          icon: <Rows2 size={14} />,
          onSelect: () => {
            split('below')
          }
        }
      ]}
    />
  )
}
