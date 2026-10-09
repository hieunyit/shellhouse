import { useMemo, useState } from 'react'
import { ChevronRight, Search, X } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { formatNumber, t, tn } from '../../registry/renderer-kit'
import { STATUS_ORDER, type ConnectionRow, type ConnStatus } from '../shared/connections'
import { egressSourceText } from '../shared/appTopology'
import type { EgressResult } from '../shared/egress'
import { sourceName } from './trafficUnit'
import type { TrafficState } from './useTraffic'
import { CopyButton, kindLabel, ObservedText, StatusPill } from './ConnectionBits'
import type { MapRef } from './mapModel'

/**
 * Map › Connections: mỗi workload nối tới đâu — khai báo (env / args / ConfigMap / Secret) ghép với
 * traffic quan sát được (Caretta / Hubble) về cùng một đích. Điều đáng xem là chỗ lệch nhau: khai
 * báo mà không thấy kết nối ("Not seen"), có kết nối mà không khai báo ("Undeclared").
 */

type StatusFilter = 'all' | 'undeclared' | 'declared' | 'seen' | 'other'
type TypeFilter = 'all' | 'external' | 'private' | 'cluster'

const inStatus = (s: ConnStatus, f: StatusFilter): boolean =>
  f === 'all'
    ? true
    : f === 'seen'
      ? s === 'active' || s === 'idle'
      : f === 'other'
        ? s === 'unknown' || s === 'unmeasured'
        : s === f

const inType = (r: ConnectionRow, f: TypeFilter): boolean =>
  f === 'all'
    ? true
    : f === 'external'
      ? r.kind === 'external'
      : f === 'private'
        ? r.kind === 'private'
        : r.kind === 'service' ||
          r.kind === 'pod' ||
          r.kind === 'unresolved' ||
          r.kind === 'workload'

