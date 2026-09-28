import { useEffect, useRef, useState } from 'react'
import {
  DockviewReact,
  type DockviewApi,
  type DockviewTheme,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { TerminalSquare, X } from 'lucide-react'
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
  return (
    <div
      role="tab"
      aria-selected={active}
      data-testid="tab"
      data-tab-id={props.params.tabId}
      className="group flex h-full max-w-56 min-w-24 items-center gap-2 px-3 text-xs"
      onMouseDown={(e) => {
        // Chuột giữa = đóng tab, như trình duyệt.
        if (e.button === 1) {
          e.preventDefault()
          props.api.close()
        }
      }}
    >
      <span className="truncate">{title}</span>
      <button
        type="button"
        aria-label="Close tab"
        data-testid="tab-close"
        className={`ml-auto flex size-5 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
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
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-canvas text-center">
      <TerminalSquare size={28} className="text-faint" />
      <p className="text-sm text-muted">No open tabs</p>
      <p className="text-xs text-faint">
        Open a terminal, double-click a host, or use quick connect.
      </p>
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
