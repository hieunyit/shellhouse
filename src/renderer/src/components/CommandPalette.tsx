import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CornerDownLeft,
  LayoutGrid,
  Search,
  Server,
  SquareChevronRight,
  SquareTerminal
} from 'lucide-react'
import { openWorkspace } from './WorkspacesDialog'
import { COMMANDS, keybindingFor } from '@shared/commands'
import { bestScore } from '@shared/fuzzy'
import { displayKeybinding, isMac } from '../lib/keybindings'
import { useHosts } from '../stores/hosts'
import { useSettings } from '../stores/settings'
import { useShells } from '../stores/shells'
import { useTabs } from '../stores/tabs'
import { cx, useEscapeToClose, useFocusTrap } from './ui'
import { MANIFESTS } from '../../../modules/registry/manifests'
import { ModuleIcon, rendererModule, useModules } from '../../../modules/registry/renderer-kit'
import { searchModules } from '../../../modules/registry/search'
import { requestEnableModule } from '../stores/module-ui'

interface Item {
  id: string
  title: string
  hint: string
  group: 'Commands' | 'Hosts'
  icon: ReactNode
  /** Phím tắt (hiện dạng phím) thay vì chữ gợi ý thường. */
  shortcut: boolean
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
  // Esc ở cấp window (không phụ thuộc focus đang ở ô nhập), theo ngăn xếp hộp thoại.
  useEscapeToClose(onClose)
  const overrides = useSettings((s) => s.settings.keybindings)
  const hosts = useHosts((s) => s.tree.hosts)
  const shells = useShells((s) => s.shells)
  const workspaces = useSettings((s) => s.settings.workspaces)
  const moduleStates = useModules((s) => s.states)

