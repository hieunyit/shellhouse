import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownToLine,
  CircleAlert,
  Copy,
  Download,
  Regex,
  Search,
  TriangleAlert
} from 'lucide-react'
import type { Line, LogFeed } from '@shared/log-buffer'
import { t, tn } from '@shared/i18n'
import { logLevel, logMatcher, splitMatches, type LogLevel } from '@shared/log-level'
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

/** Mức log theo dòng (đối tượng dòng giữ nguyên giữa các lần vẽ → chỉ xét mỗi dòng một lần). */
const levels = new WeakMap<Line, LogLevel | null>()
function levelOf(line: Line): LogLevel | null {
  let v = levels.get(line)
  if (v === undefined) {
    v = logLevel(line.text)
    levels.set(line, v)
  }
  return v
}

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
  /** Ô tìm là regex (không phân biệt hoa thường). */
  const [regex, setRegex] = useState(false)
  /** Chỉ xem dòng error / warn (bấm chip). */
  const [level, setLevel] = useState<LogLevel | null>(null)
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

  const q = query.trim()
  const matcher = useMemo(() => logMatcher(query, regex), [query, regex])
  const levelCounts = useMemo(() => {
    let error = 0
    let warn = 0
    for (const l of snapshot) {
      const v = levelOf(l)
      if (v === 'error') error++
      else if (v === 'warn') warn++
    }
    return { error, warn }
  }, [snapshot])
  const lines = useMemo(() => {
    let out = snapshot
    if (sources && hidden.size)
      out = out.filter((l) => {
        const src = sourceOf(l.text)
        return !src || !hidden.has(src)
      })
    if (level) out = out.filter((l) => levelOf(l) === level)
    return matcher.highlight ? out.filter((l) => matcher.test(l.text)) : out
  }, [snapshot, matcher, sources, hidden, level])

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
        <div
          className={cx(
            'flex h-7 w-56 items-center gap-1.5 rounded-md border bg-subtle pr-0.5 pl-2',
            matcher.error ? 'border-ds-danger' : 'border-line'
          )}
          title={matcher.error ?? undefined}
        >
          <Search size={13} className="shrink-0 text-faint" />
          <input
            type="search"
            placeholder={regex ? t('Regex, e.g. status=5\\d\\d') : t('Find in logs…')}
            aria-invalid={matcher.error !== null}
            data-testid={`${testIdPrefix}-logs-search`}
            className={cx(
              'min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint',
              regex && 'font-mono'
            )}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
          />
          <button
            type="button"
            aria-pressed={regex}
            aria-label={t('Regular expression')}
            title={t('Regular expression')}
            data-testid={`${testIdPrefix}-logs-regex`}
            className={cx(
              'flex size-6 shrink-0 items-center justify-center rounded',
              regex ? 'bg-ds-active text-fg' : 'text-faint hover:bg-hover hover:text-fg'
            )}
            onClick={() => {
              setRegex(!regex)
            }}
          >
            <Regex size={13} />
          </button>
        </div>
        {(levelCounts.error > 0 || level === 'error') && (
          <LevelChip
            tone="error"
            on={level === 'error'}
            count={levelCounts.error}
            testId={`${testIdPrefix}-logs-level-error`}
            onClick={() => {
              setLevel(level === 'error' ? null : 'error')
            }}
          />
        )}
        {(levelCounts.warn > 0 || level === 'warn') && (
          <LevelChip
            tone="warn"
            on={level === 'warn'}
            count={levelCounts.warn}
            testId={`${testIdPrefix}-logs-level-warn`}
            onClick={() => {
              setLevel(level === 'warn' ? null : 'warn')
            }}
          />
        )}
        {controls}
        <ToolButton
          icon={<ArrowDownToLine size={13} />}
          label={follow ? t('Following') : t('Follow')}
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
          label={t('Copy')}
          labelAt="4xl"
          onClick={() => void window.shellhouse.writeClipboard(feed.text())}
        />
        <ToolButton
          icon={<Download size={13} />}
          label={t('Download')}
          labelAt="4xl"
          onClick={download}
        />
      </div>
      {matcher.error && (
        <div
          role="alert"
          className="shrink-0 border-b border-line px-3 py-1 text-xs text-ds-danger"
          data-testid={`${testIdPrefix}-logs-regex-error`}
        >
          {t('Invalid regular expression: {error}', { error: matcher.error })}
        </div>
      )}
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
                title={off ? t('Show {name}', { name }) : t('Hide {name}', { name })}
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
              {t('Show all')}
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
        {snapshot.length > 0 && lines.length === 0 && (
          <div
            className="px-3 py-2 font-sans text-faint"
            data-testid={`${testIdPrefix}-logs-empty`}
          >
            {q
              ? t('No lines match “{query}”.', { query: q })
              : level === 'error'
                ? t('No error lines.')
                : level === 'warn'
                  ? t('No warning lines.')
                  : t('All sources are hidden.')}
          </div>
        )}
        <div style={{ height: lines.length * LINE_HEIGHT }} className="relative">
          <div style={{ transform: `translateY(${first * LINE_HEIGHT}px)` }}>
            {lines.slice(first, last).map((l, i) => {
              const lv = levelOf(l)
              return (
                <div
                  key={first + i}
                  style={{ height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
                  className={cx(
                    'px-3 whitespace-pre',
                    lv === 'error'
                      ? 'bg-ds-danger-soft/40 text-ds-danger'
                      : lv === 'warn'
                        ? 'bg-ds-warning-soft/40 text-ds-warning'
                        : l.err
                          ? 'text-danger'
                          : 'text-fg'
                  )}
                  data-testid={`${testIdPrefix}-log-line`}
                  {...(lv ? { 'data-level': lv } : {})}
                >
                  {sources ? (
                    <SourceLine text={l.text} highlight={matcher.highlight} />
                  ) : (
                    <Highlighted text={l.text} re={matcher.highlight} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Dòng log gộp: tiền tố "[nguồn]" tô màu theo nguồn, phần còn lại như thường (tô chỗ khớp). */
function SourceLine({
  text,
  highlight
}: {
  text: string
  highlight: RegExp | null
}): React.JSX.Element {
  const m = SOURCE.exec(text)
  if (!m) return <Highlighted text={text} re={highlight} />
  const name = m[1] ?? ''
  return (
    <>
      <span style={{ color: sourceColor(name) }} className="font-medium">
        [{name}]
      </span>{' '}
      <Highlighted text={text.slice(m[0].length)} re={highlight} />
    </>
  )
}

/** Chữ của dòng, chỗ khớp với ô tìm được tô nền. */
function Highlighted({ text, re }: { text: string; re: RegExp | null }): React.JSX.Element {
  if (!text) return <> </>
  if (!re) return <>{text}</>
  return (
    <>
      {splitMatches(text, re).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded-[2px] bg-ds-warning/35 text-fg" data-testid="log-match">
            {part.text}
          </mark>
        ) : (
          part.text
        )
      )}
    </>
  )
}

/** Chip lọc nhanh theo mức: "3 errors" / "12 warnings"; bấm để chỉ xem các dòng đó. */
function LevelChip({
  tone,
  on,
  count,
  testId,
  onClick
}: {
  tone: LogLevel
  on: boolean
  count: number
  testId: string
  onClick: () => void
}): React.JSX.Element {
  const label =
    tone === 'error'
      ? tn(count, '{n} error', '{n} errors')
      : tn(count, '{n} warning', '{n} warnings')
  return (
    <button
      type="button"
      aria-pressed={on}
      title={on ? t('Show all lines') : t('Show only these lines')}
      data-testid={testId}
      className={cx(
        'flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] tabular-nums',
        tone === 'error' ? 'text-ds-danger' : 'text-ds-warning',
        on
          ? tone === 'error'
            ? 'border-ds-danger bg-ds-danger-soft'
            : 'border-ds-warning bg-ds-warning-soft'
          : 'border-line hover:bg-hover'
      )}
      onClick={onClick}
    >
      {tone === 'error' ? <CircleAlert size={12} /> : <TriangleAlert size={12} />}
      {label}
    </button>
  )
}
