import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDownToLine, Copy, Download, Search } from 'lucide-react'
import type { Line, LogFeed } from '@shared/log-buffer'
import { ToolButton } from './files/parts'
import { cx } from './ui'

const LINE_HEIGHT = 18

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
  placeholder
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

  const q = query.trim().toLowerCase()
  const lines = useMemo(
    () => (q ? snapshot.filter((l) => l.text.toLowerCase().includes(q)) : snapshot),
    [snapshot, q]
  )

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
                {l.text || ' '}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
