import { useState } from 'react'
import {
  Activity,
  ChevronDown,
  Columns2,
  LayoutPanelLeft,
  LayoutGrid,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  RefreshCw,
  Rows2,
  ScrollText,
  Settings,
  SquareTerminal,
  Zap,
  House,
  RotateCcw
} from 'lucide-react'
import { parseQuickConnect } from '@shared/quick-connect'
import { keybindingFor } from '@shared/commands'
import { displayKeybinding, isMac } from '../lib/keybindings'
import { useSettings } from '../stores/settings'
import { useShells } from '../stores/shells'
import { useTabs } from '../stores/tabs'
import { useContextMenu, type MenuEntry } from './ContextMenu'
import { toggleMultiExec, useBroadcast } from '../terminal/broadcast'
import { cx, IconButton } from './ui'
import { ToolButton } from './files/parts'

function QuickConnect(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  return (
    <form
      // Co lại khi cửa sổ hẹp (chia đôi màn hình) — không đẩy các nút bên phải ra khỏi cửa sổ.
      className="flex min-w-32 shrink basis-60 items-center"
      onSubmit={(e) => {
        e.preventDefault()
        const target = parseQuickConnect(value)
        if (!target) {
          setInvalid(true)
          return
        }
        useTabs.getState().addSsh(target)
        setValue('')
        setInvalid(false)
      }}
    >
      <div
        className={cx(
          'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border bg-subtle px-2 transition-[border-color,box-shadow] duration-150',
          invalid
            ? 'border-danger ring-3 ring-danger/15'
            : 'border-line focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20'
        )}
      >
        <Zap size={13} className="shrink-0 text-faint" />
        <input
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="Quick connect: user@host:port"
          aria-label="Quick connect"
          aria-invalid={invalid}
          data-testid="quick-connect"
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-faint"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setInvalid(false)
          }}
        />
      </div>
    </form>
  )
}

