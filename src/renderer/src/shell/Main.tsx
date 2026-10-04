import { memo, useEffect, useMemo } from 'react'
import {
  ChevronDown,
  Maximize2,
  Minimize2,
  Columns2,
  Folder,
  Plus,
  Puzzle,
  Radio,
  RefreshCw,
  RotateCcw,
  Rows2,
  ScrollText,
  Server,
  SquareTerminal,
  X,
  Zap
} from 'lucide-react'
import { t } from '@shared/i18n'
import { Breadcrumb, Button, EmptyState, EnvLabel, IconButton, ProdLine, type Crumb } from '../ds'
import { cx, ICON, ICON_SM } from '../ds/utils'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { panelContent, Workspace } from '../components/Workspace'
import { HomeView } from '../components/Home'
import { TabIcon } from '../components/ModuleTabView'
import { useContextMenu, type MenuEntry } from '../components/ContextMenu'
import { SettingsPage } from '../lazy'
import { ModuleIcon, rendererModule } from '../../../modules/registry/renderer-kit'
import { useHosts } from '../stores/hosts'
import { useShells } from '../stores/shells'
import { useTabs, type Tab } from '../stores/tabs'
import { focusQuickConnect } from '../stores/ui-requests'
import { toggleMultiExec, useBroadcast } from '../terminal/broadcast'
import { MultiExecView } from '../terminal/MultiExecView'
import { TerminalMenu } from '../terminal/TerminalMenu'
import { useSettings } from '../stores/settings'
import { useEnvironment, useHostEnvironment } from '../stores/environments'
import type { EnvironmentDef } from '@shared/environments'
import { kbdKeys } from './keys'
import { keybindingFor } from '@shared/commands'
import { displayKeybinding, isMac } from '../lib/keybindings'
import { TransfersPage } from './TransfersPage'
import { LocalFilesPage } from './LocalFilesPage'
import { inDockview, sharesDockview, tabArea, useShell, type Area } from './store'

/** Lớp trong vùng chính: lớp không hiện vẫn sống (terminal giữ phiên) nhưng ẩn và không nhận focus. */
function Layer({
  shown,
  children,
  testId
}: {
  shown: boolean
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'absolute inset-0 flex min-h-0 min-w-0 flex-col',
        !shown && 'pointer-events-none invisible'
      )}
      inert={!shown}
      aria-hidden={shown ? undefined : true}
      data-testid={testId}
      data-shown={shown}
    >
      {children}
    </div>
  )
}

/** Tab phiên đang chọn (Hosts / Files). */
function useActiveSessionTab(): Tab | undefined {
  const activeId = useTabs((s) => s.activeId)
  const lastHosts = useShell((s) => s.lastTab.hosts ?? s.lastTab.files)
  return useTabs((s) => {
    const active = s.tabs.find((x) => x.id === activeId)
    if (active && inDockview(active.target)) return active
    return s.tabs.find((x) => x.id === lastHosts)
  })
}

