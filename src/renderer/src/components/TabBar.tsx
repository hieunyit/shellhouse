import { useState } from 'react'
import {
  ChevronDown,
  Columns2,
  Info,
  LayoutGrid,
  Lock,
  Plus,
  Radio,
  RefreshCw,
  Rows2,
  ScrollText,
  Settings,
  SquareTerminal,
  Zap
} from 'lucide-react'
import { parseQuickConnect } from '@shared/quick-connect'
import { useShells } from '../stores/shells'
import { useTabs } from '../stores/tabs'
import { useContextMenu, type MenuEntry } from './ContextMenu'
import { toggleMultiExec, useBroadcast } from '../terminal/broadcast'
import { cx, IconButton } from './ui'

function QuickConnect(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  return (
    <form
      className="flex items-center"
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
          'flex h-7 items-center gap-1.5 rounded-md border bg-subtle px-2 transition-[border-color,box-shadow] duration-150',
          invalid
            ? 'border-danger ring-3 ring-danger/15'
            : 'border-line focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20'
        )}
      >
        <Zap size={13} className="text-faint" />
        <input
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="Quick connect: user@host:port"
          aria-label="Quick connect"
          aria-invalid={invalid}
          data-testid="quick-connect"
          className="w-56 bg-transparent font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-faint"
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

  return (
    <nav className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
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
      <div className="mx-1 h-4 w-px bg-line" />
      <IconButton
        label="Split right"
        data-testid="split-right"
        disabled={!hasTab}
        onClick={() => split('right')}
      >
        <Columns2 size={15} />
      </IconButton>
      <IconButton
        label="Split down"
        data-testid="split-below"
        disabled={!hasTab}
        onClick={() => split('below')}
      >
        <Rows2 size={15} />
      </IconButton>
      <IconButton label="Snippets" data-testid="open-snippets" onClick={onOpenSnippets}>
        <ScrollText size={15} />
      </IconButton>
      <IconButton
        label="Workspaces: save or reopen a set of tabs"
        data-testid="open-workspaces"
        onClick={onOpenWorkspaces}
      >
        <LayoutGrid size={15} />
      </IconButton>
      <IconButton
        label={
          broadcasting
            ? 'Exit MultiExec'
            : 'MultiExec: show all terminals and type into them at once'
        }
        data-testid="toggle-broadcast"
        active={broadcasting}
        aria-pressed={broadcasting}
        disabled={tabCount < 2 && !broadcasting}
        className={broadcasting ? 'text-warning' : ''}
        onClick={toggleMultiExec}
      >
        <Radio size={15} />
      </IconButton>
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
        <Info size={15} />
      </IconButton>
      <IconButton label="Settings" data-testid="open-settings" onClick={onOpenSettings}>
        <Settings size={15} />
      </IconButton>
    </nav>
  )
}
