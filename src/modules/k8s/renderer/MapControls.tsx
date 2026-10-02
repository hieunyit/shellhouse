/** Nút, chip, chú giải và nhãn zoom nhỏ trên thanh công cụ / góc bản đồ. */
import { useStore } from '@xyflow/react'
import { cx } from '../../../renderer/src/components/ui'
import { type TrafficState } from './useTraffic'

export function ZoomLabel(): React.JSX.Element {
  const pct = useStore((s) => Math.round(s.transform[2] * 100))
  return (
    <span
      className="flex w-12 items-center justify-center border-x border-line text-[11px] text-faint tabular-nums"
      data-testid="k8s-map-zoom"
    >
      {pct}%
    </span>
  )
}

export function TrafficDot({ status }: { status: TrafficState['status'] }): React.JSX.Element {
  return (
    <span
      className={cx(
        'size-1.5 rounded-full',
        status === 'live'
          ? 'bg-success'
          : status === 'connecting'
            ? 'animate-pulse bg-warning'
            : 'bg-line-strong'
      )}
      data-testid="k8s-map-traffic-status"
      data-status={status}
    />
  )
}

export function Chip({
  on,
  onClick,
  testId,
  title,
  children
}: {
  on: boolean
  onClick: () => void
  testId?: string
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      data-testid={testId}
      className={cx(
        'h-7 rounded-md border px-2 font-medium whitespace-nowrap',
        on ? 'border-accent/40 bg-accent-soft text-fg' : 'border-line text-muted hover:text-fg'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function MapButton({
  label,
  testId,
  onClick,
  children
}: {
  label: string
  testId?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      className="flex size-7 items-center justify-center text-muted hover:bg-hover hover:text-fg"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function Legend({ color, label }: { color: string; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <span className={cx('size-2 rounded-full', color)} />
      {label}
    </span>
  )
}