/** Header của khu vực Hosts: đường dẫn nhóm › host + nhãn môi trường; thao tác bố cục bên phải. */
function HostsHeader({ onSnippets }: { onSnippets: () => void }): React.JSX.Element {
  const tab = useActiveSessionTab()
  const area = useShell((s) => s.area)
  const hostId =
    tab && (tab.target.kind === 'host' || tab.target.kind === 'rdp') ? tab.target.hostId : null
  const host = useHosts((s) => (hostId ? s.tree.hosts.find((h) => h.id === hostId) : undefined))
  const env = useHostEnvironment(hostId)
  const groupTree = useHosts((s) => s.groupTree)
  const path = host?.groupId ? groupTree.path(host.groupId) : []
  const broadcasting = useBroadcast((s) => s.enabled)
  const tabCount = useTabs((s) => s.tabs.filter((x) => inDockview(x.target)).length)
  const overrides = useSettings((s) => s.settings.keybindings)
  const { menu, open: openMenu } = useContextMenu()
  const items: Crumb[] = [
    {
      id: 'area',
      label: area === 'files' ? t('Files') : t('Hosts'),
      icon: area === 'files' ? <Folder {...ICON_SM} /> : <Server {...ICON_SM} />,
      onSelect: () => {
        useShell.getState().toggleExplorer(false)
      }
    },
    ...path.map((name, i) => ({ id: `g${String(i)}`, label: name })),
    ...(tab ? [{ id: 'tab', label: tab.title }] : [])
  ]
  const splitKeys = displayKeybinding(keybindingFor('pane.splitRight', overrides, isMac))
  const downKeys = displayKeybinding(keybindingFor('pane.splitDown', overrides, isMac))
  const multiKeys = kbdKeys('multiexec.toggle', overrides)
  const focusKeys = kbdKeys('view.focus', overrides)
  return (
    <div
      className="flex h-ds-header shrink-0 items-center gap-2 border-b border-ds-border-subtle pr-2 pl-3"
      data-testid="hosts-header"
      data-env={env?.id}
    >
      <Breadcrumb items={items} {...(env ? { env } : {})} className="min-w-0 flex-1" />
      {menu}
      <IconButton
        label={t('Snippets')}
        data-testid="open-snippets"
        {...(kbdKeys('snippets.open', overrides)
          ? { shortcut: kbdKeys('snippets.open', overrides) ?? '' }
          : {})}
        onClick={onSnippets}
      >
        <ScrollText {...ICON} />
      </IconButton>
      <IconButton
        label={t('Layout')}
        data-testid="layout-menu"
        disabled={!tab}
        aria-haspopup="menu"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          openMenu(
            { clientX: rect.left, clientY: rect.bottom + 4, preventDefault: () => undefined },
            [
              {
                id: 'split-right',
                label: t('Split right'),
                icon: <Columns2 size={14} />,
                ...(splitKeys ? { hint: splitKeys } : {}),
                onSelect: () => {
                  useTabs.getState().split('right')
                }
              },
              {
                id: 'split-below',
                label: t('Split down'),
                icon: <Rows2 size={14} />,
                ...(downKeys ? { hint: downKeys } : {}),
                onSelect: () => {
                  useTabs.getState().split('below')
                }
              }
            ]
          )
        }}
      >
        <Columns2 {...ICON} />
      </IconButton>
      <IconButton
        label={
          broadcasting
            ? t('Exit MultiExec')
            : t('MultiExec: show all terminals and type into them at once')
        }
        data-testid="toggle-broadcast"
        aria-pressed={broadcasting}
        disabled={tabCount < 2 && !broadcasting}
        className={cx(broadcasting && 'text-ds-warning')}
        {...(multiKeys ? { shortcut: multiKeys } : {})}
        onClick={toggleMultiExec}
      >
        <Radio {...ICON} />
      </IconButton>
      <IconButton
        label={t('Focus mode: only the terminal')}
        data-testid="focus-mode"
        disabled={!tab}
        {...(focusKeys ? { shortcut: focusKeys } : {})}
        onClick={() => {
          useShell.getState().setFocus(true)
        }}
      >
        <Maximize2 {...ICON} />
      </IconButton>
      <div className="mx-1 h-4 w-px bg-ds-border" />
      <span className="flex items-center">
        <Button
          variant="ghost"
          icon={<Plus {...ICON_SM} />}
          aria-label={t('New terminal')}
          title={`${t('New terminal')} (${displayKeybinding(keybindingFor('tab.new', overrides, isMac))})`}
          data-testid="new-tab"
          className="rounded-r-none pr-2"
          onClick={() => useTabs.getState().addLocal()}
        >
          {t('Terminal')}
        </Button>
        <IconButton
          label={t('Choose a shell')}
          data-testid="new-tab-menu"
          className="rounded-l-none"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const { shells, defaultId } = useShells.getState()
            const closed = useTabs.getState().closed
            openMenu(
              {
                clientX: rect.right - 220,
                clientY: rect.bottom + 4,
                preventDefault: () => undefined
              },
              [
                ...shells.map((s): MenuEntry => ({
                  id: `shell-${s.id}`,
                  label: s.name,
                  icon: <SquareTerminal size={14} />,
                  ...(s.id === defaultId ? { hint: t('Default') } : {}),
                  onSelect: () => {
                    useTabs.getState().addLocal(s.id)
                  }
                })),
                ...(closed.length
                  ? [
                      'separator' as const,
                      {
                        id: 'recent-header',
                        label: t('Recently closed'),
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
                  : []),
                'separator',
                {
                  id: 'shell-refresh',
                  label: t('Refresh shell list'),
                  icon: <RefreshCw size={14} />,
                  onSelect: () => void useShells.getState().load(true)
                }
              ]
            )
          }}
        >
          <ChevronDown {...ICON_SM} />
        </IconButton>
      </span>
    </div>
  )
}

/** Không còn phiên nào (watermark của dockview). */
function HostsEmpty(): React.JSX.Element {
  return (
    <div
      className="flex h-full items-center justify-center bg-ds-surface-0"
      data-testid="hosts-empty"
    >
      <EmptyState
        icon={<SquareTerminal {...ICON} />}
        title={t('No open sessions')}
        description={t('Pick a host in the sidebar, or open a terminal on this computer.')}
        actions={
          <>
            <Button
              variant="primary"
              icon={<Plus {...ICON_SM} />}
              onClick={() => useTabs.getState().addLocal()}
            >
              {t('New terminal')}
            </Button>
            <Button icon={<Zap {...ICON_SM} />} onClick={focusQuickConnect}>
              {t('Quick connect')}
            </Button>
          </>
        }
      />
    </div>
  )
}

