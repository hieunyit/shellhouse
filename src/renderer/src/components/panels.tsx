import { useEffect, useRef, useState, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { formatPercent } from '@shared/i18n/format'
import { choiceKeyDown, cx, Kbd } from './ui'

/**
 * Thành phần giao diện dùng chung cho các màn quản trị (Docker, Kubernetes…): pill trạng thái,
 * dải tab, thanh phím tắt, biểu đồ nhỏ, thanh đo, thẻ số liệu, danh sách định nghĩa. Module được
 * phép import file này (ESLint).
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted'

// Màu theo ngữ nghĩa (thiết kế v0.5): xanh lá khoẻ · vàng chờ / cảnh báo · đỏ lỗi · xanh dương
// thông tin / tiến trình · xám dừng / không rõ (vòng rỗng).
const PILL: Record<Tone, string> = {
  ok: 'bg-success-soft text-success',
  warn: 'bg-warning-soft text-warning',
  bad: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  muted: 'bg-ds-active text-muted'
}

const DOT: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger',
  info: 'bg-info',
  muted: 'border border-ds-status-off bg-transparent'
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  info: 'text-info',
  muted: 'text-faint'
}

/**
 * Nhãn trạng thái (Running, CrashLoopBackOff…). Có chấm (mặc định): chấm + chữ cùng màu, không nền
 * — mỗi hàng bảng chỉ một chỉ báo trạng thái. `dot={false}`: chip nền nhạt (nhãn phụ, header).
 */
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
  if (dot)
    return (
      <span
        title={title}
        className={cx(
          'inline-flex max-w-full min-w-0 items-center gap-1.5 truncate text-[12px] font-medium',
          tone === 'muted' ? 'text-muted' : TONE_TEXT[tone]
        )}
      >
        <span className={cx('size-1.5 shrink-0 rounded-full', DOT[tone])} />
        <span className="truncate">{children}</span>
      </span>
    )
  return (
    <span
      title={title}
      className={cx(
        'inline-flex h-5 max-w-full items-center gap-1 truncate rounded-ds-sm px-1.5 text-[11px] font-medium',
        PILL[tone]
      )}
    >
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
  const strip = useRef<HTMLDivElement>(null)
  /** Còn tab bị cắt ở mép phải (thanh cuộn ẩn) → mờ dần mép đó để người dùng biết còn tab. */
  const [more, setMore] = useState(false)
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const measure = (): void => {
      setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [tabs.length])
  // Tab đang chọn luôn nằm trong vùng nhìn thấy (chọn bằng phím / từ nơi khác).
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [value])
  return (
    <div
      ref={strip}
      role="tablist"
      className={cx(
        'flex shrink-0 gap-4 overflow-x-auto border-b border-ds-border-subtle px-3 [scrollbar-width:none]',
        more && '[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)]'
      )}
      onKeyDown={(e) => {
        choiceKeyDown(
          e,
          tabs.map((tab) => tab.id),
          value,
          onChange
        )
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          tabIndex={value === tab.id || !tabs.some((x) => x.id === value) ? 0 : -1}
          data-testid={testIdPrefix ? `${testIdPrefix}-${tab.id}` : undefined}
          className={cx(
            '-mb-px h-ds-tab shrink-0 border-b-2 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:shadow-ds-focus focus-visible:outline-none',
            value === tab.id
              ? 'border-ds-accent text-fg'
              : 'border-transparent text-muted hover:text-fg'
          )}
          onClick={() => {
            onChange(tab.id)
          }}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="ml-1 text-faint tabular-nums">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/**
 * Thanh phím tắt cuối màn: vài phím chính + nút "Shortcuts" mở bảng đầy đủ (phím ?). Không bắt
 * người dùng chuột phải học phím — mọi thao tác vẫn có nút / menu; phím chỉ để đi nhanh.
 */
export function KeyHints({
  items,
  all,
  open = false,
  onOpenChange,
  className
}: {
  /** Luôn hiện (ngắn: 3–5 mục). */
  items: readonly (readonly [string, string])[]
  /** Bảng đầy đủ theo nhóm — có thì hiện nút "Shortcuts". */
  all?: readonly { title: string; keys: readonly (readonly [string, string])[] }[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange?.(false)
    }
    window.addEventListener('mousedown', close)
    return () => {
      window.removeEventListener('mousedown', close)
    }
  }, [open, onOpenChange])
  return (
    <div
      ref={ref}
      className={cx(
        'relative flex h-7 shrink-0 items-center gap-3 border-t border-ds-border-subtle px-3 text-[11px] whitespace-nowrap text-faint',
        className
      )}
      data-testid="key-hints"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        {items.map(([key, label]) => (
          <span key={key} className="flex items-center gap-1">
            <Kbd>{key}</Kbd>
            {label}
          </span>
        ))}
      </div>
      {all && (
        <button
          type="button"
          className={cx(
            'flex shrink-0 items-center gap-1 rounded px-1 hover:text-fg',
            open && 'text-fg'
          )}
          data-testid="key-hints-all"
          aria-expanded={open}
          onClick={() => onOpenChange?.(!open)}
        >
          <Kbd>?</Kbd>
          {t('Shortcuts')}
        </button>
      )}
      {all && open && (
        <div
          role="dialog"
          aria-label={t('Keyboard shortcuts')}
          data-testid="key-hints-sheet"
          className="absolute right-2 bottom-8 z-40 grid max-h-[70vh] w-[30rem] max-w-[calc(100%-1rem)] grid-cols-2 gap-x-6 gap-y-3 overflow-auto rounded-ds-lg bg-ds-popover p-3 text-xs whitespace-normal shadow-ds-popover"
        >
          {all.map((g) => (
            <div key={g.title} className="flex flex-col gap-1">
              <div className="text-xs font-medium text-faint">{g.title}</div>
              {g.keys.map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-3">
                  <span className="text-muted">{label}</span>
                  <Kbd>{key}</Kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
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
      className={cx('h-10 w-full text-chart', className)}
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
  neutral,
  testId
}: {
  value: number
  max: number
  label: string
  detail?: string
  /** Không tô vàng / đỏ khi gần đầy (vd. phần "có thể dọn" — đầy là tốt, không phải báo động). */
  neutral?: boolean
  testId?: string
}): React.JSX.Element {
  const ratio = max > 0 ? Math.min(1, value / max) : 0
  const tone = neutral || ratio < 0.75 ? 'bg-chart' : ratio >= 0.9 ? 'bg-danger' : 'bg-warning'
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <div className="flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="text-fg tabular-nums">{detail ?? formatPercent(ratio)}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-ds-chart-track">
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
      <span className="text-xs font-medium text-faint">{label}</span>
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
    'flex min-w-0 flex-col gap-0.5 rounded-ds-lg border border-ds-border-subtle bg-surface p-3 text-left'
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
      className={cx(
        'grid grid-cols-[minmax(6rem,8rem)_1fr] gap-x-3 gap-y-1.5 text-[13px]',
        className
      )}
    >
      {items
        .filter((i): i is readonly [string, ReactNode] => Boolean(i))
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
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
      <h4 className="flex-1 text-[13px] font-medium text-fg">{children}</h4>
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
          className="max-w-full truncate rounded-ds-xs bg-ds-active px-1.5 py-px font-mono text-[11px] text-muted"
          title={`${k}=${v}`}
        >
          {k}
          {v ? `=${v}` : ''}
        </span>
      ))}
    </div>
  )
}

/** Độ rộng đã kéo của từng loại bảng chi tiết (tiện lợi theo máy — lỗi lưu trữ thì bỏ qua). */
function savedWidth(key: string): number | null {
  try {
    const v = Number(window.localStorage.getItem(`shellhouse.panel.${key}`))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}
function saveWidth(key: string, width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(`shellhouse.panel.${key}`)
    else window.localStorage.setItem(`shellhouse.panel.${key}`, String(Math.round(width)))
  } catch {
    // Bỏ qua.
  }
}

/**
 * Bảng chi tiết bên phải, kéo mép trái để đổi độ rộng (như Lens); bấm đúp mép để về mặc định. Độ
 * rộng nhớ theo `storageKey`; không quá 70% khung.
 */
export function SidePanel({
  storageKey,
  defaultWidth = 416,
  minWidth = 300,
  testId,
  expanded = false,
  maxRatio,
  overlay = false,
  children
}: {
  storageKey: string
  defaultWidth?: number
  minWidth?: number
  testId?: string
  /** Phóng to hết chỗ (che nội dung bên cạnh) — vd. trang chi tiết đầy đủ. */
  expanded?: boolean
  /** Tỉ lệ tối đa so với khung cha (mặc định 0,7) — vd. bản đồ cần giữ chỗ cho canvas. */
  maxRatio?: number
  /**
   * Khung quá hẹp để chia đôi: bảng nổi đè lên mép phải nội dung (như ngăn kéo) thay vì ép nội
   * dung — cha cần `relative`.
   */
  overlay?: boolean
  children: ReactNode
}): React.JSX.Element {
  const [width, setWidth] = useState<number>(() => savedWidth(storageKey) ?? defaultWidth)
  const drag = useRef<{ x: number; width: number } | null>(null)
  if (expanded)
    return (
      <aside
        className="relative flex min-w-0 flex-1 flex-col border-l border-ds-border-subtle bg-surface"
        data-testid={testId}
        data-expanded="true"
      >
        {children}
      </aside>
    )
  return (
    <aside
      className={
        overlay
          ? 'absolute inset-y-0 right-0 z-20 flex flex-col bg-surface shadow-ds-sheet'
          : 'relative flex max-w-[70%] shrink-0 flex-col border-l border-ds-border-subtle bg-surface'
      }
      style={
        overlay
          ? { width, maxWidth: 'calc(100% - 3rem)' }
          : maxRatio
            ? { width, maxWidth: `${String(maxRatio * 100)}%` }
            : { width }
      }
      data-testid={testId}
      data-overlay={overlay || undefined}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('Resize the panel')}
        title={t('Drag to resize · double-click to reset')}
        data-testid="side-panel-resize"
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize hover:bg-ds-border-strong active:bg-accent/40"
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, width }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          // Kéo quá mức tối đa thì giữ ở mức đó — kéo ngược lại có tác dụng ngay.
          const parent = e.currentTarget.parentElement?.parentElement?.clientWidth
          const max = !parent
            ? Infinity
            : overlay
              ? parent - 48
              : maxRatio
                ? parent * maxRatio
                : Infinity
          setWidth(Math.max(minWidth, Math.min(max, d.width + (d.x - e.clientX))))
        }}
        onPointerUp={(e) => {
          if (!drag.current) return
          drag.current = null
          e.currentTarget.releasePointerCapture(e.pointerId)
          saveWidth(storageKey, width)
        }}
        onDoubleClick={() => {
          setWidth(defaultWidth)
          saveWidth(storageKey, null)
        }}
      />
      {children}
    </aside>
  )
}
