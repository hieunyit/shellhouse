import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDownToLine, Copy, Download, Search } from 'lucide-react'
import type { Line, LogFeed } from '@shared/log-buffer'
import { ToolButton } from './files/parts'
import { cx } from './ui'

const LINE_HEIGHT = 18

/** Tiền tố nguồn của log gộp: "[pod/container] " (Kubernetes) / "[service] " (Compose). */
const SOURCE = /^\[([^\]\n]{1,160})\] /
/** Màu nguồn — đọc được trên nền sáng lẫn tối, đủ khác nhau. */
const SOURCE_COLORS = [
  '#2f7de1',
  '#d9480f',
  '#2b9348',
  '#ae3ec9',
  '#0c8599',
  '#e67700',
  '#d6336c',
  '#5c7cfa',
  '#74b816',
  '#f76707',
  '#15aabf',
  '#9c36b5'
]
/** Màu cố định theo tên nguồn (cùng pod → cùng màu giữa các lần mở). */
export function sourceColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return SOURCE_COLORS[Math.abs(h) % SOURCE_COLORS.length] ?? '#2f7de1'
}
const sourceOf = (text: string): string | null => SOURCE.exec(text)?.[1] ?? null

/**
 * Trình xem log dùng chung (log container Docker, log pod Kubernetes…): tìm, theo dõi (cuộn lên =
 * tạm dừng, xuống đáy = theo lại), copy, tải về; cuộn ảo nên chục nghìn dòng vẫn nhẹ.
 */
