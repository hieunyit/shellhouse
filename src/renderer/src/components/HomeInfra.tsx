import { useEffect, useState } from 'react'
import { CircleAlert, Info, RotateCw, TriangleAlert } from 'lucide-react'
import { t } from '@shared/i18n'
import { formatRelative } from '@shared/i18n/format'
import { EnvLabel, IconButton, StatusDot, type StatusTone } from '../ds'
import { cx, ICON_SM } from '../ds/utils'
import { useEnvironment } from '../stores/environments'
import { fleetItems, useFleet, type FleetItem, type FleetTone } from '../stores/fleet'
import { useSettings } from '../stores/settings'
import { useShell } from '../shell/store'
import { Section } from './HomeSection'

const STATE_TONE: Record<FleetItem['state'], StatusTone> = {
  ok: 'ok',
  warning: 'warning',
  error: 'danger',
  signin: 'warning',
  connecting: 'progress'
}

const STATE_TEXT: Record<FleetItem['state'], () => string> = {
  ok: () => t('Healthy'),
  warning: () => t('Needs attention'),
  error: () => t('Unreachable'),
  signin: () => t('Needs sign-in'),
  connecting: () => t('Connecting…')
}

const VALUE_TONE: Record<FleetTone, string> = {
  ok: 'text-fg',
  muted: 'text-muted',
  warning: 'text-ds-warning',
  danger: 'text-ds-danger'
}

/** "2 phút trước" tự cập nhật mỗi phút. */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 60_000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  return now
}

function Env({ id }: { id: string }): React.JSX.Element | null {
  const env = useEnvironment(id)
  return env ? <EnvLabel env={env} /> : null
}

function Row({ item, now }: { item: FleetItem; now: number }): React.JSX.Element {
  const notes = [
    ...(item.message
      ? [
          {
            severity: item.state === 'error' ? ('danger' as const) : ('warning' as const),
            text: item.message
          }
        ]
      : []),
    ...item.notes
  ]
  return (
    <div
      className="flex items-start gap-1 px-1 py-1"
      data-testid="home-infra-item"
      data-id={item.id}
      data-state={item.state}
    >
      <button
        type="button"
        className="group flex min-w-0 flex-1 items-start gap-3 rounded-ds-lg px-2 py-1.5 text-left outline-none hover:bg-ds-hover focus-visible:shadow-ds-focus"
        onClick={() => item.open?.()}
      >
        <span className="flex h-5 shrink-0 items-center" title={STATE_TEXT[item.state]()}>
          <StatusDot tone={STATE_TONE[item.state]} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13px] font-medium text-fg group-hover:underline">
                {item.title}
              </span>
              {item.environment && <Env id={item.environment} />}
            </span>
            <span className="truncate text-xs text-faint">
              {[item.kind, item.version].filter(Boolean).join(' · ')}
            </span>
            <span className="flex-1" />
            {item.stats.length > 0 && (
              <span
                className="flex shrink-0 items-center gap-3 text-xs"
                data-testid="home-infra-stats"
              >
                {item.stats.map((s) => (
                  <span key={s.label} title={s.title} className="whitespace-nowrap text-muted">
                    {s.label}{' '}
                    <span className={cx('font-medium tabular-nums', VALUE_TONE[s.tone ?? 'ok'])}>
                      {s.value}
                    </span>
                  </span>
                ))}
              </span>
            )}
            <span className="w-24 shrink-0 text-right text-xs text-faint tabular-nums">
              {item.state === 'connecting' && !item.checkedAt
                ? t('Connecting…')
                : item.checkedAt
                  ? formatRelative(item.checkedAt, now)
                  : STATE_TEXT[item.state]()}
            </span>
          </span>
          {notes.length > 0 && (
            <span className="mt-1 flex flex-col gap-0.5" data-testid="home-infra-notes">
              {notes.map((n, i) => (
                <span
                  key={i}
                  className={cx(
                    'flex items-start gap-1.5 text-xs leading-snug',
                    n.severity === 'danger'
                      ? 'text-ds-danger'
                      : n.severity === 'warning'
                        ? 'text-ds-warning'
                        : 'text-muted'
                  )}
                >
                  <span className="mt-px shrink-0">
                    {n.severity === 'danger' ? (
                      <CircleAlert size={13} />
                    ) : n.severity === 'warning' ? (
                      <TriangleAlert size={13} />
                    ) : (
                      <Info size={13} />
                    )}
                  </span>
                  <span className="min-w-0 break-words">{n.text}</span>
                </span>
              ))}
            </span>
          )}
        </span>
      </button>
      {item.refresh && (
        <IconButton
          label={t('Check now')}
          size="sm"
          className="mt-1"
          data-testid="home-infra-refresh"
          onClick={() => item.refresh?.()}
        >
          <RotateCw {...ICON_SM} />
        </IconButton>
      )}
    </div>
  )
}

/**
 * Home › Infrastructure: cluster Kubernetes / Docker đang theo dõi (mặc định: thuộc Production) —
 * trạng thái, phiên bản, số liệu chính, ghi chú (hết hỗ trợ, chứng chỉ sắp hết hạn). Có vấn đề lên
 * đầu; bấm hàng để mở.
 */
export function InfraList(): React.JSX.Element | null {
  const enabled = useSettings((s) => s.settings.appearance.homeMonitor)
  const map = useFleet((s) => s.items)
  const now = useMinuteTick()
  if (!enabled) return null
  const items = fleetItems(map)
  if (items.length === 0) return null
  return (
    <Section
      title={t('Infrastructure')}
      count={items.length}
      testId="home-infra"
      action={
        <button
          type="button"
          className="shrink-0 rounded-ds-sm px-1.5 py-0.5 text-[13px] font-medium text-ds-accent-text outline-none hover:bg-ds-hover focus-visible:shadow-ds-focus"
          data-testid="home-infra-manage"
          onClick={() => {
            useShell.getState().openSettings('appearance')
          }}
        >
          {t('Manage')}
        </button>
      }
    >
      <div className="flex flex-col divide-y divide-ds-border-subtle rounded-ds-lg border border-ds-border-subtle">
        {items.map((item) => (
          <Row key={item.id} item={item} now={now} />
        ))}
      </div>
    </Section>
  )
}
