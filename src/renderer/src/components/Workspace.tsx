import { Fragment, useEffect, useRef, useState } from 'react'
import {
  DockviewReact,
  type DockviewApi,
  type DockviewTheme,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { Server, SquareTerminal, TerminalSquare, X } from 'lucide-react'
import { useTabStatus } from '../stores/tab-status'
import { useHosts } from '../stores/hosts'
import { hostColorClass } from './hostColors'
import { keybindingFor } from '@shared/commands'
import { displayKeybinding, isMac } from '../lib/keybindings'
import { useSettings } from '../stores/settings'
import { Button, connectionLabel, cx, Kbd, StatusDot } from './ui'
import { useTabs } from '../stores/tabs'
import { TerminalView } from '../terminal/TerminalView'

interface PanelParams {
  tabId: string
}

/** Một panel của dockview = một tab terminal. */
function TerminalPanel(props: IDockviewPanelProps<PanelParams>): React.JSX.Element | null {
  const { tabId } = props.params
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId))
  const [active, setActive] = useState(props.api.isActive)

  useEffect(() => {
    const sub = props.api.onDidActiveChange((e) => {
      setActive(e.isActive)
    })
    return () => {
      sub.dispose()
    }
  }, [props.api])

  if (!tab) return null
  return <TerminalView tabId={tab.id} target={tab.target} active={active} />
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
  const kind = useTabs((s) => s.tabs.find((t) => t.id === tabId)?.target.kind ?? 'local')
  const state = useTabStatus((s) => s.byTab[tabId] ?? 'idle')
  const hostId = useTabs((s) => {
    const t = s.tabs.find((x) => x.id === tabId)?.target
    return t?.kind === 'host' ? t.hostId : null
  })
  const envColor = useHosts((s) => (hostId ? (s.effective.get(hostId)?.color ?? null) : null))
  const Icon = kind === 'local' ? SquareTerminal : Server
  return (
    <div
      role="tab"
      aria-selected={active}
      data-testid="tab"
      data-tab-id={tabId}
      data-tab-state={state}
      title={`${title} — ${connectionLabel[state]}`}
      data-env-color={envColor ?? ''}
      className="group relative flex h-full max-w-60 min-w-28 items-center gap-2 pr-1.5 pl-3 text-xs"
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
          className={cx('absolute inset-x-0 top-0 h-0.5', hostColorClass[envColor])}
        />
      )}
      <span className="relative flex shrink-0">
        <Icon size={13} className={active ? 'text-fg' : 'text-faint'} />
        {/* Terminal local luôn "connected" — chỉ hiện chấm khi là phiên từ xa hoặc đã kết thúc. */}
        {(kind !== 'local' || state === 'exited') && (
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
  )
}

function Empty(): React.JSX.Element {
  const overrides = useSettings((s) => s.settings.keybindings)
  const key = (id: string): string => displayKeybinding(keybindingFor(id, overrides, isMac))
  const hints = [
    { id: 'tab.new', label: 'New terminal' },
    { id: 'hosts.search', label: 'Search hosts' },
    { id: 'palette.open', label: 'Command palette' }
  ]
  return (
    <div className="animate-fade-in flex h-full flex-col items-center justify-center gap-5 bg-canvas p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl border border-line bg-surface text-muted shadow-xs">
        <TerminalSquare size={22} />
      </div>
      <div>
        <p className="text-sm font-semibold text-fg">No open sessions</p>
        <p className="mt-1 text-xs text-muted">
          Open a local terminal, double-click a saved host, or use quick connect.
        </p>
      </div>
      <Button
        variant="primary"
        icon={<SquareTerminal size={14} />}
        onClick={() => useTabs.getState().addLocal()}
      >
        New terminal
      </Button>
      <dl className="grid grid-cols-[auto_auto] items-center gap-x-4 gap-y-2 text-xs">
        {hints.map((h) => (
          <Fragment key={h.id}>
            <dt className="text-right text-muted">{h.label}</dt>
            <dd className="text-left">
              <Kbd>{key(h.id)}</Kbd>
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

const components = { terminal: TerminalPanel }

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
      watermarkComponent={Empty}
      defaultRenderer="always"
      onReady={(event) => {
        apiRef.current = event.api
        setApi(event.api)
      }}
    />
  )
}
