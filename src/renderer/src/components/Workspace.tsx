import { useEffect, useRef, useState } from 'react'
import {
  DockviewReact,
  type DockviewApi,
  type DockviewTheme,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { Columns2, Copy, RotateCcw, RotateCw, Rows2, X } from 'lucide-react'
import { useContextMenu } from './ContextMenu'
import { controllers } from '../terminal/registry'
import { useTabStatus } from '../stores/tab-status'
import { useHosts } from '../stores/hosts'
import { hostColorClass } from './hostColors'
import { keybindingFor } from '@shared/commands'
import { displayKeybinding, isMac } from '../lib/keybindings'
import { useSettings } from '../stores/settings'
import { connectionLabel, cx, StatusDot } from './ui'
import { HomeView } from './Home'
import { HostAvatar } from './HostAvatar'
import { useTabs } from '../stores/tabs'
import { TerminalView } from '../terminal/TerminalView'
import { ModuleTabView, TabIcon } from './ModuleTabView'
import { layoutToItems, type WorkspaceItem } from '@shared/workspaces'

interface PanelParams {
  tabId: string
}

/** Một panel của dockview = một tab terminal. */
function TerminalPanel(props: IDockviewPanelProps<PanelParams>): React.JSX.Element | null {
  const { tabId } = props.params
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId))
  const [active, setActive] = useState(props.api.isActive)
  const [visible, setVisible] = useState(props.api.isVisible)

  useEffect(() => {
    const a = props.api.onDidActiveChange((e) => {
      setActive(e.isActive)
    })
    const v = props.api.onDidVisibilityChange((e) => {
      setVisible(e.isVisible)
    })
    return () => {
      a.dispose()
      v.dispose()
    }
  }, [props.api])

  if (!tab) return null
  if (tab.target.kind === 'home') return <HomeView />
  if (tab.target.kind === 'module')
    return <ModuleTabView tabId={tab.id} target={tab.target} active={active} visible={visible} />
  return <TerminalView tabId={tab.id} target={tab.target} active={active} visible={visible} />
}

