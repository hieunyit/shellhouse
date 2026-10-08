import { useMemo, useState } from 'react'
import { Copy, Search, X } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { Pill } from '../../../renderer/src/components/panels'
import { destLabel, type EgressKind, type EgressResult, type EgressRow } from '../shared/egress'
import { egressSourceText } from '../shared/appTopology'
import { formatNumber, t, tn } from '../../registry/renderer-kit'
import type { MapRef } from './mapModel'

/**
 * Bảng "Outbound": mỗi dòng = một workload được cấu hình để gọi tới một địa chỉ (host / IP + cổng),
 * kèm nơi khai báo (env, args, ConfigMap, Secret). Đọc từ cấu hình — không cần traffic.
 */

type Filter = 'all' | 'external' | 'cluster' | 'private'

const KIND_TITLE = (kind: EgressKind): string => {
  switch (kind) {
    case 'service':
      return t('Service')
    case 'private':
      return t('Private network')
    case 'pod':
      return t('Pod')
    case 'unresolved':
      return t('Unresolved name')
    default:
      return t('External')
  }
}

const KIND_TONE: Record<EgressKind, 'ok' | 'warn' | 'bad' | 'muted'> = {
  external: 'warn',
  private: 'muted',
  service: 'ok',
  pod: 'ok',
  unresolved: 'muted'
}

const inFilter = (kind: EgressKind, f: Filter): boolean =>
  f === 'all'
    ? true
    : f === 'external'
      ? kind === 'external'
      : f === 'private'
        ? kind === 'private'
        : kind === 'service' || kind === 'pod' || kind === 'unresolved'

