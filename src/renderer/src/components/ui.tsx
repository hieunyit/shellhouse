import { createPortal } from 'react-dom'
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'
import { X } from 'lucide-react'
import { t } from '@shared/i18n'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

// ---------- Button ----------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
type Size = 'sm' | 'md'

// Cùng ngôn ngữ với design system (ds/Button): không bóng, viền 1px mảnh, cao theo mật độ.
const variants: Record<Variant, string> = {
  primary: 'bg-accent-solid text-accent-fg hover:bg-accent-solid-hover active:bg-ds-accent-press',
  secondary:
    'border border-line bg-subtle text-fg hover:border-line-strong hover:bg-hover [&_svg]:text-muted',
  ghost: 'text-muted hover:bg-ds-hover hover:text-fg active:bg-ds-active',
  danger: 'bg-danger-solid text-ds-danger-contrast hover:bg-ds-danger-solid-hover',
  'danger-ghost': 'text-danger hover:bg-danger-soft'
}
const sizes: Record<Size, string> = {
  sm: 'h-ds-ctl-sm gap-1 rounded-ds-sm px-2 text-xs',
  md: 'h-ds-ctl gap-1.5 rounded-ds-md px-3 text-[13px]'
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: ReactNode }
>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, type, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow] duration-(--ds-dur-fast) select-none focus-visible:shadow-ds-focus focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: 'sm' | 'md' }
>(function IconButton({ label, active, size = 'md', className, children, type, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center text-muted transition-colors duration-(--ds-dur-fast) hover:bg-ds-hover hover:text-fg focus-visible:shadow-ds-focus focus-visible:outline-none active:bg-ds-active disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'size-ds-ctl-sm rounded-ds-sm' : 'size-ds-ctl rounded-ds-md',
        active && 'bg-ds-active text-fg',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

// ---------- Inputs ----------

// Viền control ≥ 3:1 (WCAG 1.4.11) — --ds-border-control; focus: viền accent + quầng accent-soft.
const control =
  'w-full rounded-ds-md border border-ds-border-control bg-subtle px-2.5 text-[13px] text-fg placeholder:text-faint outline-none transition-[border-color,box-shadow] duration-(--ds-dur-fast) hover:border-faint focus:border-ds-accent focus:bg-surface focus:ring-3 focus:ring-ds-accent-soft focus-visible:outline-none disabled:opacity-50'

/** Nhóm thuộc tính của một class Tailwind (chỉ những nhóm control hay bị ghi đè). */
function groupOf(cls: string): string | null {
  if (/^(w-|flex-1$)/.test(cls)) return 'w'
  if (/^h-/.test(cls)) return 'h'
  if (/^text-(xs|sm|base|lg|xl|\[\d)/.test(cls)) return 'size'
  if (/^font-(mono|sans)$/.test(cls)) return 'family'
  return null
}

/**
 * Như `cx`, nhưng class truyền vào ghi đè class gốc cùng nhóm (w-28 thay w-full, h-7 thay h-8,
 * text-xs thay text-[13px]). Không có bước này cả hai cùng có mặt và thứ tự trong CSS quyết định —
 * thường là class gốc thắng.
 */
function controlCx(base: (string | false | null | undefined)[], extra?: string): string {
  const over = new Set((extra ?? '').split(/\s+/).map(groupOf).filter(Boolean))
  const kept = cx(...base)
    .split(/\s+/)
    .filter((c) => {
      const g = groupOf(c)
      return !(g && over.has(g))
    })
  return cx(...kept, extra)
}

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }
>(function Input({ className, mono, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={controlCx([control, 'h-ds-ctl', mono && 'font-mono text-xs'], className)}
      {...rest}
    />
  )
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={controlCx([control, 'sh-select h-ds-ctl cursor-pointer pr-8'], className)}
        {...rest}
      >
        {children}
      </select>
    )
  }
)

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextArea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={controlCx([control, 'py-2 font-mono text-xs'], className)}
      {...rest}
    />
  )
})

