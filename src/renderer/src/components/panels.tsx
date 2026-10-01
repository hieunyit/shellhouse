import type { ReactNode } from 'react'
import { cx, Kbd } from './ui'

/**
 * Thành phần giao diện dùng chung cho các màn quản trị (Docker, Kubernetes…): pill trạng thái,
 * dải tab, thanh phím tắt, biểu đồ nhỏ, thanh đo, thẻ số liệu, danh sách định nghĩa. Module được
 * phép import file này (ESLint).
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted'

const PILL: Record<Tone, string> = {
  ok: 'bg-success-soft text-success',
  warn: 'bg-warning-soft text-warning',
  bad: 'bg-danger-soft text-danger',
  info: 'bg-accent-soft text-accent',
  muted: 'bg-subtle text-muted'
}

const DOT: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger',
  info: 'bg-accent',
  muted: 'bg-line-strong'
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  info: 'text-accent',
  muted: 'text-faint'
}

/** Nhãn trạng thái (Running, CrashLoopBackOff…). */
export function Pill({
  tone,
  children,
  dot = true,
  title
}: {
  tone: Tone
  children: ReactNode
  dot?: boolean
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex max-w-full items-center gap-1 truncate rounded-full px-1.5 py-px text-[11px] font-medium',
        PILL[tone]
      )}
    >
      {dot && <span className={cx('size-1.5 shrink-0 rounded-full', DOT[tone])} />}
      <span className="truncate">{children}</span>
    </span>
  )
}

/** Dải tab gạch chân (trang chi tiết). */
export function TabStrip<T extends string>({
  tabs,
  value,
  onChange,
  testIdPrefix
}: {
  tabs: readonly { id: T; label: string; count?: number | undefined }[]
  value: T
  onChange: (id: T) => void
  testIdPrefix?: string
}): React.JSX.Element {
  return (
    <div role="tablist" className="flex shrink-0 gap-3 overflow-x-auto border-b border-line px-3">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          data-testid={testIdPrefix ? `${testIdPrefix}-${t.id}` : undefined}
          className={cx(
            '-mb-px h-9 shrink-0 border-b-2 text-xs font-medium whitespace-nowrap transition-colors',
            value === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
          )}
          onClick={() => {
            onChange(t.id)
          }}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1 text-faint tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** Thanh gợi ý phím tắt ở đáy (kiểu k9s). */
export function KeyHints({
  items,
  className
}: {
  items: readonly (readonly [string, string])[]
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line bg-subtle px-2 text-[11px] whitespace-nowrap text-faint',
        className
      )}
      data-testid="key-hints"
    >
      {items.map(([key, label]) => (
        <span key={key} className="flex items-center gap-1">
          <Kbd>{key}</Kbd>
          {label}
        </span>
      ))}
    </div>
  )
}

/** Biểu đồ đường nhỏ (SVG) cho chuỗi giá trị 0…max. */
export function Sparkline({
  values,
  max,
  className,
  fill = true
}: {
  values: readonly number[]
  max: number
  className?: string
  fill?: boolean
}): React.JSX.Element {
  const w = 240
  const h = 40
  const top = Math.max(max, 1e-9)
  const pts = values.map(
    (v, i) =>
      [
        (i / Math.max(values.length - 1, 1)) * w,
        h - (Math.min(v, top) / top) * (h - 2) - 1
      ] as const
  )
  const line = pts.map(([x, y]) => `${x},${y}`).join(' ')
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={cx('h-10 w-full text-accent', className)}
      preserveAspectRatio="none"
      aria-hidden
    >
      {fill && pts.length > 1 && (
        <polygon points={`0,${h} ${line} ${w},${h}`} fill="currentColor" opacity="0.12" />
      )}
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** Thanh đo (đã dùng / tổng), đổi màu khi gần đầy. */
export function Meter({
  value,
  max,
  label,
  detail,
  testId
}: {
  value: number
  max: number
  label: string
  detail?: string
  testId?: string
}): React.JSX.Element {
  const ratio = max > 0 ? Math.min(1, value / max) : 0
  const tone = ratio > 0.9 ? 'bg-danger-solid' : ratio > 0.75 ? 'bg-warning' : 'bg-accent-solid'
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <div className="flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="text-fg tabular-nums">{detail ?? `${Math.round(ratio * 100)}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-subtle">
        <div
          className={cx('h-full rounded-full transition-[width]', tone)}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  )
}

/** Thẻ số liệu (trang tổng quan). */
export function StatCard({
  label,
  value,
  sub,
  tone = 'muted',
  onClick,
  testId
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: Tone
  onClick?: () => void
  testId?: string
}): React.JSX.Element {
  const body = (
    <>
      <span className="text-[11px] font-medium tracking-wide text-faint uppercase">{label}</span>
      <span
        className={cx(
          'text-xl font-semibold tabular-nums',
          tone === 'muted' ? 'text-fg' : TONE_TEXT[tone]
        )}
      >
        {value}
      </span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </>
  )
  const cls =
    'flex min-w-0 flex-col gap-0.5 rounded-lg border border-line bg-surface p-3 text-left shadow-xs'
  return onClick ? (
    <button
      type="button"
      data-testid={testId}
      className={cx(cls, 'hover:border-line-strong')}
      onClick={onClick}
    >
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  )
}

/** Danh sách nhãn → giá trị (trang chi tiết). */
export function DefList({
  items,
  className
}: {
  items: readonly (readonly [string, ReactNode] | null | false)[]
  className?: string
}): React.JSX.Element {
  return (
    <dl
      className={cx('grid grid-cols-[minmax(5.5rem,auto)_1fr] gap-x-3 gap-y-1 text-xs', className)}
    >
      {items
        .filter((i): i is readonly [string, ReactNode] => Boolean(i))
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-faint">{label}</dt>
            <dd className="min-w-0 break-words text-fg">{value}</dd>
          </div>
        ))}
    </dl>
  )
}

/** Tiêu đề nhỏ của một khối trong trang chi tiết. */
export function Heading({
  children,
  action
}: {
  children: ReactNode
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <h4 className="flex-1 text-[11px] font-semibold tracking-wider text-faint uppercase">
        {children}
      </h4>
      {action}
    </div>
  )
}

/** Chuỗi nhãn key=value. */
export function LabelChips({
  labels
}: {
  labels: Record<string, string> | undefined
}): React.JSX.Element | null {
  const entries = Object.entries(labels ?? {})
  if (entries.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="max-w-full truncate rounded bg-subtle px-1.5 py-px font-mono text-[11px] text-muted"
          title={`${k}=${v}`}
        >
          {k}
          {v ? `=${v}` : ''}
        </span>
      ))}
    </div>
  )
}