export function OutboundView({
  rows,
  result,
  loading,
  error,
  onOpen
}: {
  rows: readonly EgressRow[] | null
  result: EgressResult | null
  loading: boolean
  error: string | null
  onOpen: (ref: MapRef) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, external: 0, cluster: 0, private: 0 }
    for (const r of rows ?? []) {
      c.all++
      if (r.dest.kind === 'external') c.external++
      else if (r.dest.kind === 'private') c.private++
      else c.cluster++
    }
    return c
  }, [rows])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows ?? []).filter(
      (r) =>
        inFilter(r.dest.kind, filter) &&
        (!q ||
          `${r.workload.ns} ${r.workload.name} ${destLabel(r.dest)} ${r.dest.service?.name ?? ''} ${r.sources
            .map((s) => `${s.via} ${s.key}`)
            .join(' ')}`
            .toLowerCase()
            .includes(q))
    )
  }, [rows, query, filter])

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: t('All') },
    { id: 'external', label: t('External') },
    { id: 'private', label: t('Private network') },
    { id: 'cluster', label: t('In cluster') }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="k8s-outbound">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <div className="flex h-7 w-64 min-w-32 shrink items-center gap-1.5 rounded-md border border-line bg-subtle px-2 focus-within:border-accent">
          <Search size={12} className="shrink-0 text-faint" />
          <input
            type="text"
            spellCheck={false}
            placeholder={t('Filter by workload, host, port or source')}
            aria-label={t('Filter outbound connections')}
            data-testid="k8s-outbound-filter"
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
        <div className="flex items-center gap-1" role="group" aria-label={t('Destination type')}>
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              data-testid={`k8s-outbound-filter-${f.id}`}
              aria-pressed={filter === f.id}
              className={cx(
                'h-7 rounded-md px-2 text-xs',
                filter === f.id
                  ? 'bg-active font-medium text-fg'
                  : 'text-muted hover:bg-hover hover:text-fg'
              )}
              onClick={() => {
                setFilter(f.id)
              }}
            >
              {f.label}
              <span className="ml-1 text-faint tabular-nums">{formatNumber(counts[f.id])}</span>
            </button>
          ))}
        </div>
        <span className="ml-auto text-faint">
          {tn(shown.length, '{n} connection', '{n} connections')}
        </span>
      </div>

      <p className="shrink-0 border-b border-line bg-subtle px-3 py-1.5 text-xs text-muted">
        {t(
          'Read from configuration: environment variables, arguments, and the ConfigMaps and Secrets the pods reference. These are where workloads are set up to connect — not observed traffic, and not every connection is listed here.'
        )}
        {result && (result.skipped.denied > 0 || result.skipped.secrets > 0) && (
          <span className="ml-1 text-warning" data-testid="k8s-outbound-skipped">
            {result.skipped.denied > 0
              ? tn(
                  result.skipped.denied,
                  '{n} ConfigMap or Secret could not be read (no permission).',
                  '{n} ConfigMaps or Secrets could not be read (no permission).'
                )
              : ''}{' '}
            {result.skipped.secrets > 0
              ? result.readSecrets
                ? tn(
                    result.skipped.secrets,
                    '{n} Secret skipped (too many).',
                    '{n} Secrets skipped (too many).'
                  )
                : tn(
                    result.skipped.secrets,
                    '{n} Secret not read (reading Secrets is off).',
                    '{n} Secrets not read (reading Secrets is off).'
                  )
              : ''}
          </span>
        )}
        {(result?.listDenied ?? 0) > 0 && (
          <span className="ml-1 text-warning" data-testid="k8s-outbound-list-denied">
            {t(
              'Some workload kinds could not be listed (no permission) — the list may be incomplete.'
            )}
          </span>
        )}
        {result?.truncated && (
          <span className="ml-1 text-warning">
            {t('Large cluster — only part of it was scanned. Pick fewer namespaces.')}
          </span>
        )}
      </p>
      {error && <p className="border-b border-line px-3 py-1.5 text-xs text-danger">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows === null ? (
          <p className="m-6 text-center text-xs text-faint" data-testid="k8s-outbound-loading">
            {loading ? t('Reading workload configuration…') : ''}
          </p>
        ) : shown.length === 0 ? (
          <p className="m-6 text-center text-xs text-faint" data-testid="k8s-outbound-empty">
            {rows.length === 0
              ? t('No connection targets found in the configuration of these workloads.')
              : t('Nothing matches this filter.')}
          </p>
        ) : (
          <table className="w-full min-w-[720px] border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface text-faint">
              <tr className="border-b border-line">
                <th className="px-3 py-1.5 font-medium">{t('Workload')}</th>
                <th className="px-3 py-1.5 font-medium">{t('Destination')}</th>
                <th className="px-3 py-1.5 font-medium">{t('Type')}</th>
                <th className="px-3 py-1.5 font-medium">{t('Declared in')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr
                  key={r.key}
                  className="border-b border-line/60 hover:bg-hover"
                  data-testid="k8s-outbound-row"
                  data-kind={r.dest.kind}
                  data-host={r.dest.host}
                >
                  <td className="px-3 py-1.5">
                    <button
                      type="button"
                      className="max-w-64 truncate text-left hover:text-accent"
                      title={`${r.workload.ns}/${r.workload.name}`}
                      onClick={() => {
                        onOpen({ kind: r.workload.kind, ns: r.workload.ns, name: r.workload.name })
                      }}
                    >
                      <span className="font-medium text-fg">{r.workload.name}</span>
                      <span className="ml-1.5 text-faint">{r.workload.ns}</span>
                    </button>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-mono text-fg" data-testid="k8s-outbound-dest">
                        {r.dest.service
                          ? `${r.dest.service.ns}/${r.dest.service.name}${r.dest.port !== undefined ? `:${String(r.dest.port)}` : ''}`
                          : destLabel(r.dest)}
                      </span>
                      {r.dest.portImplied && (
                        <span className="text-faint" title={t('Default port of the scheme')}>
                          ({r.dest.scheme})
                        </span>
                      )}
                      {r.dest.viaService && (
                        <span
                          className="text-faint"
                          title={t('Reached through an ExternalName Service')}
                        >
                          {t('via {service}', {
                            service: `${r.dest.viaService.ns}/${r.dest.viaService.name}`
                          })}
                        </span>
                      )}
                      <button
                        type="button"
                        aria-label={t('Copy {value}', { value: destLabel(r.dest) })}
                        title={t('Copy host:port')}
                        className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
                        onClick={() => {
                          void navigator.clipboard.writeText(destLabel(r.dest))
                        }}
                      >
                        <Copy size={11} />
                      </button>
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <Pill tone={KIND_TONE[r.dest.kind]} dot={false}>
                      {KIND_TITLE(r.dest.kind)}
                    </Pill>
                  </td>
                  <td className="px-3 py-1.5 text-muted">
                    <div className="flex flex-col gap-0.5">
                      {r.sources.slice(0, 3).map((s) => (
                        <span
                          key={`${s.source}|${s.via}|${s.key}`}
                          className="font-mono"
                          data-testid="k8s-outbound-source"
                        >
                          {egressSourceText(s.source, s.via, s.key)}
                        </span>
                      ))}
                      {r.sources.length > 3 && (
                        <span className="text-faint">
                          {tn(r.sources.length - 3, '+{n} more', '+{n} more')}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
