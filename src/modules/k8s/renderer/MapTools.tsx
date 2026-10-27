import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { t, formatDateTime } from '../../registry/renderer-kit'
import { cleanError } from '../../../renderer/src/lib/format'
import type { MapData } from '../shared/map'
import { diagnoseMap, type DiagnosticStep, type DiagnosticTarget } from '../shared/mapDiagnostics'
import {
  captureTopology,
  compareTopology,
  MAX_SNAPSHOTS,
  readSnapshots,
  writeSnapshots,
  type TopologySnapshot
} from '../shared/topologySnapshots'
import type { MapRef, Request } from './mapModel'

const control = 'rounded border border-line bg-subtle px-2 py-1 text-xs text-fg disabled:opacity-50'
const tone = { ok: 'text-success', warn: 'text-warning', bad: 'text-danger', unknown: 'text-muted' }

/** Mounted with a cluster/scope key: stale requests and selections cannot cross contexts. */
export function MapTools({
  mode,
  cluster,
  namespaces,
  request,
  data,
  onOpen,
  onClose
}: {
  mode: 'diagnose' | 'snapshots'
  cluster: string
  namespaces: readonly string[]
  request: Request
  data: MapData | null
  onOpen: (ref: MapRef) => void
  onClose: () => void
}): React.JSX.Element {
  const [stored] = useState(() => {
    try {
      return {
        items: readSnapshots(window.localStorage),
        error: null as string | null,
        ready: true
      }
    } catch (e) {
      return { items: [] as TopologySnapshot[], error: cleanError(e), ready: false }
    }
  })
  const [target, setTarget] = useState('url')
  const [url, setUrl] = useState('')
  const [steps, setSteps] = useState<DiagnosticStep[] | null>(null)
  const [label, setLabel] = useState('')
  const [snapshots, setSnapshots] = useState<TopologySnapshot[]>(stored.items)
  const [baseline, setBaseline] = useState('')
  const [current, setCurrent] = useState<TopologySnapshot | null>(null)
  const [error, setError] = useState<string | null>(stored.error)
  const storageReady = stored.ready
  const [busy, setBusy] = useState(false)
  const [readAt, setReadAt] = useState(0)
  const alive = useRef(true)
  const running = useRef(false)
  const latestRequest = useRef(request)
  useEffect(() => {
    latestRequest.current = request
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [request])
  const scope = [...namespaces].sort().join(',')
  const local = snapshots.filter((s) => s.cluster === cluster && s.scope.join(',') === scope)
  const base = local.find((s) => s.id === baseline)
  const changes = base && current ? compareTopology(base, current) : null
  const targets: { key: string; value: DiagnosticTarget; label: string }[] = [
    ...(data?.services ?? []).map((s) => ({
      key: `service:${s.ns}/${s.name}`,
      value: { kind: 'service' as const, ns: s.ns, name: s.name },
      label: `Service · ${s.ns}/${s.name}`
    })),
    ...(data?.routes ?? [])
      .filter((r) => r.kind === 'ingresses.networking.k8s.io')
      .map((r) => ({
        key: `ingress:${r.ns}/${r.name}`,
        value: { kind: 'ingress' as const, ns: r.ns, name: r.name },
        label: `Ingress · ${r.ns}/${r.name}`
      }))
  ].sort((a, b) => a.label.localeCompare(b.label))
  const persist = (next: TopologySnapshot[]): void => {
    writeSnapshots(window.localStorage, next)
    setSnapshots(next)
  }
  const run = (save: boolean): void => {
    if (running.current) return
    const chosen: DiagnosticTarget | undefined =
      target === 'url' ? { kind: 'url', url } : targets.find((v) => v.key === target)?.value
    if (mode === 'diagnose' && !chosen) {
      setError(t('Select a target to diagnose.'))
      return
    }
    if (mode === 'snapshots' && save && !storageReady) return
    running.current = true
    setBusy(true)
    setError(null)
    setCurrent(null)
    setSteps(null)
    request<MapData>({ op: 'map', namespaces: [...namespaces] })
      .then((fresh) => {
        if (!alive.current || latestRequest.current !== request) return
        const at = Date.now()
        setReadAt(at)
        if (mode === 'diagnose' && chosen) setSteps(diagnoseMap(fresh, chosen, at))
        else {
          const snapshot = captureTopology(fresh, cluster, label || formatDateTime(at), at)
          if (save) {
            // Re-read before mutating: another tab may have created a snapshot.
            const all = readSnapshots(window.localStorage)
            const own = all
              .filter((s) => s.cluster === cluster)
              .sort((a, b) => b.at - a.at)
              .slice(0, MAX_SNAPSHOTS - 1)
            persist([...all.filter((s) => s.cluster !== cluster), ...own, snapshot])
            setBaseline(snapshot.id)
            setLabel('')
          } else setCurrent(snapshot)
        }
      })
      .catch((e: unknown) => {
        if (alive.current) setError(cleanError(e))
      })
      .finally(() => {
        if (latestRequest.current === request) {
          running.current = false
          if (alive.current) setBusy(false)
        }
      })
  }
  return (
    <section
      className="flex max-h-[65%] min-h-0 shrink-0 flex-col overflow-hidden border-b border-line bg-surface text-xs"
      aria-label={mode === 'diagnose' ? t('Diagnose request path') : t('Topology snapshots')}
      data-testid="k8s-map-tools"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <strong className="text-fg">
          {mode === 'diagnose' ? t('Diagnose request path') : t('Topology snapshots')}
        </strong>
        <span className="text-faint">
          {namespaces.length ? namespaces.join(', ') : t('All namespaces')}
        </span>
        <button
          type="button"
          className="ml-auto rounded p-1 text-muted hover:bg-hover"
          aria-label={t('Close')}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <div className="overflow-auto px-3 py-2">
        {mode === 'diagnose' ? (
          <>
            <p className="mb-2 text-muted">
              {t(
                'Checks reported configuration and readiness; it does not send application requests.'
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <select
                aria-label={t('Diagnostic target')}
                className={control}
                value={target}
                disabled={busy}
                onChange={(e) => {
                  setTarget(e.target.value)
                  setSteps(null)
                }}
              >
                <option value="url">URL</option>
                {targets.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label}
                  </option>
                ))}
              </select>
              {target === 'url' && (
                <input
                  className={`${control} min-w-40 flex-1`}
                  aria-label="URL"
                  placeholder="https://app.example.com/api"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value)
                    setSteps(null)
                  }}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') run(false)
                  }}
                />
              )}
              <button
                type="button"
                className={control}
                disabled={busy || (target === 'url' && !url.trim())}
                onClick={() => {
                  run(false)
                }}
              >
                {busy ? t('Reading…') : t('Run diagnosis')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-2 text-muted">
              {t(
                'Save a baseline before deployment, then compare with a fresh read. Stored locally on this device; Secret values are excluded. Up to 8 snapshots per cluster.'
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                aria-label={t('Snapshot name')}
                className={`${control} min-w-32 flex-1`}
                placeholder={t('Before deployment')}
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value)
                }}
                maxLength={120}
                disabled={busy}
              />
              <button
                type="button"
                className={control}
                disabled={busy || !storageReady}
                onClick={() => {
                  run(true)
                }}
              >
                {t('Save baseline')}
              </button>
              <select
                aria-label={t('Baseline')}
                className={`${control} max-w-64`}
                value={baseline}
                disabled={busy}
                onChange={(e) => {
                  setBaseline(e.target.value)
                  setCurrent(null)
                }}
              >
                <option value="">{t('Select baseline')}</option>
                {local
                  .toSorted((a, b) => b.at - a.at)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} · {formatDateTime(s.at)}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className={control}
                disabled={busy || !base}
                onClick={() => {
                  run(false)
                }}
              >
                {busy ? t('Reading…') : t('Compare with current')}
              </button>
              <button
                type="button"
                className={control}
                disabled={busy || !base || !storageReady}
                onClick={() => {
                  try {
                    persist(
                      readSnapshots(window.localStorage).filter(
                        (s) => !(s.cluster === cluster && s.id === baseline)
                      )
                    )
                    setBaseline('')
                    setCurrent(null)
                    setError(null)
                  } catch (e) {
                    setError(cleanError(e))
                  }
                }}
              >
                {t('Delete baseline')}
              </button>
            </div>
            {base && (
              <p className="mt-2 text-faint">
                {t('Baseline read at {time}', { time: formatDateTime(base.at) })}
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="mt-2 text-danger">
            {error}
          </p>
        )}
        {readAt > 0 && (
          <p className="mt-2 text-faint">{t('Read at {time}', { time: formatDateTime(readAt) })}</p>
        )}
        {steps && (
          <ol className="mt-2 space-y-2" data-testid="k8s-map-diagnosis">
            {steps.map((s, i) => (
              <li key={i} className="rounded border border-line p-2">
                <strong className={tone[s.status]}>
                  {s.title} ·{' '}
                  {t(
                    { ok: 'Confirmed', bad: 'Problem', warn: 'Warning', unknown: 'Unknown' }[
                      s.status
                    ]
                  )}
                </strong>
                <p className="mt-1 whitespace-pre-wrap break-words text-muted">{s.detail}</p>
                <div className="mt-1 flex flex-wrap gap-x-3">
                  {s.refs.map((ref) => (
                    <button
                      key={`${ref.kind}/${ref.ns}/${ref.name}`}
                      type="button"
                      className="text-accent hover:underline"
                      onClick={() => {
                        onOpen(ref)
                      }}
                    >
                      {ref.name}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
        {changes && (
          <div className="mt-2 space-y-2" data-testid="k8s-map-comparison">
            {[...(base?.coverage ?? []), ...(current?.coverage ?? [])].some(
              (c) => c.reason !== 'missing-api'
            ) || changes.some((c) => c.type === 'unknown') ? (
              <p className="text-warning">
                {t(
                  'Some resource lists are incomplete. Unknown changes cannot be treated as additions or deletions.'
                )}
              </p>
            ) : null}
            <p className="text-muted">
              {changes.length
                ? t('{n} resource changes', { n: changes.length })
                : t('No configuration changes in the captured fields.')}
            </p>
            {changes.map((c) => (
              <div
                key={`${c.resource.kind}/${c.resource.ns}/${c.resource.name}`}
                className="rounded border border-line p-2"
              >
                <span className={c.type === 'unknown' ? 'text-warning' : 'text-fg'}>
                  {t(
                    { added: 'Added', removed: 'Removed', changed: 'Changed', unknown: 'Unknown' }[
                      c.type
                    ]
                  )}{' '}
                  · {c.resource.kind} ·{' '}
                </span>
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => {
                    onOpen({ kind: c.resource.kind, ns: c.resource.ns, name: c.resource.name })
                  }}
                >
                  {c.resource.ns}/{c.resource.name}
                </button>
                {c.fields.map((f) => (
                  <div key={f.field} className="mt-1 text-muted">
                    <strong>{f.field}</strong>
                    <div className="grid grid-cols-2 gap-2 text-faint">
                      <span>{t('Baseline')}</span>
                      <span>{t('Current')}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <pre className="whitespace-pre-wrap break-all text-faint">
                        {f.before ?? t('Unknown')}
                      </pre>
                      <pre className="whitespace-pre-wrap break-all">{f.after ?? t('Unknown')}</pre>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
