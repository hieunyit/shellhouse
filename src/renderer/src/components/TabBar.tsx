import { useState } from 'react'
import { Columns2, Info, Lock, Plus, Rows2, ScrollText, Settings, Zap } from 'lucide-react'
import { parseQuickConnect } from '@shared/quick-connect'
import { useTabs } from '../stores/tabs'
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
          'flex h-7 items-center gap-1.5 rounded-md border bg-subtle px-2',
          invalid ? 'border-danger' : 'border-line focus-within:border-accent'
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
  onOpenDiagnostics
}: {
  onOpenSnippets: () => void
  onOpenSettings: () => void
  onOpenDiagnostics: () => void
}): React.JSX.Element {
  const addLocal = useTabs((s) => s.addLocal)
  const split = useTabs((s) => s.split)
  const hasTab = useTabs((s) => s.activeId !== null)

  return (
    <nav className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
      <button
        type="button"
        aria-label="New terminal"
        title="New terminal"
        data-testid="new-tab"
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted hover:bg-hover hover:text-fg"
        onClick={() => addLocal()}
      >
        <Plus size={14} /> Terminal
      </button>
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
