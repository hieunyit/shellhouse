import { useMemo, useRef, useState } from 'react'
import { COMMANDS, keybindingFor } from '@shared/commands'
import { bestScore } from '@shared/fuzzy'
import { displayKeybinding, isMac } from '../lib/keybindings'
import { useHosts } from '../stores/hosts'
import { useSettings } from '../stores/settings'
import { useTabs } from '../stores/tabs'
import { useFocusTrap } from './ui'

interface Item {
  id: string
  title: string
  hint: string
  run: () => void
}

/** Bảng lệnh: mọi lệnh của app + kết nối nhanh tới host đã lưu. Tìm kiếm mờ, Enter để chạy. */
export function CommandPalette({
  onClose,
  runCommand
}: {
  onClose: () => void
  runCommand: (id: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  const overrides = useSettings((s) => s.settings.keybindings)
  const hosts = useHosts((s) => s.tree.hosts)

  const items = useMemo<Item[]>(() => {
    const commands: Item[] = COMMANDS.filter((c) => c.id !== 'palette.open').map((c) => ({
      id: c.id,
      title: c.title,
      hint: displayKeybinding(keybindingFor(c.id, overrides, isMac)),
      run: () => {
        runCommand(c.id)
      }
    }))
    const connect: Item[] = hosts.map((h) => ({
      id: `host:${h.id}`,
      title: `Connect: ${h.label}`,
      hint: `${h.username}@${h.hostname}`,
      run: () => {
        useTabs.getState().addHost({ id: h.id, label: h.label })
      }
    }))
    const all = [...commands, ...connect]
    if (!query.trim()) return all
    return all
      .map((item) => ({ item, score: bestScore(query, [item.title, item.hint]) }))
      .filter((r): r is { item: Item; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item)
  }, [query, overrides, hosts, runCommand])

  const run = (item: Item | undefined): void => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-24 dark:bg-black/60"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        className="shadow-elevated w-full max-w-xl overflow-hidden rounded-xl border border-line bg-elevated"
        onMouseDown={(e) => {
          e.stopPropagation()
        }}
      >
        <input
          autoFocus
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-fg outline-none placeholder:text-faint"
          placeholder="Type a command or host name…"
          data-testid="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[cursor] ? `palette-opt-${cursor}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(c + 1, items.length - 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              run(items[cursor])
            }
          }}
        />
        <div id="palette-list" className="max-h-80 overflow-auto py-1" role="listbox">
          {items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              id={`palette-opt-${i}`}
              tabIndex={-1}
              role="option"
              aria-selected={i === cursor}
              data-testid="palette-item"
              data-command={item.id}
              className={`flex w-full items-center px-4 py-1.5 text-left text-[13px] text-fg ${i === cursor ? 'bg-accent-soft' : 'hover:bg-hover'}`}
              onMouseEnter={() => {
                setCursor(i)
              }}
              onClick={() => {
                run(item)
              }}
            >
              <span className="flex-1 truncate">{item.title}</span>
              <span className="ml-4 font-mono text-xs text-faint">{item.hint}</span>
            </button>
          ))}
          {items.length === 0 && <p className="px-4 py-2 text-sm text-faint">No results.</p>}
        </div>
      </div>
    </div>
  )
}
