import type { ReactNode } from 'react'
import { AlertCircle, AlertTriangle } from 'lucide-react'
import { t } from '@shared/i18n'
import { cx } from './utils'

/**
 * Trạng thái theo màu ngữ nghĩa (prototype v0.3 — màu của v0.1):
 * - ok = xanh lá (Running / Healthy / Ready), progress = xanh dương (ContainerCreating, Pulling…),
 *   warning = vàng (Pending / Updating / Degraded), danger = đỏ (CrashLoop / Error / Unhealthy),
 *   off = xám, vòng rỗng (Completed / Exited / Unknown).
 * - Trong bảng: StatusText (chấm + chữ cùng màu). Ở header Inspector / danh sách "cần chú ý":
 *   StatusChip (nền nhạt + chữ màu). Mỗi hàng chỉ MỘT chỉ báo trạng thái.
 * Không bao giờ chỉ dựa vào màu: luôn có chữ; chấm "off" là vòng rỗng, danger có quầng.
 */
export type StatusTone = 'ok' | 'progress' | 'off' | 'warning' | 'danger'

const dotClass: Record<StatusTone, string> = {
  ok: 'bg-ds-success',
  progress: 'bg-ds-info',
  off: 'border border-ds-status-off bg-transparent',
  warning: 'bg-ds-warning',
  danger: 'bg-ds-danger ring-2 ring-ds-danger-soft'
}

const textClass: Record<StatusTone, string> = {
  ok: 'text-ds-success',
  progress: 'text-ds-info',
  off: 'text-ds-fg-2',
  warning: 'text-ds-warning',
  danger: 'text-ds-danger'
}

/** Chip: một hình dạng cho mọi tông (cao 20px, bo 4px, nền -soft + chữ màu, không viền). */
const chipClass: Record<StatusTone | 'neutral', string> = {
  ok: 'bg-ds-success-soft text-ds-success',
  progress: 'bg-ds-info-soft text-ds-info',
  off: 'bg-ds-active text-ds-fg-2',
  neutral: 'bg-ds-active text-ds-fg-2',
  warning: 'bg-ds-warning-soft text-ds-warning',
  danger: 'bg-ds-danger-soft text-ds-danger'
}

const CHIP =
  'inline-flex h-5 shrink-0 items-center gap-1 rounded-ds-sm px-1.5 text-ds-xs font-medium whitespace-nowrap'

export function StatusDot({
  tone,
  label,
  className
}: {
  tone: StatusTone
  /** Có label = chấm đứng một mình (cây host…) → đọc được bằng trình đọc màn hình. */
  label?: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
      className={cx('inline-block size-1.5 shrink-0 rounded-full', dotClass[tone], className)}
    />
  )
}

/** Chấm + chữ cùng màu ngữ nghĩa (off: chữ phụ xám). Dùng trong bảng / danh sách. */
export function StatusText({
  tone,
  children,
  className
}: {
  tone: StatusTone
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cx(
        'inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap',
        textClass[tone],
        className
      )}
    >
      <StatusDot tone={tone} />
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * Chip trạng thái (nền nhạt + chữ màu) — header Inspector, danh sách "cần chú ý". Trong bảng dùng
 * StatusText để mỗi hàng chỉ có một chỉ báo.
 */
export function StatusChip({
  tone,
  children,
  icon,
  className
}: {
  tone: StatusTone
  children: ReactNode
  icon?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span className={cx(CHIP, chipClass[tone], className)}>
      {icon}
      {children}
    </span>
  )
}

/**
 * Chip vấn đề — StatusChip warning / danger kèm icon. Viết bằng chữ ("CrashLoop", "No
 * endpoints"), không dùng icon trơn.
 */
export function ProblemChip({
  tone = 'danger',
  children,
  icon = true,
  className
}: {
  tone?: 'warning' | 'danger'
  children: ReactNode
  icon?: boolean
  className?: string
}): React.JSX.Element {
  const Icon = tone === 'danger' ? AlertCircle : AlertTriangle
  return (
    <StatusChip
      tone={tone}
      icon={icon ? <Icon size={12} strokeWidth={1.5} aria-hidden /> : undefined}
      className={className}
    >
      {children}
    </StatusChip>
  )
}

export type BadgeTone = 'neutral' | 'success' | 'info' | 'warning' | 'danger'

const badgeTone: Record<BadgeTone, string> = {
  neutral: chipClass.neutral,
  success: chipClass.ok,
  info: chipClass.progress,
  warning: chipClass.warning,
  danger: chipClass.danger
}

/** Nhãn / số đếm. Màu theo nghĩa: danger = lỗi, warning = cảnh báo, còn lại xám trung tính. */
export function Badge({
  children,
  tone = 'neutral',
  variant = 'soft',
  size = 'md',
  icon,
  className
}: {
  children: ReactNode
  tone?: BadgeTone
  variant?: 'soft' | 'outline'
  size?: 'sm' | 'md'
  icon?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-ds-sm font-medium tracking-normal whitespace-nowrap tabular-nums',
        size === 'sm' ? 'h-4 min-w-4 justify-center px-1 text-ds-xs' : 'h-5 px-1.5 text-ds-xs',
        variant === 'outline' ? 'border border-ds-border text-ds-fg-2' : badgeTone[tone],
        className
      )}
    >
      {icon}
      {children}
    </span>
  )
}

