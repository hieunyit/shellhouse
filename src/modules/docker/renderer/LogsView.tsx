import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Clock, Copy, Download, RefreshCw, Search } from 'lucide-react'
import { cx, Notice, Select } from '../../../renderer/src/components/ui'
import { ToolButton } from '../../../renderer/src/components/files/parts'
import { cleanError } from '../../../renderer/src/lib/format'
import { ConnectionPrompt } from '../../registry/renderer-kit'
import type { ModuleTabProps } from '../../registry/renderer-types'
import type { DockerLogsParams, LogsEvent } from '../shared/ops'
import { useDockerSession } from './useDockerSession'
import { LineBuffer, type Line } from '../shared/log-buffer'

const LINE_HEIGHT = 18

/** Tab log của một container. */
export function LogsTab({ tabId, params }: ModuleTabProps<DockerLogsParams>): React.JSX.Element {
  const buffer = useRef(new LineBuffer())
  const subscription = useRef<string | null>(null)
  /** Ảnh chụp bộ đệm để vẽ (cập nhật tối đa mỗi khung hình). */
  const [snapshot, setSnapshot] = useState<Line[]>([])
  const [tail, setTail] = useState(500)
  const [timestamps, setTimestamps] = useState(false)
  const [follow, setFollow] = useState(true)
  const [query, setQuery] = useState('')
  const [ended, setEnded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restart, setRestart] = useState(0)
  const frame = useRef<number | null>(null)

  const onEvent = useCallback((event: string, data: unknown) => {
    const d = data as LogsEvent & { error?: string }
    if (d.subscription !== subscription.current) return
    if (event === 'logs') {
      buffer.current.push(d.text, d.stream === 'stderr')
      // Vẽ lại tối đa mỗi khung hình.
      frame.current ??= requestAnimationFrame(() => {
        frame.current = null
        setSnapshot([...buffer.current.all()])
      })
    } else if (event === 'logs-end') {
      setEnded(d.error ?? 'The log stream ended (the container stopped).')
    }
  }, [])
  const session = useDockerSession(tabId, params.hostId, onEvent)
  const { ready, request } = session

  useEffect(() => {
    if (!ready) return
    let sub: string | null = null
    let cancelled = false
    request<{ subscription: string }>({
      op: 'logs.subscribe',
      id: params.container,
      tail,
      timestamps
    }).then(
      (r) => {
        if (cancelled) {
          void request({ op: 'unsubscribe', subscription: r.subscription })
          return
        }
        sub = r.subscription
        buffer.current.clear()
        setSnapshot([])
        setEnded(null)
        setError(null)
        subscription.current = r.subscription
      },
      (e: unknown) => {
        setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
      subscription.current = null
      if (sub) void request({ op: 'unsubscribe', subscription: sub }).catch(() => undefined)
    }
  }, [ready, request, params.container, tail, timestamps, restart])

  const q = query.trim().toLowerCase()
  const lines = useMemo(
    () => (q ? snapshot.filter((l) => l.text.toLowerCase().includes(q)) : snapshot),
    [snapshot, q]
  )

  // Cuộn ảo: chỉ vẽ các dòng đang thấy.
  const scroller = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, height: 600 })
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [lines, follow])
  const first = Math.max(0, Math.floor(scroll.top / LINE_HEIGHT) - 20)
  const last = Math.min(lines.length, Math.ceil((scroll.top + scroll.height) / LINE_HEIGHT) + 20)

  const text = (): string =>
    buffer.current
      .all()
      .map((l) => l.text)
      .join('\n')
  const download = (): void => {
    const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${params.name}.log`
    a.click()
    setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 10_000)
  }

  return (
    <div className="relative flex h-full flex-col bg-surface" data-testid="docker-logs-view">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="mr-2 truncate text-[13px] font-medium text-fg">{params.name}</span>
        <div className="flex h-7 w-48 items-center gap-1.5 rounded-md border border-line bg-subtle px-2">
          <Search size={13} className="text-faint" />
          <input
            type="search"
            placeholder="Find in logs…"
            data-testid="docker-logs-search"
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
          />
        </div>
        <Select
          aria-label="Lines to load"
          className="h-7 w-28 text-xs"
          value={String(tail)}
          onChange={(e) => {
            setTail(Number(e.target.value))
          }}
        >
          {[100, 500, 1000, 5000, 50_000].map((n) => (
            <option key={n} value={n}>
              Last {n.toLocaleString('en')}
            </option>
          ))}
        </Select>
        <ToolButton
          icon={<Clock size={13} />}
          label="Timestamps"
          labelAt="3xl"
          pressed={timestamps}
          testId="docker-logs-timestamps"
          onClick={() => {
            setTimestamps(!timestamps)
          }}
        />
        <ToolButton
          icon={<ArrowDownToLine size={13} />}
          label={follow ? 'Following' : 'Follow'}
          labelAt="xl"
          pressed={follow}
          testId="docker-logs-follow"
          onClick={() => {
            setFollow(!follow)
          }}
        />
        <div className="flex-1" />
        <ToolButton
          icon={<Copy size={13} />}
          label="Copy"
          labelAt="4xl"
          onClick={() => void window.shellhouse.writeClipboard(text())}
        />
        <ToolButton
          icon={<Download size={13} />}
          label="Download"
          labelAt="4xl"
          onClick={download}
        />
      </div>
      {(error ?? ended) && (
        <div className="flex items-center gap-2 border-b border-line p-2">
          <div className="flex-1">
            <Notice tone={error ? 'danger' : 'info'} testId="docker-logs-ended">
              {error ?? ended}
            </Notice>
          </div>
          <ToolButton
            icon={<RefreshCw size={13} />}
            label="Reconnect"
            labelAt="md"
            onClick={() => {
              setRestart((r) => r + 1)
            }}
          />
        </div>
      )}
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto bg-terminal font-mono text-xs select-text"
        data-testid="docker-logs"
        onScroll={(e) => {
          const el = e.currentTarget
          setScroll({ top: el.scrollTop, height: el.clientHeight })
          // Cuộn lên = tạm dừng theo dõi; cuộn xuống đáy = theo lại.
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < LINE_HEIGHT * 2
          if (atBottom !== follow) setFollow(atBottom)
        }}
      >
        {!session.ready && !session.error && <p className="p-3 text-faint">{session.status}</p>}
        {session.error && <p className="p-3 text-danger">{session.error}</p>}
        <div style={{ height: lines.length * LINE_HEIGHT }} className="relative">
          <div style={{ transform: `translateY(${first * LINE_HEIGHT}px)` }}>
            {lines.slice(first, last).map((l, i) => (
              <div
                key={first + i}
                style={{ height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
                className={cx('px-3 whitespace-pre', l.err ? 'text-danger' : 'text-fg')}
                data-testid="docker-log-line"
              >
                {l.text || ' '}
              </div>
            ))}
          </div>
        </div>
      </div>
      {session.prompt && <ConnectionPrompt prompt={session.prompt} onAnswer={session.answer} />}
    </div>
  )
}