export function LogViewer({
  feed,
  fileName,
  testIdPrefix,
  controls,
  notice,
  placeholder,
  sources = false
}: {
  feed: LogFeed
  /** Tên file khi tải về (không có đuôi). */
  fileName: string
  testIdPrefix: string
  /** Nút / lựa chọn riêng (tail, timestamps, container…) đặt trên thanh công cụ. */
  controls?: ReactNode
  /** Dòng thông báo phía trên log (luồng kết thúc, lỗi…). */
  notice?: ReactNode
  /** Hiện khi chưa có dòng nào (đang kết nối…). */
  placeholder?: ReactNode
  /**
   * Log gộp nhiều nguồn (mỗi dòng "[nguồn] …"): tô màu tiền tố theo nguồn và có hàng chip để
   * chỉ xem một số nguồn (như stern / kubetail).
   */
  sources?: boolean
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Line[]>(() => [...feed.lines()])
  const [follow, setFollow] = useState(true)
  const [query, setQuery] = useState('')
  const frame = useRef<number | null>(null)

  // Vẽ lại tối đa mỗi khung hình.
  useEffect(() => {
    const off = feed.subscribe(() => {
      frame.current ??= requestAnimationFrame(() => {
        frame.current = null
        setSnapshot([...feed.lines()])
      })
    })
    return () => {
      off()
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [feed])

  /** Nguồn đang ẩn (bấm chip để bật / tắt). */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const sourceCounts = useMemo(() => {
    if (!sources) return []
    const counts = new Map<string, number>()
    for (const l of snapshot) {
      const src = sourceOf(l.text)
      if (src) counts.set(src, (counts.get(src) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 40)
  }, [snapshot, sources])

  const q = query.trim().toLowerCase()
  const lines = useMemo(() => {
    let out = snapshot
    if (sources && hidden.size)
      out = out.filter((l) => {
        const src = sourceOf(l.text)
        return !src || !hidden.has(src)
      })
    return q ? out.filter((l) => l.text.toLowerCase().includes(q)) : out
  }, [snapshot, q, sources, hidden])

  const scroller = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, height: 600 })
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [lines, follow])
  const first = Math.max(0, Math.floor(scroll.top / LINE_HEIGHT) - 20)
  const last = Math.min(lines.length, Math.ceil((scroll.top + scroll.height) / LINE_HEIGHT) + 20)

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([feed.text()], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileName}.log`
    a.click()
    setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 10_000)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="@container flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="flex h-7 w-48 items-center gap-1.5 rounded-md border border-line bg-subtle px-2">
          <Search size={13} className="text-faint" />
          <input
            type="search"
            placeholder="Find in logs…"
            data-testid={`${testIdPrefix}-logs-search`}
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
          />
        </div>
        {controls}
        <ToolButton
          icon={<ArrowDownToLine size={13} />}
          label={follow ? 'Following' : 'Follow'}
          labelAt="xl"
          pressed={follow}
          testId={`${testIdPrefix}-logs-follow`}
          onClick={() => {
            setFollow(!follow)
          }}
        />
        <div className="flex-1" />
        <ToolButton
          icon={<Copy size={13} />}
          label="Copy"
          labelAt="4xl"
          onClick={() => void window.shellhouse.writeClipboard(feed.text())}
        />
        <ToolButton
          icon={<Download size={13} />}
          label="Download"
          labelAt="4xl"
          onClick={download}
        />
      </div>
      {notice}
      {sources && sourceCounts.length > 1 && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5"
          data-testid={`${testIdPrefix}-log-sources`}
        >
          {sourceCounts.map(([name, count]) => {
            const off = hidden.has(name)
            return (
              <button
                key={name}
                type="button"
                aria-pressed={!off}
                title={off ? `Show ${name}` : `Hide ${name}`}
                data-testid={`${testIdPrefix}-log-source`}
                data-name={name}
                className={cx(
                  'flex h-6 max-w-64 items-center gap-1.5 rounded-full border px-2 font-mono text-[11px]',
                  off ? 'border-line text-faint line-through' : 'border-line-strong text-fg'
                )}
                onClick={() => {
                  const next = new Set(hidden)
                  if (off) next.delete(name)
                  else next.add(name)
                  setHidden(next)
                }}
                onDoubleClick={() => {
                  // Bấm đúp: chỉ xem nguồn này (bấm đúp lần nữa: xem lại tất cả).
                  const only = sourceCounts.every(([n]) => n === name || hidden.has(n)) && !off
                  setHidden(
                    only
                      ? new Set()
                      : new Set(sourceCounts.map(([n]) => n).filter((n) => n !== name))
                  )
                }}
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: sourceColor(name) }}
                />
                <span className="truncate">{name}</span>
                <span className="text-faint tabular-nums">{count}</span>
              </button>
            )
          })}
          {hidden.size > 0 && (
            <button
              type="button"
              className="ml-1 text-[11px] text-accent hover:underline"
              onClick={() => {
                setHidden(new Set())
              }}
            >
              Show all
            </button>
          )}
        </div>
      )}
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto bg-terminal font-mono text-xs select-text"
        data-testid={`${testIdPrefix}-logs`}
        onScroll={(e) => {
          const el = e.currentTarget
          setScroll({ top: el.scrollTop, height: el.clientHeight })
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < LINE_HEIGHT * 2
          if (atBottom !== follow) setFollow(atBottom)
        }}
      >
        {snapshot.length === 0 && placeholder}
        <div style={{ height: lines.length * LINE_HEIGHT }} className="relative">
          <div style={{ transform: `translateY(${first * LINE_HEIGHT}px)` }}>
            {lines.slice(first, last).map((l, i) => (
              <div
                key={first + i}
                style={{ height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
                className={cx('px-3 whitespace-pre', l.err ? 'text-danger' : 'text-fg')}
                data-testid={`${testIdPrefix}-log-line`}
              >
                {sources ? <SourceLine text={l.text} /> : l.text || ' '}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Dòng log gộp: tiền tố "[nguồn]" tô màu theo nguồn, phần còn lại như thường. */
function SourceLine({ text }: { text: string }): React.JSX.Element {
  const m = SOURCE.exec(text)
  if (!m) return <>{text || ' '}</>
  const name = m[1] ?? ''
  return (
    <>
      <span style={{ color: sourceColor(name) }} className="font-medium">
        [{name}]
      </span>{' '}
      {text.slice(m[0].length)}
    </>
  )
}