  const items = useMemo<Item[]>(() => {
    const commands: Item[] = COMMANDS.filter((c) => c.id !== 'palette.open').map((c) => ({
      id: c.id,
      title: c.title,
      // Lệnh không có phím tắt: không hiện gì (thay vì "—").
      hint: ((key) => (key ? displayKeybinding(key) : ''))(keybindingFor(c.id, overrides, isMac)),
      group: 'Commands' as const,
      icon: <SquareChevronRight size={14} />,
      shortcut: true,
      run: () => {
        runCommand(c.id)
      }
    }))
    const connect: Item[] = hosts.map((h) => ({
      id: `host:${h.id}`,
      title: `Connect: ${h.label}`,
      hint: `${h.username}@${h.hostname}`,
      group: 'Hosts' as const,
      icon: <Server size={14} />,
      shortcut: false,
      run: () => {
        useTabs.getState().addHost({ id: h.id, label: h.label })
      }
    }))
    const terminals: Item[] = shells.map((sh) => ({
      id: `shell:${sh.id}`,
      title: `New terminal: ${sh.name}`,
      hint: '',
      group: 'Commands' as const,
      icon: <SquareTerminal size={14} />,
      shortcut: false,
      run: () => {
        useTabs.getState().addLocal(sh.id)
      }
    }))
    const layouts: Item[] = workspaces.map((w) => ({
      id: `workspace:${w.id}`,
      title: `Open workspace: ${w.name}`,
      hint: `${w.items.length} tab${w.items.length === 1 ? '' : 's'}`,
      group: 'Commands' as const,
      icon: <LayoutGrid size={14} />,
      shortcut: false,
      run: () => {
        openWorkspace(w)
      }
    }))
    // Module (ADR-014 mục 3.12.2): cùng bộ tìm của trang Modules — "container" tìm ra Docker.
    const modules = MANIFESTS.map((manifest) => ({
      manifest,
      enabled: moduleStates[manifest.id]?.enabled === true
    }))
    const moduleCommands = (id: string): Item[] => {
      const m = rendererModule(id)
      return (m?.commands?.() ?? []).map((c) => ({
        id: `module:${id}:${c.id}`,
        title: `${m?.manifest.name ?? id}: ${c.title}`,
        hint: '',
        group: 'Commands' as const,
        icon: <ModuleIcon name={m?.manifest.icon} size={14} />,
        shortcut: false,
        run: () => {
          c.run()
        }
      }))
    }
    const enableItem = (m: (typeof MANIFESTS)[number]): Item => ({
      id: `module-enable:${m.id}`,
      title: `Modules: Enable ${m.name}`,
      hint: m.summary,
      group: 'Commands' as const,
      icon: <ModuleIcon name={m.icon} size={14} />,
      shortcut: false,
      run: () => void requestEnableModule(m.id)
    })
    const enabledCommands = modules
      .filter((m) => m.enabled)
      .flatMap((m) => moduleCommands(m.manifest.id))
    const all = [...commands, ...enabledCommands, ...layouts, ...terminals, ...connect]
    if (!query.trim()) return all
    const matchedModules = searchModules(modules, query)
    const moduleItems = matchedModules.flatMap((m) =>
      m.enabled ? moduleCommands(m.manifest.id) : [enableItem(m.manifest)]
    )
    const seen = new Set(moduleItems.map((i) => i.id))
    return [
      ...moduleItems,
      ...all
        .filter((item) => !seen.has(item.id))
        .map((item) => ({ item, score: bestScore(query, [item.title, item.hint]) }))
        .filter((r): r is { item: Item; score: number } => r.score !== null)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.item)
    ]
  }, [query, overrides, hosts, shells, workspaces, runCommand, moduleStates])

  // Giữ mục đang chọn trong vùng nhìn thấy khi di chuyển bằng phím mũi tên.
  useEffect(() => {
    document.getElementById(`palette-opt-${cursor}`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const run = (item: Item | undefined): void => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <div
      className="bg-overlay animate-fade-in fixed inset-0 z-40 flex items-start justify-center pt-24 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        className="shadow-elevated animate-dialog-in w-full max-w-xl overflow-hidden rounded-xl border border-line bg-elevated"
        onMouseDown={(e) => {
          e.stopPropagation()
        }}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={16} className="shrink-0 text-faint" />
          <input
            autoFocus
            className="min-w-0 flex-1 bg-transparent py-3 text-sm text-fg outline-none placeholder:text-faint"
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
        </div>
        <div id="palette-list" className="max-h-80 overflow-auto p-1.5" role="listbox">
          {items.map((item, i) => (
            <div key={item.id}>
              {!query.trim() && item.group !== items[i - 1]?.group && (
                <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">
                  {item.group}
                </div>
              )}
              <button
                type="button"
                id={`palette-opt-${i}`}
                tabIndex={-1}
                role="option"
                aria-selected={i === cursor}
                data-testid="palette-item"
                data-command={item.id}
                className={cx(
                  'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px]',
                  i === cursor ? 'bg-accent-soft text-fg' : 'text-fg'
                )}
                onMouseMove={() => {
                  if (i !== cursor) setCursor(i)
                }}
                onClick={() => {
                  run(item)
                }}
              >
                <span className={i === cursor ? 'text-accent' : 'text-faint'}>{item.icon}</span>
                <span className="flex-1 truncate">{item.title}</span>
                {item.hint &&
                  (item.shortcut ? (
                    <kbd className="rounded border border-line bg-subtle px-1.5 py-px font-mono text-[11px] text-muted">
                      {item.hint}
                    </kbd>
                  ) : (
                    <span className="truncate font-mono text-xs text-faint">{item.hint}</span>
                  ))}
              </button>
            </div>
          ))}
          {items.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-faint">
              No matching commands or hosts.
            </p>
          )}
        </div>
        <div className="flex items-center gap-4 border-t border-line bg-subtle/50 px-4 py-2 text-xs text-faint">
          <span>↑↓ to navigate</span>
          <span className="inline-flex items-center gap-1">
            <CornerDownLeft size={11} /> to run
          </span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  )
}