/** Khu vực module chưa mở gì: chọn trong Explorer. */
function ModuleEmpty({ id }: { id: string }): React.JSX.Element {
  const mod = rendererModule(id)
  return (
    <div
      className="flex h-full items-center justify-center bg-ds-surface-0"
      data-testid="module-empty"
    >
      <EmptyState
        icon={mod ? <ModuleIcon name={mod.manifest.icon} size={ICON.size} /> : <Puzzle {...ICON} />}
        title={mod?.manifest.name ?? id}
        description={t('Choose an item in the sidebar to open it here.')}
      />
    </div>
  )
}

/** Dải tab khi một khu vực module có nhiều tab (vd. hai cluster, log của pod). */
function StageTabs({ area, tabs }: { area: Area; tabs: Tab[] }): React.JSX.Element | null {
  const activeId = useTabs((s) => s.activeId)
  if (tabs.length < 2) return null
  return (
    <div
      role="tablist"
      aria-label={t('Tabs')}
      className="flex h-ds-tab shrink-0 items-center gap-1 overflow-x-auto border-b border-ds-border-subtle px-2 [scrollbar-width:none]"
      data-testid={`stage-tabs-${area}`}
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeId
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={selected}
            data-testid="tab"
            data-tab-id={tab.id}
            className={cx(
              'group flex h-7 max-w-56 min-w-0 shrink-0 items-center gap-1.5 rounded-ds-md pr-1 pl-2.5 text-ds-sm',
              selected
                ? 'bg-ds-active text-ds-fg'
                : 'text-ds-fg-2 hover:bg-ds-hover hover:text-ds-fg'
            )}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                useTabs.getState().close(tab.id)
              }
            }}
          >
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 outline-none focus-visible:shadow-ds-focus"
              onClick={() => {
                useTabs.getState().activate(tab.id)
              }}
            >
              <TabIcon target={tab.target} size={13} className="shrink-0 text-ds-fg-3" />
              <span className="truncate">{tab.title}</span>
            </button>
            <button
              type="button"
              aria-label={t('Close tab')}
              data-testid="tab-close"
              className={cx(
                'flex size-5 shrink-0 items-center justify-center rounded-ds-sm text-ds-fg-3 hover:bg-ds-hover hover:text-ds-fg focus-visible:opacity-100',
                selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
              onClick={() => {
                useTabs.getState().close(tab.id)
              }}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** Một tab "trang" (Home / module) — luôn giữ khi đã mở, chỉ ẩn. */
const StageTab = memo(function StageTab({
  tab,
  shown
}: {
  tab: Tab
  shown: boolean
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'absolute inset-0 flex min-h-0 flex-col',
        !shown && 'pointer-events-none invisible'
      )}
      inert={!shown}
      aria-hidden={shown ? undefined : true}
      data-stage-tab={tab.id}
    >
      <ErrorBoundary label="tab">{panelContent(tab.id, tab.target, shown, shown)}</ErrorBoundary>
    </div>
  )
})

/**
 * Focus mode: pill nổi góc phải — môi trường, phiên đang xem, thoát (nút hoặc Ctrl+Shift+Enter;
 * Esc không thoát vì thuộc về vim / less).
 */
function FocusPill(): React.JSX.Element {
  const tab = useActiveSessionTab()
  const hostId =
    tab && (tab.target.kind === 'host' || tab.target.kind === 'rdp') ? tab.target.hostId : null
  const env = useHostEnvironment(hostId)
  const overrides = useSettings((s) => s.settings.keybindings)
  const keys = kbdKeys('view.focus', overrides)
  return (
    <div
      className="absolute top-2 right-3 z-(--ds-z-dropdown) flex items-center gap-2 rounded-full bg-ds-popover py-1 pr-1 pl-3 text-ds-sm shadow-ds-popover"
      data-testid="focus-pill"
    >
      {env && <EnvLabel env={env} />}
      <span className="max-w-64 truncate text-ds-fg">{tab?.title ?? ''}</span>
      <Button
        size="sm"
        variant="ghost"
        icon={<Minimize2 {...ICON_SM} />}
        className="rounded-full"
        data-testid="focus-exit"
        {...(keys ? { title: keys } : {})}
        onClick={() => {
          useShell.getState().setFocus(false)
        }}
      >
        {t('Exit')}
      </Button>
    </div>
  )
}

