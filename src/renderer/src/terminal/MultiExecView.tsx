import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Maximize2, Radio, Server, SquareTerminal, X } from 'lucide-react'
import { hostColorClass } from '../components/hostColors'
import { Button, connectionLabel, cx, StatusDot } from '../components/ui'
import { useHosts } from '../stores/hosts'
import { useTabStatus } from '../stores/tab-status'
import { useTabs } from '../stores/tabs'
import { joinsMultiExec, useBroadcast } from './broadcast'
import { PromptDialog } from './PromptDialog'
import { controllers } from './registry'

/**
 * MultiExec: mọi terminal đang mở xếp đều thành lưới trên một màn hình (như MobaXterm). Terminal
 * không được tạo lại — phần tử xterm của từng tab được chuyển vào ô lưới và trả về khi thoát.
 */
export function MultiExecView(): React.JSX.Element {
  // Chỉ tab có terminal (tab trình quản lý của module không gõ lệnh được).
  const allTabs = useTabs((s) => s.tabs)
  const tabs = useMemo(() => allTabs.filter((t) => joinsMultiExec(t.target)), [allTabs])
  const included = useBroadcast((s) => s.tabIds)
  const n = tabs.length
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  const rows = Math.max(1, Math.ceil(n / cols))

  // Hết tab → thoát chế độ.
  useEffect(() => {
    if (n === 0) useBroadcast.getState().stop()
  }, [n])

  return (
    <div
      className="animate-fade-in absolute inset-0 z-20 flex flex-col bg-canvas"
      data-testid="multiexec"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 text-xs">
        <Radio size={14} className="text-warning" />
        <span className="font-semibold text-fg">MultiExec</span>
        <span className="text-muted" data-testid="multiexec-summary">
          Typing goes to {included.length} of {n} terminal{n === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          data-testid="multiexec-all"
          onClick={() => {
            useBroadcast.getState().setTabs(tabs.map((t) => t.id))
          }}
        >
          Select all
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="multiexec-none"
          onClick={() => {
            useBroadcast.getState().setTabs([])
          }}
        >
          None
        </Button>
        <Button
          size="sm"
          icon={<X size={13} />}
          data-testid="multiexec-exit"
          onClick={() => {
            useBroadcast.getState().stop()
          }}
        >
          Exit MultiExec
        </Button>
      </div>
      <div
        className="grid min-h-0 flex-1 gap-1.5 p-1.5"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
        }}
      >
        {tabs.map((tab) => (
          <Cell key={tab.id} tabId={tab.id} included={included.includes(tab.id)} />
        ))}
      </div>
    </div>
  )
}

function Cell({ tabId, included }: { tabId: string; included: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const title = useTabs((s) => s.tabs.find((t) => t.id === tabId)?.title ?? '')
  const kind = useTabs((s) => s.tabs.find((t) => t.id === tabId)?.target.kind ?? 'local')
  const hostId = useTabs((s) => {
    const t = s.tabs.find((x) => x.id === tabId)?.target
    return t?.kind === 'host' ? t.hostId : null
  })
  const envColor = useHosts((s) => (hostId ? (s.effective.get(hostId)?.color ?? null) : null))
  const state = useTabStatus((s) => s.byTab[tabId] ?? 'idle')
  const prompt = useTabStatus((s) => s.prompts[tabId])
  const Icon = kind === 'local' || kind === 'module-terminal' ? SquareTerminal : Server

  // Chuyển terminal của tab vào ô này; trả về khi ô biến mất (thoát MultiExec / đóng tab).
  useLayoutEffect(() => {
    const cell = ref.current
    if (!cell) return
    let frame = 0
    let mounted: ReturnType<typeof controllers.get>
    // Tab vừa mở có thể chưa kịp tạo controller → thử lại ở khung hình sau.
    const attach = (): void => {
      const controller = controllers.get(tabId)
      if (controller) {
        controller.mountIn(cell)
        mounted = controller
      } else frame = requestAnimationFrame(attach)
    }
    attach()
    return () => {
      cancelAnimationFrame(frame)
      mounted?.mountIn(null)
    }
  }, [tabId])

  return (
    <div
      className={cx(
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-terminal transition-shadow',
        included ? 'border-warning ring-1 ring-warning' : 'border-line'
      )}
      data-testid="multiexec-cell"
      data-tab-id={tabId}
      data-included={included}
    >
      <div className="relative flex h-7 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 text-xs">
        {envColor && (
          <span
            aria-hidden
            className={cx('absolute inset-x-0 top-0 h-0.5', hostColorClass[envColor])}
          />
        )}
        <span className="relative flex shrink-0" title={connectionLabel[state]}>
          <Icon size={13} className="text-muted" />
          {kind !== 'local' && (
            <StatusDot
              state={state}
              className="absolute -right-0.5 -bottom-0.5 ring-2 ring-surface"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
        <label
          className={cx(
            'flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 font-medium select-none',
            included ? 'bg-warning-soft text-warning' : 'text-muted hover:text-fg'
          )}
          title={
            included ? 'This terminal receives typed input' : 'Typing here stays in this terminal'
          }
        >
          <input
            type="checkbox"
            className="size-3.5 accent-[var(--sh-warning)]"
            data-testid="multiexec-toggle"
            checked={included}
            onChange={() => {
              useBroadcast.getState().toggleTab(tabId)
            }}
          />
          Send input
        </label>
        <button
          type="button"
          aria-label="Open as a tab"
          title="Exit MultiExec and show this terminal"
          className="flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg"
          onClick={() => {
            useBroadcast.getState().stop()
            useTabs.getState().activate(tabId)
          }}
        >
          <Maximize2 size={12} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={ref}
          className="absolute inset-0 pt-1.5 pr-1 pb-1 pl-2"
          onMouseDown={() => {
            controllers.get(tabId)?.focus()
          }}
        />
        {prompt && (
          <PromptDialog
            prompt={prompt}
            onAnswer={(ok, answers) => {
              controllers.get(tabId)?.answerPrompt(prompt.id, ok, answers)
            }}
          />
        )}
      </div>
    </div>
  )
}
