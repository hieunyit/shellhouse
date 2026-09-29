import { useCallback, useEffect, useRef, useState } from 'react'
import { CommandPalette } from './components/CommandPalette'
import type { SettingsSectionId } from './components/settings/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { Workspace } from './components/Workspace'
import { WorkspacesDialog } from './components/WorkspacesDialog'
import { preloadLazyParts, SettingsDialog, SnippetsDialog } from './lazy'
import { matchCommand } from './lib/keybindings'
import { useHosts } from './stores/hosts'
import { useSettings } from './stores/settings'
import { useShells } from './stores/shells'
import { useTabs } from './stores/tabs'
import { toggleMultiExec, useBroadcast } from './terminal/broadcast'
import { MultiExecView } from './terminal/MultiExecView'
import { TerminalMenu } from './terminal/TerminalMenu'
import { controllers } from './terminal/registry'

type Overlay =
  | { kind: 'snippets' }
  | { kind: 'palette' }
  | { kind: 'workspaces' }
  | {
      kind: 'settings'
      section?: SettingsSectionId
    }
  | null

export function App(): React.JSX.Element {
  const [overlay, setOverlay] = useState<Overlay>(null)
  const activeId = useTabs((s) => s.activeId)
  const multiExec = useBroadcast((s) => s.enabled)
  const sidebarHidden = useSettings((s) => s.settings.appearance.sidebarHidden)
  // Vào / ra MultiExec: terminal đổi chỗ → đo lại kích thước và focus vào tab đang chọn.
  useEffect(() => {
    const id = useTabs.getState().activeId
    if (!id) return
    const frame = requestAnimationFrame(() => {
      controllers.get(id)?.activate()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [multiExec])
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void useHosts.getState().reload()
  }, [])

  useEffect(() => {
    void preloadLazyParts()
  }, [])

  // Mở sẵn một tab khi khởi động (sau khi biết danh sách shell để đặt đúng tên tab).
  useEffect(() => {
    void useShells
      .getState()
      .load()
      .catch(() => undefined)
      .finally(() => {
        if (useTabs.getState().tabs.length === 0) useTabs.getState().addLocal()
      })
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
      case 'tab.reconnect':
        if (tabs.activeId) controllers.get(tabs.activeId)?.reconnect()
        break
      case 'tab.duplicate':
        if (tabs.activeId) tabs.duplicate(tabs.activeId)
        break
      case 'sidebar.toggle': {
        const { settings, update } = useSettings.getState()
        void update({ appearance: { sidebarHidden: !settings.appearance.sidebarHidden } })
        break
      }
      case 'pane.splitRight':
        tabs.split('right')
        break
      case 'pane.splitDown':
        tabs.split('below')
        break
      case 'hosts.search':
        // Thanh bên đang ẩn → hiện ra rồi mới focus ô tìm.
        void (async () => {
          const { settings, update } = useSettings.getState()
          if (settings.appearance.sidebarHidden)
            await update({ appearance: { sidebarHidden: false } })
          requestAnimationFrame(() => {
            searchRef.current?.focus()
            searchRef.current?.select()
          })
        })()
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
      case 'multiexec.toggle':
        toggleMultiExec()
        break
      case 'workspaces.open':
        setOverlay({ kind: 'workspaces' })
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
      {!sidebarHidden && <Sidebar ref={searchRef} />}
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
          onOpenWorkspaces={() => {
            setOverlay({ kind: 'workspaces' })
          }}
        />
        <div className="relative min-h-0 flex-1">
          <Workspace />
          {multiExec && <MultiExecView />}
        </div>
        <TerminalMenu />
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
      {overlay?.kind === 'workspaces' && <WorkspacesDialog onClose={closeOverlay} />}
      {overlay?.kind === 'settings' && (
        <SettingsDialog
          onClose={closeOverlay}
          {...(overlay.section ? { initial: overlay.section } : {})}
        />
      )}
    </div>
  )
}