/**
 * Esc trên trang Cài đặt (không có hộp thoại / menu nào đang mở, không ở ô đang tự bắt phím) → quay
 * lại màn trước — như đóng hộp thoại Cài đặt trước đây.
 */
function SettingsEscape(): null {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (
        target?.closest(
          '[data-capture-keys="true"], [role="dialog"], [role="alertdialog"], [role="menu"]'
        )
      )
        return
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [data-testid="context-menu"]'
        )
      )
        return
      e.preventDefault()
      useShell.getState().back()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  return null
}

/** Môi trường của khu vực đang xem (vạch ở đỉnh vùng chính theo quy tắc Top line). */
function useMainEnv(area: Area, stageTab: string | null): EnvironmentDef | undefined {
  const tab = useActiveSessionTab()
  const hostId =
    sharesDockview(area) && tab && (tab.target.kind === 'host' || tab.target.kind === 'rdp')
      ? tab.target.hostId
      : null
  const hostEnv = useHostEnvironment(hostId)
  const reported = useShell((s) => (stageTab ? (s.envByTab[stageTab] ?? null) : null))
  const moduleEnv = useEnvironment(reported)
  return sharesDockview(area) ? hostEnv : area.startsWith('m:') ? moduleEnv : undefined
}

/**
 * Vùng chính (inset, bo 8px, viền mảnh): lớp phiên (dockview — Hosts / Files), các tab "trang"
 * (Home, module), và trang của khu vực (Settings, Transfers, module chưa mở gì).
 */
export const Main = memo(function Main({
  onSnippets
}: {
  onSnippets: () => void
}): React.JSX.Element {
  const area = useShell((s) => s.area)
  const settingsSection = useShell((s) => s.settingsSection)
  const activeId = useTabs((s) => s.activeId)
  const tabs = useTabs((s) => s.tabs)
  const stage = useMemo(() => tabs.filter((x) => !inDockview(x.target)), [tabs])
  const areaTabs = stage.filter((x) => tabArea(x) === area)
  const active = tabs.find((x) => x.id === activeId)
  const stageShown =
    active && !inDockview(active.target) && tabArea(active) === area ? active.id : null
  const filesLocal = useShell((s) => s.filesLocal)
  const sessions = sharesDockview(area) && !(area === 'files' && filesLocal)
  const env = useMainEnv(area, stageShown)
  const multiExec = useBroadcast((s) => s.enabled)
  const focus = useShell((s) => s.focus)
  return (
    <main
      id="main"
      className="relative mr-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-ds-lg bg-ds-surface-0 shadow-[0_0_0_1px_var(--ds-border-subtle)]"
      data-area={area}
      data-env={env?.id}
      data-focus={focus}
      data-testid="main"
    >
      {env?.topLine && (
        <ProdLine
          highlight={env.highlight}
          className="absolute inset-x-0 top-0 z-(--ds-z-sticky)"
        />
      )}
      <div className="relative min-h-0 flex-1">
        <Layer shown={sessions} testId="sessions-layer">
          {!focus && <HostsHeader onSnippets={onSnippets} />}
          {focus && <FocusPill />}
          <div className="relative min-h-0 flex-1 overflow-clip">
            <Workspace Watermark={HostsEmpty} />
            {multiExec && <MultiExecView />}
          </div>
          <TerminalMenu />
        </Layer>
        <Layer
          shown={!sessions && area !== 'settings' && area !== 'transfers'}
          testId="stage-layer"
        >
          {area.startsWith('m:') && <StageTabs area={area} tabs={areaTabs} />}
          <div className="relative min-h-0 flex-1">
            {stage.map((tab) => (
              <StageTab key={tab.id} tab={tab} shown={tab.id === stageShown} />
            ))}
            {area.startsWith('m:') && !stageShown && <ModuleEmpty id={area.slice(2)} />}
            {/* Khu vực Home luôn có trang chủ (kể cả khi tab Home vừa bị đóng bằng phím). */}
            {area === 'home' && !stageShown && <HomeView />}
          </div>
        </Layer>
        {area === 'settings' && <SettingsEscape />}
        {area === 'settings' && (
          <Layer shown testId="settings-layer">
            <SettingsPage
              section={settingsSection}
              onSection={(s) => {
                useShell.getState().openSettings(s)
              }}
            />
          </Layer>
        )}
        {area === 'files' && filesLocal && (
          <Layer shown testId="local-files-layer">
            <LocalFilesPage />
          </Layer>
        )}
        {area === 'transfers' && (
          <Layer shown testId="transfers-layer">
            <TransfersPage />
          </Layer>
        )}
      </div>
    </main>
  )
})