/** Tab trong thanh tab của dockview (giữ data-testid cũ cho E2E). */
function TabHeader(props: IDockviewPanelHeaderProps<PanelParams>): React.JSX.Element {
  const [title, setTitle] = useState(props.api.title ?? '')
  const [active, setActive] = useState(props.api.isActive)
  useEffect(() => {
    const a = props.api.onDidTitleChange((e) => {
      setTitle(e.title)
    })
    const b = props.api.onDidActiveChange((e) => {
      setActive(e.isActive)
    })
    return () => {
      a.dispose()
      b.dispose()
    }
  }, [props.api])
  const tabId = props.params.tabId
  const target = useTabs((s) => s.tabs.find((t) => t.id === tabId)?.target)
  const kind = target?.kind ?? 'local'
  const state = useTabStatus((s) => s.byTab[tabId] ?? 'idle')
  const hostId = useTabs((s) => {
    const t = s.tabs.find((x) => x.id === tabId)?.target
    return t?.kind === 'host' ? t.hostId : null
  })
  const envColor = useHosts((s) => (hostId ? (s.effective.get(hostId)?.color ?? null) : null))
  const hostLabel = useHosts((s) =>
    hostId ? (s.tree.hosts.find((h) => h.id === hostId)?.label ?? null) : null
  )
  const overrides = useSettings((s) => s.settings.keybindings)
  const { menu, open: openMenu } = useContextMenu()
  const key = (id: string): string => displayKeybinding(keybindingFor(id, overrides, isMac))
  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const tabs = useTabs.getState()
    const others = tabs.tabs.length > 1
    // Tab Home: không có kết nối / không nhân bản / không chia màn hình.
    const skip =
      kind === 'home'
        ? new Set(['tab-reconnect', 'tab-duplicate', 'tab-split-right', 'tab-split-below'])
        : null
    const menuOf = (items: Parameters<typeof openMenu>[1]): Parameters<typeof openMenu>[1] =>
      skip
        ? items.filter((it, i, all) => {
            if (it === 'separator') return i > 0 && all[i - 1] !== 'separator'
            return !skip.has(it.id)
          })
        : items
    openMenu(
      e,
      menuOf([
        {
          id: 'tab-reconnect',
          label: kind === 'local' ? 'Restart shell' : 'Reconnect',
          icon: <RotateCw size={14} />,
          hint: key('tab.reconnect'),
          onSelect: () => {
            tabs.activate(tabId)
            controllers.get(tabId)?.reconnect()
          }
        },
        {
          id: 'tab-duplicate',
          label: 'Duplicate tab',
          icon: <Copy size={14} />,
          onSelect: () => {
            tabs.duplicate(tabId)
          }
        },
        {
          id: 'tab-split-right',
          label: 'Split right',
          icon: <Columns2 size={14} />,
          onSelect: () => {
            tabs.activate(tabId)
            tabs.split('right')
          }
        },
        {
          id: 'tab-split-below',
          label: 'Split down',
          icon: <Rows2 size={14} />,
          onSelect: () => {
            tabs.activate(tabId)
            tabs.split('below')
          }
        },
        'separator',
        ...(tabs.closed.length
          ? [
              {
                id: 'tab-reopen',
                label: `Reopen “${tabs.closed.at(-1)?.title ?? ''}”`,
                icon: <RotateCcw size={14} />,
                hint: key('tab.reopen'),
                onSelect: () => {
                  tabs.reopenClosed()
                }
              }
            ]
          : []),
        {
          id: 'tab-close',
          label: 'Close tab',
          icon: <X size={14} />,
          hint: key('tab.close'),
          onSelect: () => {
            tabs.close(tabId)
          }
        },
        {
          id: 'tab-close-others',
          label: 'Close other tabs',
          disabled: !others,
          onSelect: () => {
            tabs.closeOthers(tabId)
          }
        }
      ])
    )
  }
  return (
    <>
      {menu}
      <div
        role="tab"
        aria-selected={active}
        data-testid="tab"
        data-tab-id={tabId}
        data-tab-state={state}
        title={`${title} — ${connectionLabel[state]}`}
        data-env-color={envColor ?? ''}
        className="group relative flex h-full max-w-60 min-w-28 items-center gap-2 pr-1.5 pl-3 text-xs"
        onContextMenu={onContextMenu}
        onMouseDown={(e) => {
          // Chuột giữa = đóng tab, như trình duyệt.
          if (e.button === 1) {
            e.preventDefault()
            props.api.close()
          }
        }}
      >
        {envColor && (
          <span
            aria-hidden
            className={cx('absolute inset-x-0 top-0 h-[3px]', hostColorClass[envColor])}
          />
        )}
        <span className="relative flex shrink-0">
          {hostLabel ? (
            <HostAvatar
              host={{ label: hostLabel, color: envColor }}
              size={16}
              className="rounded"
            />
          ) : (
            <TabIcon target={target} size={13} className={active ? 'text-fg' : 'text-faint'} />
          )}
          {/* Terminal local luôn "connected" — chỉ hiện chấm khi là phiên từ xa hoặc đã kết thúc. */}
          {((kind !== 'local' && kind !== 'home') || state === 'exited') && (
            <StatusDot
              state={state}
              className={cx(
                'absolute -right-0.5 -bottom-0.5 ring-2',
                active ? 'ring-terminal' : 'ring-surface'
              )}
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <button
          type="button"
          aria-label="Close tab"
          data-testid="tab-close"
          className={cx(
            'flex size-5 shrink-0 items-center justify-center rounded text-faint transition-opacity duration-100 hover:bg-hover hover:text-fg',
            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          onMouseDown={(e) => {
            e.stopPropagation()
          }}
          onClick={() => {
            props.api.close()
          }}
        >
          <X size={12} />
        </button>
      </div>
    </>
  )
}

const components = { terminal: TerminalPanel }

/** Dockview đang hiển thị — để chụp bố cục khi lưu workspace. */
let currentApi: DockviewApi | null = null

/** Bố cục tab hiện tại thành danh sách mở lại được (xem @shared/workspaces). */
export function captureWorkspaceItems(): WorkspaceItem[] {
  const api = currentApi
  if (!api || api.panels.length === 0) return []
  const { grid } = api.toJSON()
  const { tabs } = useTabs.getState()
  return layoutToItems(grid.root, grid.orientation, (panelId) => {
    const tab = tabs.find((t) => t.id === panelId)
    // Tab Home không thuộc bố cục làm việc — không lưu vào workspace.
    return tab && tab.target.kind !== 'home'
      ? { target: tab.target, title: tab.title, view: tab.view }
      : null
  })
}

/** Màu lấy hoàn toàn từ design token (styles.css) → tự đổi theo sáng/tối. */
const shellhouseTheme: DockviewTheme = {
  name: 'shellhouse',
  className: 'dockview-theme-shellhouse'
}
const tabComponents = { tab: TabHeader }

/**
 * Bố cục tab + chia màn hình bằng dockview. Store `useTabs` là nguồn sự thật về tab nào đang mở;
 * dockview chỉ giữ vị trí. Hai chiều đồng bộ qua sự kiện.
 */
export function Workspace(): React.JSX.Element {
  const apiRef = useRef<DockviewApi | null>(null)
  const [api, setApi] = useState<DockviewApi | null>(null)

  // Store → dockview.
  useEffect(() => {
    if (!api) return
    const sync = (): void => {
      const { tabs, activeId } = useTabs.getState()
      for (const tab of tabs) {
        const existing = api.getPanel(tab.id)
        if (existing) {
          if (existing.title !== tab.title) existing.api.setTitle(tab.title)
          continue
        }
        const reference = tab.splitFrom ? api.getPanel(tab.splitFrom.tabId) : undefined
        api.addPanel<PanelParams>({
          id: tab.id,
          component: 'terminal',
          tabComponent: 'tab',
          title: tab.title,
          params: { tabId: tab.id },
          // Terminal ẩn vẫn phải sống (giữ phiên, scrollback).
          renderer: 'always',
          ...(reference && tab.splitFrom
            ? { position: { referencePanel: reference, direction: tab.splitFrom.direction } }
            : {})
        })
      }
      for (const panel of [...api.panels]) {
        if (!tabs.some((t) => t.id === panel.id)) api.removePanel(panel)
      }
      if (activeId && api.activePanel?.id !== activeId) api.getPanel(activeId)?.api.setActive()
    }
    sync()
    const unsubscribe = useTabs.subscribe(sync)

    // Dockview → store (đóng tab bằng nút ×, chọn tab bằng chuột).
    const removed = api.onDidRemovePanel((panel) => {
      if (useTabs.getState().tabs.some((t) => t.id === panel.id)) useTabs.getState().close(panel.id)
    })
    const activated = api.onDidActivePanelChange((event) => {
      const id = event.panel?.id
      if (id && useTabs.getState().activeId !== id) useTabs.getState().activate(id)
    })
    return () => {
      unsubscribe()
      removed.dispose()
      activated.dispose()
    }
  }, [api])

  return (
    <DockviewReact
      className="h-full"
      theme={shellhouseTheme}
      components={components}
      tabComponents={tabComponents}
      watermarkComponent={HomeView}
      defaultRenderer="always"
      onReady={(event) => {
        apiRef.current = event.api
        currentApi = event.api
        setApi(event.api)
      }}
    />
  )
}