export function TabBar({
  onOpenSnippets,
  onOpenSettings,
  onOpenDiagnostics,
  onOpenWorkspaces
}: {
  onOpenSnippets: () => void
  onOpenSettings: () => void
  onOpenDiagnostics: () => void
  onOpenWorkspaces: () => void
}): React.JSX.Element {
  const addLocal = useTabs((s) => s.addLocal)
  const { menu, open: openMenu } = useContextMenu()
  const split = useTabs((s) => s.split)
  const hasTab = useTabs((s) => s.activeId !== null)
  const tabCount = useTabs((s) => s.tabs.length)
  const broadcasting = useBroadcast((s) => s.enabled)
  const sidebarHidden = useSettings((s) => s.settings.appearance.sidebarHidden)
  const overrides = useSettings((s) => s.settings.keybindings)
  const updateSettings = useSettings((s) => s.update)
  const key = (id: string): string => displayKeybinding(keybindingFor(id, overrides, isMac))

  return (
    <nav className="@container flex h-11 min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b border-line bg-surface px-2">
      <IconButton
        label={`${sidebarHidden ? 'Show' : 'Hide'} sidebar (${displayKeybinding(keybindingFor('sidebar.toggle', overrides, isMac))})`}
        data-testid="toggle-sidebar"
        aria-pressed={!sidebarHidden}
        onClick={() => void updateSettings({ appearance: { sidebarHidden: !sidebarHidden } })}
      >
        {sidebarHidden ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </IconButton>
      <IconButton
        label="Home"
        data-testid="open-home"
        onClick={() => {
          useTabs.getState().openHome()
        }}
      >
        <House size={15} />
      </IconButton>
      <div className="mx-0.5 h-4 w-px bg-line" />
      <button
        type="button"
        aria-label="New terminal"
        title="New terminal"
        data-testid="new-tab"
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-fg"
        onClick={() => addLocal()}
      >
        <Plus size={14} /> Terminal
      </button>
      <IconButton
        label="Choose a shell"
        size="sm"
        className="-ml-1 size-7"
        data-testid="new-tab-menu"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const { shells, defaultId } = useShells.getState()
          openMenu(
            { clientX: rect.left, clientY: rect.bottom + 4, preventDefault: () => undefined },
            [
              ...shells.map((s): MenuEntry => ({
                id: `shell-${s.id}`,
                label: s.name,
                icon: <SquareTerminal size={14} />,
                ...(s.id === defaultId ? { hint: 'Default' } : {}),
                onSelect: () => {
                  addLocal(s.id)
                }
              })),
              ...(() => {
                // Tab đã đóng gần đây (mới nhất trước) — mở lại đúng tab muốn.
                const closed = useTabs.getState().closed
                if (!closed.length) return []
                return [
                  'separator' as const,
                  {
                    id: 'recent-header',
                    label: 'Recently closed',
                    disabled: true,
                    onSelect: () => undefined
                  },
                  ...closed
                    .map((c, i) => ({ c, i }))
                    .reverse()
                    .map(({ c, i }): MenuEntry => ({
                      id: `reopen-${String(i)}`,
                      label: c.title,
                      icon: <RotateCcw size={14} />,
                      onSelect: () => {
                        useTabs.getState().reopenClosed(i)
                      }
                    }))
                ]
              })(),
              'separator',
              {
                id: 'shell-refresh',
                label: 'Refresh shell list',
                icon: <RefreshCw size={14} />,
                onSelect: () => void useShells.getState().load(true)
              }
            ]
          )
        }}
      >
        <ChevronDown size={14} />
      </IconButton>
      {menu}
      <div className="mx-1 h-4 w-px shrink-0 bg-line" />
      {/* Bố cục: chia màn hình gom vào một menu. Chữ chỉ hiện khi thanh đủ rộng; cửa sổ rất hẹp thì
          ẩn hẳn (vẫn có phím tắt, bảng lệnh, menu chuột phải của tab). */}
      <span className="hidden @lg:contents">
        <ToolButton
          icon={<LayoutPanelLeft size={15} />}
          label="Layout"
          labelAt="4xl"
          testId="layout-menu"
          trailing={<ChevronDown size={12} className="hidden text-faint @4xl:inline" />}
          disabled={!hasTab}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            openMenu(
              { clientX: rect.left, clientY: rect.bottom + 4, preventDefault: () => undefined },
              [
                {
                  id: 'split-right',
                  label: 'Split right',
                  icon: <Columns2 size={14} />,
                  hint: key('pane.splitRight'),
                  onSelect: () => split('right')
                },
                {
                  id: 'split-below',
                  label: 'Split down',
                  icon: <Rows2 size={14} />,
                  hint: key('pane.splitDown'),
                  onSelect: () => split('below')
                }
              ]
            )
          }}
        />
      </span>
      <span className="hidden @xl:contents">
        <ToolButton
          icon={<LayoutGrid size={15} />}
          label="Workspaces"
          labelAt="4xl"
          testId="open-workspaces"
          onClick={onOpenWorkspaces}
        />
        <ToolButton
          icon={<ScrollText size={15} />}
          label="Snippets"
          labelAt="4xl"
          testId="open-snippets"
          onClick={onOpenSnippets}
        />
      </span>
      <ToolButton
        icon={<Radio size={15} />}
        label={broadcasting ? 'Exit MultiExec' : 'MultiExec'}
        labelAt="4xl"
        testId="toggle-broadcast"
        title={
          broadcasting
            ? 'Exit MultiExec'
            : 'MultiExec: show all terminals and type into them at once'
        }
        pressed={broadcasting}
        tone={broadcasting ? 'warning' : undefined}
        disabled={tabCount < 2 && !broadcasting}
        onClick={toggleMultiExec}
      />
      <div className="flex-1" />
      <QuickConnect />
      <div className="mx-1 h-4 w-px bg-line" />
      <IconButton
        label="Lock (sessions keep running)"
        data-testid="lock-vault"
        onClick={() => void window.shellhouse.lockVault()}
      >
        <Lock size={15} />
      </IconButton>
      <IconButton label="Diagnostics" data-testid="toggle-diagnostics" onClick={onOpenDiagnostics}>
        <Activity size={15} />
      </IconButton>
      <IconButton label="Settings" data-testid="open-settings" onClick={onOpenSettings}>
        <Settings size={15} />
      </IconButton>
    </nav>
  )
}
