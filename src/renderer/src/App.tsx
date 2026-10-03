import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TEST_HOOKS_GLOBAL } from '@shared/test-hooks'
import { CommandPalette } from './components/CommandPalette'
import type { SettingsSectionId } from './components/settings/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { Toaster } from './components/Toaster'
import { RdpConnections } from './components/RdpConnections'
import { ConfirmHost } from './components/ConfirmHost'
import { ErrorBoundary } from './components/ErrorBoundary'
import { toast } from './stores/toasts'
import { useTerminalFind } from './stores/terminal-find'
import { Workspace } from './components/Workspace'
import { WorkspacesDialog } from './components/WorkspacesDialog'
import { preloadLazyParts, SettingsDialog, SnippetsDialog } from './lazy'
import { matchCommand } from './lib/keybindings'
import { useHosts } from './stores/hosts'
import { useSettings } from './stores/settings'
import { useShells } from './stores/shells'
import { useTabs } from './stores/tabs'
import { focusQuickConnect, openSidebarDialog } from './stores/ui-requests'
import { parseMacro } from '@shared/macro'
import { toggleMultiExec, useBroadcast } from './terminal/broadcast'
import { MultiExecView } from './terminal/MultiExecView'
import { TerminalMenu } from './terminal/TerminalMenu'
import { controllers } from './terminal/registry'
import { EnableModuleDialog } from './components/EnableModuleDialog'
import { useModuleUi } from './stores/module-ui'
import { modeForTab, useSidebarLayout } from './stores/sidebar-layout'
import { t } from '@shared/i18n'

type Overlay =
  | { kind: 'snippets' }
  | { kind: 'palette' }
  | { kind: 'workspaces' }
  | {
      kind: 'settings'
      section?: SettingsSectionId
    }
  | null

