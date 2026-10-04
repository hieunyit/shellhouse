import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TEST_HOOKS_GLOBAL } from '@shared/test-hooks'
import { CommandPalette } from './components/CommandPalette'
import { Toaster } from './components/Toaster'
import { RdpConnections } from './components/RdpConnections'
import { ConfirmHost } from './components/ConfirmHost'
import { ErrorBoundary } from './components/ErrorBoundary'
import { toast } from './stores/toasts'
import { useTerminalFind } from './stores/terminal-find'
import { WorkspacesDialog } from './components/WorkspacesDialog'
import { DesignKit, preloadLazyParts, SnippetsDialog } from './lazy'
import { matchCommand } from './lib/keybindings'
import { useHosts } from './stores/hosts'
import { useSettings } from './stores/settings'
import { useShells } from './stores/shells'
import { useTabs } from './stores/tabs'
import { openSidebarDialog } from './stores/ui-requests'
import { parseMacro } from '@shared/macro'
import { toggleMultiExec, useBroadcast } from './terminal/broadcast'
import { controllers } from './terminal/registry'
import { EnableModuleDialog } from './components/EnableModuleDialog'
import { CommandSheet } from './components/CommandSheet'
import { useModuleUi } from './stores/module-ui'
import { t } from '@shared/i18n'
import { DsProvider } from './ds'
import { cx } from './ds/utils'
import { ActivityBar } from './shell/ActivityBar'
import { Explorer } from './shell/Explorer'
import { Main } from './shell/Main'
import { QuickConnectDialog } from './shell/QuickConnect'
import { StatusBar } from './shell/StatusBar'
import { TitleBar } from './shell/TitleBar'
import { useShell } from './shell/store'

type Overlay =
  | { kind: 'snippets' }
  | { kind: 'palette' }
  | { kind: 'workspaces' }
  | { kind: 'designKit' }
  | { kind: 'quickConnect' }
  | null

/** Lệnh nhường phím cho editor khi con trỏ đang ở trong editor. */
const EDITOR_KEYS: ReadonlySet<string> = new Set(['snippets.open', 'terminal.find'])

export function App(): React.JSX.Element {
  const [overlay, setOverlay] = useState<Overlay>(null)
  const activeId = useTabs((s) => s.activeId)
  const multiExec = useBroadcast((s) => s.enabled)
  const focus = useShell((s) => s.focus)
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
        if (s.browse && s.browse !== prev.browse) useShell.getState().openSettings('modules')
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
      case 'sidebar.toggle':
        useShell.getState().toggleExplorer()
        break
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
      case 'hosts.export':
        void openSidebarDialog('export-hosts')
        break
      case 'quickconnect.focus':
        setOverlay({ kind: 'quickConnect' })
        break
      case 'hosts.search':
        // Sang khu vực Hosts, hiện Explorer (nếu đang ẩn) rồi focus ô tìm host.
        void (async () => {
          const { settings, update } = useSettings.getState()
          if (settings.appearance.sidebarHidden)
            await update({ appearance: { sidebarHidden: false } })
          useShell.getState().go('hosts')
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
        useShell.getState().openSettings()
        break
      case 'keychain.open':
        useShell.getState().openSettings('keychain')
        break
      case 'multiexec.toggle':
        toggleMultiExec()
        break
      case 'workspaces.open':
        setOverlay({ kind: 'workspaces' })
        break
      case 'modules.browse':
        useShell.getState().openSettings('modules')
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
      case 'designkit.open':
        setOverlay({ kind: 'designKit' })
        break
      case 'view.focus': {
        const shell = useShell.getState()
        shell.setFocus(!shell.focus)
        break
      }
      case 'diagnostics.toggle': {
        const shell = useShell.getState()
        if (shell.area === 'settings' && shell.settingsSection === 'diagnostics') shell.back()
        else shell.openSettings('diagnostics')
        break
      }
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

  // Ổn định qua các lần vẽ: App vẽ lại mỗi lần đổi tab; TitleBar / Main (memo) thì không cần.
  const shellActions = useMemo(
    () => ({
      onPalette: () => {
        setOverlay({ kind: 'palette' })
      },
      onQuickConnect: () => {
        setOverlay({ kind: 'quickConnect' })
      },
      onWorkspaces: () => {
        setOverlay({ kind: 'workspaces' })
      },
      onSnippets: () => {
        setOverlay({ kind: 'snippets' })
      }
    }),
    []
  )

  const closeOverlay = (): void => {
    setOverlay(null)
    if (activeId) controllers.get(activeId)?.activate()
  }

  return (
    <DsProvider>
      <div className="flex h-full flex-col bg-ds-bg text-ds-base text-ds-fg">
        <Toaster />
        <RdpConnections />
        <ErrorBoundary label="title bar" compact>
          <TitleBar
            onPalette={shellActions.onPalette}
            onQuickConnect={shellActions.onQuickConnect}
            onWorkspaces={shellActions.onWorkspaces}
          />
        </ErrorBoundary>
        <div className={cx('flex min-h-0 flex-1', focus && 'pb-2 pl-2')}>
          {!focus && <ActivityBar />}
          {/* Mỗi vùng có ErrorBoundary riêng: Explorer lỗi không gỡ vùng terminal (mất phiên). */}
          {!focus && (
            <ErrorBoundary label="sidebar" compact>
              <Explorer searchRef={searchRef} />
            </ErrorBoundary>
          )}
          <Main onSnippets={shellActions.onSnippets} />
        </div>
        {!focus && <StatusBar />}
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
        {overlay?.kind === 'designKit' && <DesignKit onClose={closeOverlay} />}
        {overlay?.kind === 'quickConnect' && <QuickConnectDialog onClose={closeOverlay} />}
        <EnableModuleDialog />
        <CommandSheet />
        {/* Sau cùng: hộp thoại xác nhận nằm trên mọi hộp thoại khác. */}
        <ConfirmHost />
      </div>
    </DsProvider>
  )
}