export type Environment = 'prod' | 'staging' | 'dev' | 'test'

/** Môi trường tuỳ biến (Settings › Environments) — chỉ phần cần để vẽ nhãn. */
export interface EnvLike {
  name: string
  short: string
  /** Highlighted: màu riêng (magenta); còn lại trung tính. */
  highlight: boolean
}

function toEnv(env: Environment | EnvLike): EnvLike {
  return typeof env === 'string'
    ? { name: envName(env), short: envShort(env), highlight: env === 'prod' }
    : env
}

/**
 * Nhãn môi trường (đặt theo nhóm — hàng nhóm, header breadcrumb). v0.4: môi trường là Ô VUÔNG
 * (trạng thái là chấm tròn) để không đọc nhầm; chỉ môi trường Highlighted (Production) có màu riêng
 * — magenta, không trùng danger; còn lại trung tính. Trong danh sách host dùng `dot` (ô vuông 6px —
 * host không lặp nhãn của nhóm).
 */
export function EnvLabel({
  env: input,
  dot,
  size = 'sm',
  className
}: {
  env: Environment | EnvLike
  dot?: boolean
  /** md = nhãn ở header (cao 20px). */
  size?: 'sm' | 'md'
  className?: string
}): React.JSX.Element {
  const env = toEnv(input)
  const prod = env.highlight
  if (dot)
    return (
      <span
        role="img"
        aria-label={env.name}
        title={env.name}
        className={cx(
          'inline-block size-1.5 shrink-0 rounded-[1px]',
          prod ? 'bg-ds-env-prod' : 'bg-ds-fg-3',
          className
        )}
      />
    )
  return (
    <span
      role="img"
      aria-label={env.name}
      title={env.name}
      className={cx(
        'inline-flex shrink-0 items-center gap-[5px] rounded-ds-xs px-1.5 text-ds-xs leading-none font-medium tracking-[0.03em] whitespace-nowrap',
        size === 'md' ? 'h-5' : 'h-4.5',
        prod
          ? 'bg-ds-env-prod-soft text-ds-env-prod shadow-[inset_0_0_0_1px_var(--ds-env-prod-border)]'
          : 'text-ds-env-other shadow-[inset_0_0_0_1px_var(--ds-border-strong)]',
        className
      )}
    >
      <span
        aria-hidden
        className={cx('size-1.5 shrink-0 rounded-[1px]', prod ? 'bg-ds-env-prod' : 'bg-ds-fg-3')}
      />
      {env.short}
    </span>
  )
}

function envShort(env: Environment): string {
  return { prod: 'Prod', staging: 'Stg', dev: 'Dev', test: 'Test' }[env]
}

export function envName(env: Environment): string {
  switch (env) {
    case 'prod':
      return t('Production')
    case 'staging':
      return t('Staging')
    case 'dev':
      return t('Development')
    case 'test':
      return t('Test')
  }
}

/**
 * Vạch 2px ở đỉnh vùng nội dung khi môi trường đang làm việc bật "Top line": magenta với môi trường
 * Highlighted (Production), xám với môi trường trung tính.
 */
export function ProdLine({
  className,
  highlight = true
}: {
  className?: string
  highlight?: boolean
}): React.JSX.Element {
  return (
    <div
      aria-hidden
      data-testid="env-line"
      className={cx(
        'pointer-events-none h-0.5 w-full shrink-0',
        highlight ? 'bg-ds-env-prod' : 'bg-ds-fg-3',
        className
      )}
    />
  )
}

/**
 * Meter (CPU / RAM…): chuỗi 1 xanh dương (series 2 = tím); vượt ngưỡng → warning ≥ 75%, danger
 * ≥ 90%.
 */
export function Meter({
  value,
  label,
  valueText,
  series = 1,
  className
}: {
  /** 0–1. */
  value: number
  label: string
  valueText?: string
  series?: 1 | 2
  className?: string
}): React.JSX.Element {
  const v = Math.max(0, Math.min(1, value))
  const tone =
    v >= 0.9
      ? 'bg-ds-danger'
      : v >= 0.75
        ? 'bg-ds-warning'
        : series === 2
          ? 'bg-ds-chart-2'
          : 'bg-ds-chart'
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-2', className)}>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        aria-valuetext={valueText}
        className="relative h-1 w-9 shrink-0 overflow-hidden rounded-full bg-ds-chart-track"
      >
        <span
          className={cx('absolute inset-y-0 left-0 rounded-full', tone)}
          style={{ width: `${String(v * 100)}%` }}
        />
      </span>
      {valueText && <span className="text-ds-sm text-ds-fg-2 tabular-nums">{valueText}</span>}
    </span>
  )
}