/** Lệnh nhường phím cho editor khi con trỏ đang ở trong editor. */
const EDITOR_KEYS: ReadonlySet<string> = new Set(['snippets.open', 'terminal.find'])

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

  // Nơi khác (thanh bên, màn chào, gợi ý) yêu cầu mở trang Modules.
  useEffect(
    () =>
      useModuleUi.subscribe((s, prev) => {
        if (s.browse && s.browse !== prev.browse)
          setOverlay({ kind: 'settings', section: 'modules' })
      }),
    []
  )

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
        if (useTabs.getState().tabs.length > 0) return
        // Chưa chọn: Home (E2E giữ terminal như trước để các kịch bản cũ không đổi).
        const startup =
          useSettings.getState().settings.appearance.startup ??
          (TEST_HOOKS_GLOBAL in window ? 'terminal' : 'home')
        if (startup === 'home') useTabs.getState().openHome()
        else useTabs.getState().addLocal()
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
      case 'tab.reopen':
        if (!tabs.reopenClosed()) toast.info(t('No recently closed tabs'), { group: 'reopen' })
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
      case 'hosts.new':
        void openSidebarDialog('new-host')
        break
      case 'hosts.import':
        void openSidebarDialog('import-hosts')
        break
      case 'quickconnect.focus':
        focusQuickConnect()
        break
      case 'hosts.search':
        // Thanh bên đang ẩn → hiện ra rồi mới focus ô tìm.
        void (async () => {
          const { settings, update } = useSettings.getState()
          if (settings.appearance.sidebarHidden)
            await update({ appearance: { sidebarHidden: false } })
          // Thanh bên đang ở dạng gọn (tab module) → mở tạm rồi focus ô tìm.
          const tabsNow = useTabs.getState()
          const kind = tabsNow.tabs.find((x) => x.id === tabsNow.activeId)?.target.kind
          const layout = useSidebarLayout.getState()
          if (layout.compact[modeForTab(kind)]) {
            layout.requestPeek(true)
            return
          }
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
      case 'modules.browse':
        setOverlay({ kind: 'settings', section: 'modules' })
        break
      case 'terminal.find':
        if (tabs.activeId && controllers.has(tabs.activeId))
          useTerminalFind.getState().open(tabs.activeId)
        break
      case 'terminal.zoomIn':
      case 'terminal.zoomOut':
      case 'terminal.zoomReset': {
        const { settings, update } = useSettings.getState()
        const size =
          id === 'terminal.zoomReset'
            ? 14
            : Math.max(
                8,
                Math.min(32, settings.terminal.fontSize + (id === 'terminal.zoomIn' ? 1 : -1))
              )
        void update({ terminal: { fontSize: size } })
        toast.info(t('Terminal text size {size}', { size }), { group: 'font-size', duration: 1500 })
        break
      }
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
      // Màn hình Remote Desktop đang nhận phím (chế độ gửi mọi phím sang máy từ xa).
      if ((event.target as HTMLElement | null)?.closest('[data-rdp-keyboard="capture"] canvas'))
        return
      // Trong editor (CodeMirror): ⌘S / Ctrl+S là lưu, ⌘F là tìm trong file — không mở Snippets /
      // tìm trong terminal (trên Mac phím Snippets là ⌘S).
      if (EDITOR_KEYS.has(command) && (event.target as HTMLElement | null)?.closest('.cm-editor'))
        return
      event.preventDefault()
      runCommand(command)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [runCommand])

  // Ổn định qua các lần vẽ: App vẽ lại mỗi lần đổi tab; TabBar / Sidebar / Workspace (memo) thì
  // không cần vẽ lại theo.
  const sidebarActions = useMemo(
    () => ({
      onOpenSettings: () => {
        setOverlay({ kind: 'settings' })
      }
    }),
    []
  )
  const tabBarActions = useMemo(
    () => ({
      onOpenSnippets: () => {
        setOverlay({ kind: 'snippets' })
      },
      onOpenSettings: () => {
        setOverlay({ kind: 'settings' })
      },
      onOpenDiagnostics: () => {
        setOverlay({ kind: 'settings', section: 'diagnostics' })
      },
      onOpenWorkspaces: () => {
        setOverlay({ kind: 'workspaces' })
      }
    }),
    []
  )

  const closeOverlay = (): void => {
    setOverlay(null)
    if (activeId) controllers.get(activeId)?.activate()
  }

  return (
    <div className="flex h-full">
      <Toaster />
      <RdpConnections />
      {/* Mỗi vùng có ErrorBoundary riêng: thanh bên lỗi không gỡ vùng terminal (mất phiên). */}
      {!sidebarHidden && (
        <ErrorBoundary label="sidebar" compact>
          <Sidebar ref={searchRef} {...sidebarActions} />
        </ErrorBoundary>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <ErrorBoundary label="tab bar" compact>
          <TabBar {...tabBarActions} />
        </ErrorBoundary>
        {/* overflow-clip: panel ẩn (renderer "always") giữ kích thước cũ khi thu nhỏ cửa sổ —
            không được làm cả trang tràn; "clip" (khác "hidden") còn chặn cuộn do focus() /
            scrollIntoView, nếu không cả vùng tab bị đẩy lên vài chục px. */}
        <div className="relative min-h-0 min-w-0 flex-1 overflow-clip">
          <Workspace />
          {multiExec && <MultiExecView />}
        </div>
        <TerminalMenu />
      </div>
      {overlay?.kind === 'snippets' && (
        <SnippetsDialog
          canInsert={activeId !== null && controllers.has(activeId)}
          onClose={closeOverlay}
          onInsert={(text, run, macro) => {
            if (!activeId) return
            if (!macro) {
              controllers.get(activeId)?.insertText(text, run)
              return
            }
            // Macro: MultiExec đang bật và tab hiện tại nằm trong nhóm → chạy trên mọi tab đã chọn.
            const { enabled, tabIds } = useBroadcast.getState()
            const targets = enabled && tabIds.includes(activeId) ? tabIds : [activeId]
            const steps = parseMacro(text)
            for (const id of targets) {
              void controllers
                .get(id)
                ?.runMacro(steps)
                .catch(() => undefined)
            }
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
      <EnableModuleDialog />
      {/* Sau cùng: hộp thoại xác nhận nằm trên mọi hộp thoại khác. */}
      <ConfirmHost />
    </div>
  )
}