export function Checkbox({
  label,
  description,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode
  description?: ReactNode
}): React.JSX.Element {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-2.5 text-[13px]',
        rest.disabled && 'cursor-not-allowed opacity-60',
        className
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--ds-accent)]"
        {...rest}
      />
      <span className="min-w-0">
        <span className="text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
    </label>
  )
}

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <label className={cx('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  )
}

/**
 * Phím mũi tên / Home / End trong nhóm chọn một (radiogroup, tablist): chọn mục kế và chuyển focus
 * tới nút của nó. Gắn vào onKeyDown của phần tử chứa; các nút là con trực tiếp theo thứ tự `values`.
 */
export function choiceKeyDown<T>(
  e: React.KeyboardEvent<HTMLElement>,
  values: readonly T[],
  current: T,
  onChange: (value: T) => void
): void {
  const i = values.indexOf(current)
  const last = values.length - 1
  const next =
    e.key === 'ArrowRight' || e.key === 'ArrowDown'
      ? i >= last
        ? 0
        : i + 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? i <= 0
          ? last
          : i - 1
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? last
            : null
  const value = next === null ? undefined : values[next]
  if (next === null || value === undefined) return
  e.preventDefault()
  onChange(value)
  const button = e.currentTarget.children[next]
  if (button instanceof HTMLElement) button.focus()
}

/** Nhóm nút chọn một (segmented control). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  testIdPrefix
}: {
  value: T
  /** hint: chú thích khi rê chuột (giải thích lựa chọn). */
  options: readonly { value: T; label: string; hint?: string }[]
  onChange: (value: T) => void
  testIdPrefix?: string
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      className="inline-flex gap-0.5 rounded-ds-md border border-ds-border-strong bg-subtle p-0.5"
      onKeyDown={(e) => {
        choiceKeyDown(
          e,
          options.map((o) => o.value),
          value,
          onChange
        )
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          // Roving tabindex: Tab vào nhóm dừng ở mục đang chọn, ←/→ để đổi.
          tabIndex={value === o.value || !options.some((x) => x.value === value) ? 0 : -1}
          data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
          title={o.hint}
          className={cx(
            'h-6 rounded-ds-sm px-2.5 text-xs font-medium transition-colors focus-visible:shadow-ds-focus focus-visible:outline-none',
            value === o.value ? 'bg-ds-surface-3 text-fg' : 'text-muted hover:text-fg'
          )}
          onClick={() => {
            onChange(o.value)
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------- Feedback ----------

export type ConnectionState =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'exited'

/**
 * Nhãn trạng thái kết nối — getter để dịch lúc đọc (lúc render), không phải lúc nạp module. Giữ
 * dạng `connectionLabel[state]` cho nơi dùng.
 */
export const connectionLabel: Readonly<Record<ConnectionState, string>> = {
  get idle() {
    return t('Not connected')
  },
  get connecting() {
    return t('Connecting…')
  },
  get connected() {
    return t('Connected')
  },
  get reconnecting() {
    return t('Reconnecting…')
  },
  get disconnected() {
    return t('Disconnected')
  },
  get exited() {
    return t('Session ended')
  }
}

/** Chấm trạng thái kết nối; đang kết nối thì nhấp nháy nhẹ. */
export function StatusDot({
  state,
  className
}: {
  state: ConnectionState
  className?: string
}): React.JSX.Element {
  const tone: Record<ConnectionState, string> = {
    idle: 'bg-faint',
    connecting: 'bg-warning animate-pulse',
    connected: 'bg-success',
    reconnecting: 'bg-warning animate-pulse',
    disconnected: 'bg-danger',
    exited: 'bg-faint'
  }
  return (
    <span
      aria-hidden
      className={cx('inline-block size-1.5 shrink-0 rounded-full', tone[state], className)}
    />
  )
}

export function Notice({
  tone = 'info',
  children,
  testId
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger'
  children: ReactNode
  testId?: string
}): React.JSX.Element {
  // Callout (thiết kế v0.5): nền nhạt, không viền; info không nền.
  const tones = {
    info: 'border-transparent bg-subtle text-muted',
    success: 'border-transparent bg-success-soft text-success',
    warning: 'border-transparent bg-warning-soft text-warning',
    danger: 'border-transparent bg-danger-soft text-danger'
  }
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
      className={cx(
        'sh-selectable animate-fade-in rounded-ds-lg border px-3 py-2 text-xs',
        tones[tone]
      )}
    >
      {children}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded-ds-xs border border-line bg-ds-surface-3 px-1.5 py-0.5 font-sans text-[11px] font-medium text-muted">
      {children}
    </kbd>
  )
}

export function SectionTitle({
  children,
  description
}: {
  children: ReactNode
  description?: ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-semibold text-fg">{children}</h3>
      {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
    </div>
  )
}

// ---------- Trang cài đặt (thiết kế v0.5) ----------

/**
 * Nhóm hàng cài đặt: tiêu đề nhóm xám, các hàng phẳng phân cách bằng đường mảnh — không thẻ.
 */
export function SettingGroup({
  title,
  children,
  testId
}: {
  title: string
  children: ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <section className="mb-8" data-testid={testId}>
      <h2 className="border-b border-ds-border-subtle pb-2 text-xs font-medium text-faint">
        {title}
      </h2>
      <div className="divide-y divide-ds-border-subtle">{children}</div>
    </section>
  )
}

/** Một hàng cài đặt: tiêu đề + mô tả bên trái, control bên phải (hoặc nội dung đầy đủ bên dưới). */
export function SettingRow({
  title,
  description,
  control,
  children
}: {
  title: ReactNode
  description?: ReactNode
  control?: ReactNode
  /** Nội dung rộng (danh sách, lưới) nằm dưới tiêu đề. */
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className="py-3.5">
      <div className="flex items-center gap-6">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">{title}</div>
          {description && (
            <div className="mt-0.5 text-xs text-pretty text-muted">{description}</div>
          )}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  )
}

/**
 * Công tắc bật / tắt — vẫn là checkbox gốc (bàn phím, trình đọc màn hình, `check()` của test), vẽ
 * dạng switch; viền ≥ 3:1 (--ds-border-control).
 */
export const Switch = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string }
>(function Switch({ label, className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      type="checkbox"
      role="switch"
      aria-label={label}
      className={cx(
        'relative h-4 w-7 shrink-0 cursor-pointer appearance-none rounded-full border border-ds-border-control bg-ds-surface-3 transition-colors duration-(--ds-dur-fast) outline-none',
        "before:absolute before:top-[2px] before:left-[2px] before:size-2.5 before:rounded-full before:bg-ds-fg-2 before:transition-transform before:duration-(--ds-dur-fast) before:content-['']",
        'checked:border-ds-accent checked:bg-ds-accent checked:before:translate-x-3 checked:before:bg-ds-accent-contrast',
        'focus-visible:shadow-ds-focus disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...rest}
    />
  )
})

// ---------- Modal ----------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  // tabIndex < 0: mục không được chọn trong nhóm roving tabindex (Segmented, TabStrip) — vẫn khớp
  // `button`, nhưng Tab bỏ qua; tính vào sẽ chọn sai phần tử đầu/cuối và focus thoát ra ngoài.
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && (el.offsetParent !== null || el === document.activeElement)
  )
}

/**
 * Giữ focus trong hộp thoại: Tab / Shift+Tab xoay vòng bên trong; khi mở, focus vào phần tử
 * `autoFocus` (hoặc phần tử đầu tiên); khi đóng, trả focus về chỗ cũ (ví dụ terminal).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // autoFocus của React chạy trước effect này; chỉ tự chọn khi focus còn ở ngoài.
    if (!root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus()

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = focusables(root)
      const first = items[0]
      const last = items.at(-1)
      if (!first || !last) {
        event.preventDefault()
        return
      }
      const active = document.activeElement
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    root.addEventListener('keydown', onKey)
    return () => {
      root.removeEventListener('keydown', onKey)
      // Chỉ trả focus nếu focus đang ở trong hộp thoại vừa đóng (hoặc đã rơi về body).
      const active = document.activeElement
      const lost = !active || active === document.body || root.contains(active)
      if (lost && previous?.isConnected) previous.focus()
    }
  }, [ref])
}

/** Ngăn xếp hộp thoại đang mở: Esc chỉ đóng hộp thoại trên cùng. */
const stack: symbol[] = []

export function useEscapeToClose(onClose: () => void): void {
  const latest = useRef(onClose)
  useEffect(() => {
    latest.current = onClose
  })
  // useLayoutEffect: gắn TRƯỚC lần vẽ đầu — hộp thoại hiện ra là Esc đã đóng được (useEffect chạy
  // sau khi vẽ: bấm Esc ngay khi hộp thoại vừa hiện, nhất là hộp thoại nạp lười, bị mất phím).
  useLayoutEffect(() => {
    const id = Symbol('modal')
    stack.push(id)
    const onKey = (event: KeyboardEvent): void => {
      // Không phụ thuộc focus: nút bị disable hay focus rơi ra ngoài vẫn đóng được.
      if (event.key !== 'Escape' || stack.at(-1) !== id) return
      // Phần tử đang tự bắt phím (ví dụ ô ghi phím tắt) được xử lý Esc trước.
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-capture-keys="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      stack.splice(stack.indexOf(id), 1)
    }
  }, [])
}

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  width = 'max-w-lg',
  testId,
  bodyClassName
}: {
  title: string
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: string
  testId?: string
  bodyClassName?: string
}): React.JSX.Element {
  useEscapeToClose(onClose)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  // Portal ra <body>: hộp thoại mở từ một vùng đang ẩn / inert (cây host khi đang ở khu vực khác)
  // vẫn hiện và nhận phím.
  return createPortal(
    <div
      className="bg-overlay animate-fade-in fixed inset-0 z-40 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        // Bấm ra nền không làm mất focus khỏi hộp thoại.
        if (e.target === e.currentTarget) e.preventDefault()
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className={cx(
          'animate-dialog-in flex max-h-full w-full flex-col rounded-ds-xl bg-ds-surface-0 shadow-ds-dialog outline-none',
          width
        )}
      >
        <header className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-ds-lg font-semibold tracking-[-0.018em] text-fg">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          <IconButton label={t('Close')} size="sm" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </header>
        <div className={cx('overflow-auto px-5 pb-5', bodyClassName)}>{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-ds-border-subtle px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body
  )
}
