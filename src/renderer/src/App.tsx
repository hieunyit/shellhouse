import { useCallback, useEffect, useRef, useState } from 'react'
import { CommandPalette } from './components/CommandPalette'
import { SettingsDialog, type SettingsSectionId } from './components/settings/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { SnippetsDialog } from './components/SnippetsDialog'
import { TabBar } from './components/TabBar'
import { Workspace } from './components/Workspace'
import { matchCommand } from './lib/keybindings'
import { useHosts } from './stores/hosts'
import { useTabs } from './stores/tabs'
import { controllers } from './terminal/registry'

type Overlay =
  | { kind: 'snippets' }
  | { kind: 'palette' }
  | {
      kind: 'settings'
      section?: SettingsSectionId
    }
  | null

export function App(): React.JSX.Element {
  const [overlay, setOverlay] = useState<Overlay>(null)
  const activeId = useTabs((s) => s.activeId)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void useHosts.getState().reload()
  }, [])

  // Mở sẵn một tab khi khởi động.
  useEffect(() => {
    if (useTabs.getState().tabs.length === 0) useTabs.getState().addLocal()
  }, [])

  const runCommand = useCallback((id: string): void => {
    const tabs = useTabs.getState()
    switch (id) {
      case 'tab.new':
        tabs.addLocal()
        break
      case 'tab.close':
        if (tabs.activeId) tabs.close(tabs.activeId)
        break
      case 'tab.next':
        tabs.cycle(1)
        break
      case 'tab.prev':
        tabs.cycle(-1)
        break
      case 'pane.splitRight':
        tabs.split('right')
        break
      case 'pane.splitDown':
        tabs.split('below')
        break
      case 'hosts.search':
        searchRef.current?.focus()
        searchRef.current?.select()
        break
      case 'snippets.open':
        setOverlay({ kind: 'snippets' })
        break
      case 'palette.open':
        setOverlay({ kind: 'palette' })
        break
      case 'settings.open':
        setOverlay({ kind: 'settings' })
        break
      case 'vault.lock':
        void window.shellhouse.lockVault()
        break
      case 'diagnostics.toggle':
        setOverlay((o) =>
          o?.kind === 'settings' && o.section === 'diagnostics'
            ? null
            : { kind: 'settings', section: 'diagnostics' }
        )
        break
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const command = matchCommand(event)
      if (!command) return
      // Đang ghi phím tắt trong trang cài đặt → để ô đó nhận phím.
      if ((event.target as HTMLElement | null)?.dataset['testid'] === 'shortcut-key') return
      event.preventDefault()
      runCommand(command)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [runCommand])

  const closeOverlay = (): void => {
    setOverlay(null)
    if (activeId) controllers.get(activeId)?.activate()
  }

  return (
    <div className="flex h-full">
      <Sidebar ref={searchRef} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar
          onOpenSnippets={() => {
            setOverlay({ kind: 'snippets' })
          }}
          onOpenSettings={() => {
            setOverlay({ kind: 'settings' })
          }}
          onOpenDiagnostics={() => {
            setOverlay({ kind: 'settings', section: 'diagnostics' })
          }}
        />
        <div className="relative min-h-0 flex-1">
          <Workspace />
        </div>
      </div>
      {overlay?.kind === 'snippets' && (
        <SnippetsDialog
          canInsert={activeId !== null && controllers.has(activeId)}
          onClose={closeOverlay}
          onInsert={(text, run) => {
            if (activeId) controllers.get(activeId)?.insertText(text, run)
          }}
        />
      )}
      {overlay?.kind === 'palette' && (
        <CommandPalette onClose={closeOverlay} runCommand={runCommand} />
      )}
      {overlay?.kind === 'settings' && (
        <SettingsDialog
          onClose={closeOverlay}
          {...(overlay.section ? { initial: overlay.section } : {})}
        />
      )}
    </div>
  )
}
