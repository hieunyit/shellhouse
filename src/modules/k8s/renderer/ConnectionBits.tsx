import { Copy } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { t } from '../../registry/renderer-kit'
import {
  connStatusLabel,
  type ConnKind,
  type ConnObserved,
  type ConnStatus
} from '../shared/connections'
import { rateText } from './trafficUnit'

/** Chữ + giải thích + màu của từng trạng thái Connections. */
export function statusInfo(s: ConnStatus): { label: string; hint: string; className: string } {
  switch (s) {
    case 'active':
      return {
        label: connStatusLabel('active'),
        hint: t('Declared in the configuration, and traffic is flowing to it now'),
        className: 'bg-success-soft text-success'
      }
    case 'idle':
      return {
        label: connStatusLabel('idle'),
        hint: t('Declared, and a connection was seen, but it is quiet right now'),
        className: 'bg-subtle text-muted'
      }
    case 'declared':
      return {
        label: connStatusLabel('declared'),
        hint: t(
          'Declared in the configuration but no connection to it was seen — a dead setting, a backup path, or not used yet'
        ),
        className: 'bg-warning-soft text-warning'
      }
    case 'unknown':
      return {
        label: connStatusLabel('unknown'),
        hint: t(
          'Declared by a name that could not be matched to the IPs that were seen (an internal name that is not looked up, or the lookup failed)'
        ),
        className: 'bg-subtle text-muted'
      }
    case 'unmeasured':
      return {
        label: connStatusLabel('unmeasured'),
        hint: t(
          'This cluster has no traffic source (Caretta or Hubble), so only the configuration is known'
        ),
        className: 'bg-subtle text-muted'
      }
    case 'undeclared':
      return {
        label: connStatusLabel('undeclared'),
        hint: t(
          'Traffic was seen to a destination that is not declared in any env, ConfigMap or Secret — hardcoded, discovered at runtime, or unexpected'
        ),
        className: 'bg-danger-soft text-danger'
      }
  }
}

export function StatusPill({ status }: { status: ConnStatus }): React.JSX.Element {
  const i = statusInfo(status)
  return (
    <span
      className={cx(
        'inline-flex shrink-0 rounded px-1.5 py-px text-[11px] font-medium',
        i.className
      )}
      title={i.hint}
      data-testid="k8s-conn-status"
      data-status={status}
    >
      {i.label}
    </span>
  )
}

export function kindLabel(kind: ConnKind): string {
  switch (kind) {
    case 'service':
      return t('Service')
    case 'private':
      return t('Private network')
    case 'pod':
      return t('Pod')
    case 'unresolved':
      return t('Unresolved name')
    case 'workload':
      return t('Workload')
    default:
      return t('External')
  }
}

/** "2.1 KB/s · :443 · 104.26.12.64" hoặc "—". */
export function ObservedText({
  observed,
  measured
}: {
  observed: ConnObserved | null
  measured: boolean
}): React.JSX.Element {
  if (!observed)
    return (
      <span className="text-faint" title={measured ? t('No connection seen') : t('Not measured')}>
        —
      </span>
    )
  const peers = observed.peers.slice(0, 2).join(', ') + (observed.peers.length > 2 ? '…' : '')
  return (
    <span className="flex flex-col" data-testid="k8s-conn-observed">
      <span className="text-fg tabular-nums">
        {rateText(observed.unit ?? 'bytes')(observed.rate)}
      </span>
      <span className="font-mono text-[11px] text-faint" title={observed.peers.join(', ')}>
        {observed.ports.length ? `:${observed.ports.join(', :')}` : ''} {peers}
      </span>
    </span>
  )
}

export function CopyButton({ value }: { value: string }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={t('Copy {value}', { value })}
      title={t('Copy host:port')}
      className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
      onClick={() => {
        void navigator.clipboard.writeText(value)
      }}
    >
      <Copy size={11} />
    </button>
  )
}