export function ConnectionsView({
  rows,
  result,
  traffic,
  measured,
  resolving,
  loading,
  error,
  internalDns,
  onInternalDns,
  onOpen
}: {
  rows: readonly ConnectionRow[] | null
  result: EgressResult | null
  traffic: TrafficState
  measured: boolean
  resolving: boolean
  loading: boolean
  error: string | null
  internalDns: boolean
  onInternalDns: (on: boolean) => void
  onOpen: (ref: MapRef) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [type, setType] = useState<TypeFilter>('all')
  const [system, setSystem] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())

  const visible = useMemo(() => (rows ?? []).filter((r) => system || !r.system), [rows, system])
  const hiddenSystem = (rows ?? []).length - visible.length
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: 0,
      undeclared: 0,
      declared: 0,
      seen: 0,
      other: 0
    }
    for (const r of visible) {
      c.all++
      if (r.status === 'undeclared') c.undeclared++
      else if (r.status === 'declared') c.declared++
      else if (r.status === 'active' || r.status === 'idle') c.seen++
      else c.other++
    }
    return c
  }, [visible])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return visible
      .filter(
        (r) =>
          inStatus(r.status, status) &&
          inType(r, type) &&
          (!q ||
            `${r.workload.ns} ${r.workload.name} ${r.label} ${(r.declared ?? [])
              .map((s) => `${s.via} ${s.key}`)
              .join(' ')} ${(r.observed?.peers ?? []).join(' ')}`
              .toLowerCase()
              .includes(q))
      )
      .sort(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
          a.workload.ns.localeCompare(b.workload.ns) ||
          a.workload.name.localeCompare(b.workload.name) ||
          a.label.localeCompare(b.label)
      )
  }, [visible, query, status, type])

  const filters: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: t('All') },
    { id: 'undeclared', label: t('Undeclared') },
    { id: 'declared', label: t('Not seen') },
    { id: 'seen', label: t('Seen') },
    { id: 'other', label: t("Can't tell") }
  ]
  const trafficNote =
    traffic.status === 'live'
      ? t('Observed traffic: {source}, average over the last minute.', {
          source: sourceName(traffic.source)
        })
      : traffic.status === 'connecting'
        ? t('Measuring traffic…')
        : t(
            'No traffic source in this cluster (Caretta or Hubble) — only the configuration is shown, so nothing can be marked seen or undeclared.'
          )

  const toggle = (key: string): void => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renderRow = (r: ConnectionRow, indent = false): React.JSX.Element => (
    <tr
      key={r.key}
      className={cx('border-b border-line/60 hover:bg-hover', indent && 'bg-subtle/40')}
      data-testid="k8s-conn-row"
      data-status={r.status}
      data-kind={r.kind}
      data-label={r.label}
    >
      <td className="px-3 py-1.5">
        {indent ? null : (
          <button
            type="button"
            className="max-w-56 truncate text-left hover:text-accent"
            title={`${r.workload.ns}/${r.workload.name}`}
            onClick={() => {
              onOpen({ kind: r.workload.kind, ns: r.workload.ns, name: r.workload.name })
            }}
          >
            <span className="font-medium text-fg">{r.workload.name}</span>
            <span className="ml-1.5 text-faint">{r.workload.ns}</span>
          </button>
        )}
      </td>
      <td className="px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5">
          {r.members && (
            <button
              type="button"
              aria-expanded={open.has(r.key)}
              aria-label={t('Show addresses')}
              className="-ml-1 rounded p-0.5 text-faint hover:text-fg"
              onClick={() => {
                toggle(r.key)
              }}
            >
              <ChevronRight
                size={12}
                className={cx('transition-transform', open.has(r.key) && 'rotate-90')}
              />
            </button>
          )}
          <span className="font-mono text-fg" data-testid="k8s-conn-dest">
            {r.label}
          </span>
          {r.dest?.viaService && (
            <span className="text-faint">
              {t('via {service}', {
                service: `${r.dest.viaService.ns}/${r.dest.viaService.name}`
              })}
            </span>
          )}
          {!r.members && <CopyButton value={r.label} />}
        </span>
        <div className="text-[11px] text-faint">{kindLabel(r.kind)}</div>
      </td>
      <td className="px-3 py-1.5 text-muted">
        {r.declared ? (
          <div className="flex flex-col gap-0.5">
            {r.declared.slice(0, 3).map((s) => (
              <span key={`${s.source}|${s.via}|${s.key}`} className="font-mono">
                {egressSourceText(s.source, s.via, s.key)}
              </span>
            ))}
            {r.declared.length > 3 && (
              <span className="text-faint">
                {tn(r.declared.length - 3, '+{n} more', '+{n} more')}
              </span>
            )}
          </div>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="px-3 py-1.5 text-xs">
        <ObservedText observed={r.observed} measured={measured} />
      </td>
      <td className="px-3 py-1.5">
        <StatusPill status={r.status} />
      </td>
    </tr>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="k8s-connections">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <div className="flex h-7 w-60 min-w-32 shrink items-center gap-1.5 rounded-md border border-line bg-subtle px-2 focus-within:border-accent">
          <Search size={12} className="shrink-0 text-faint" />
          <input
            type="text"
            spellCheck={false}
            placeholder={t('Filter by workload, destination or source')}
            aria-label={t('Filter connections')}
            data-testid="k8s-conn-filter"
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {query && (
            <button
              type="button"
              aria-label={t('Clear')}
              className="shrink-0 rounded text-faint hover:text-fg"
              onClick={() => {
                setQuery('')
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label={t('Status')}>
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              data-testid={`k8s-conn-filter-${f.id}`}
              aria-pressed={status === f.id}
              className={cx(
                'h-7 rounded-md px-2 text-xs',
                status === f.id
                  ? 'bg-active font-medium text-fg'
                  : 'text-muted hover:bg-hover hover:text-fg'
              )}
              onClick={() => {
                setStatus(f.id)
              }}
            >
              {f.label}
              <span className="ml-1 text-faint tabular-nums">{formatNumber(counts[f.id])}</span>
            </button>
          ))}
        </div>
        <select
          aria-label={t('Destination type')}
          data-testid="k8s-conn-type"
          className="h-7 rounded-md border border-line bg-subtle px-1.5 text-xs text-fg"
          value={type}
          onChange={(e) => {
            setType(e.target.value as TypeFilter)
          }}
        >
          <option value="all">{t('All types')}</option>
          <option value="external">{t('External')}</option>
          <option value="private">{t('Private network')}</option>
          <option value="cluster">{t('In cluster')}</option>
        </select>
        {hiddenSystem > 0 && (
          <label className="flex items-center gap-1 text-muted">
            <input
              type="checkbox"
              data-testid="k8s-conn-system"
              checked={system}
              onChange={(e) => {
                setSystem(e.target.checked)
              }}
            />
            {tn(
              hiddenSystem,
              'Show {n} system connection (DNS, kube-system)',
              'Show {n} system connections (DNS, kube-system)'
            )}
          </label>
        )}
        <span className="ml-auto text-faint">
          {tn(shown.length, '{n} connection', '{n} connections')}
        </span>
      </div>

      <div className="shrink-0 space-y-1 border-b border-line bg-subtle px-3 py-1.5 text-xs text-muted">
        <p data-testid="k8s-conn-traffic-note">{trafficNote}</p>
        {measured && (
          <p className="flex flex-wrap items-center gap-x-2">
            <span>
              {t(
                'Hostnames are looked up on this computer to match the IPs that were seen — a cluster with its own DNS can answer differently.'
              )}
              {resolving && <span className="ml-1 text-faint">{t('Looking up…')}</span>}
            </span>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                data-testid="k8s-conn-internal-dns"
                checked={internalDns}
                onChange={(e) => {
                  onInternalDns(e.target.checked)
                }}
              />
              {t('Also look up internal names (.corp, .internal…) with this computer’s DNS')}
            </label>
          </p>
        )}
        {result && (result.skipped.denied > 0 || result.skipped.secrets > 0) && (
          <p className="text-warning" data-testid="k8s-conn-skipped">
            {result.skipped.denied > 0 &&
              tn(
                result.skipped.denied,
                '{n} ConfigMap or Secret could not be read (no permission).',
                '{n} ConfigMaps or Secrets could not be read (no permission).'
              )}{' '}
            {result.skipped.secrets > 0 &&
              (result.readSecrets
                ? tn(
                    result.skipped.secrets,
                    '{n} Secret skipped (too many).',
                    '{n} Secrets skipped (too many).'
                  )
                : tn(
                    result.skipped.secrets,
                    '{n} Secret not read (reading Secrets is off).',
                    '{n} Secrets not read (reading Secrets is off).'
                  ))}
          </p>
        )}
        {(result?.listDenied ?? 0) > 0 && (
          <p className="text-warning" data-testid="k8s-conn-list-denied">
            {t(
              'Some workload kinds could not be listed (no permission) — the list may be incomplete.'
            )}
          </p>
        )}
        {result?.truncated && (
          <p className="text-warning">
            {t('Large cluster — only part of it was scanned. Pick fewer namespaces.')}
          </p>
        )}
      </div>
      {error && <p className="border-b border-line px-3 py-1.5 text-xs text-danger">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows === null ? (
          <p className="m-6 text-center text-xs text-faint" data-testid="k8s-conn-loading">
            {loading ? t('Reading workload configuration…') : ''}
          </p>
        ) : shown.length === 0 ? (
          <p className="m-6 text-center text-xs text-faint" data-testid="k8s-conn-empty">
            {visible.length === 0
              ? t('No connection targets found in the configuration of these workloads.')
              : t('Nothing matches this filter.')}
          </p>
        ) : (
          <table className="w-full min-w-[820px] border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface text-faint">
              <tr className="border-b border-line">
                <th className="px-3 py-1.5 font-medium">{t('Workload')}</th>
                <th className="px-3 py-1.5 font-medium">{t('Destination')}</th>
                <th className="px-3 py-1.5 font-medium">{t('Declared in')}</th>
                <th className="px-3 py-1.5 font-medium">{t('Observed')}</th>
                <th className="px-3 py-1.5 font-medium">{t('Status')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.flatMap((r) => [
                renderRow(r),
                ...(r.members && open.has(r.key) ? r.members.map((m) => renderRow(m, true)) : [])
              ])}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
