import { useEffect, useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { t, tn } from '../../registry/renderer-kit'
import { destLabel, egressRows, type EgressKind, type EgressResult } from '../shared/egress'
import { egressSourceText } from '../shared/appTopology'
import type { MapService } from '../shared/map'
import type { K8sObject } from '../shared/resources'
import { loadOptions, type Request } from './mapModel'

/**
 * Tab "Outbound" trong chi tiết workload: nơi workload này được cấu hình để kết nối tới (host:port
 * trong env, args, ConfigMap, Secret mà pod template dùng) — cùng dữ liệu với Map › Outbound nhưng
 * chỉ của riêng workload này.
 */

const KIND_LABEL = (kind: EgressKind): string => {
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

const KIND_STYLE: Record<EgressKind, string> = {
  external: 'bg-warning-soft text-warning',
  private: 'bg-subtle text-muted',
  service: 'bg-success-soft text-success',
  pod: 'bg-success-soft text-success',
  unresolved: 'bg-subtle text-muted'
}

/** Loại workload có pod template riêng để quét (ReplicaSet do Deployment quản lý nên không có tab). */
type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})

export const OUTBOUND_KINDS = new Set([
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'jobs.batch',
  'cronjobs.batch'
])

export function OutboundOf({
  kindId,
  obj,
  request
}: {
  kindId: string
  obj: K8sObject
  request: Request
}): React.JSX.Element {
  const ns = obj.metadata.namespace ?? ''
  const name = obj.metadata.name
  const gen = o(obj.metadata)['generation']
  const generation = typeof gen === 'number' ? gen : 0
  const [result, setResult] = useState<EgressResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Cùng lựa chọn đọc Secret với Map (Topology › View).
  const secrets = loadOptions().egressSecrets
  useEffect(() => {
    let cancelled = false
    request<EgressResult>({
      op: 'egress',
      namespaces: [ns],
      secrets,
      workload: { kind: kindId, name }
    }).then(
      (r) => {
        if (cancelled) return
        setResult(r)
        setError(null)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
    // Đọc lại khi cấu hình đổi (generation tăng), không theo nhịp 10 giây: mỗi lần đọc là GET ConfigMap
    // / Secret (ghi vào audit log).
  }, [request, kindId, ns, name, secrets, generation])

  const rows = useMemo(() => {
    if (!result) return null
    const services: MapService[] = (result.services ?? []).map((s) => ({
      ns: s.ns,
      name: s.name,
      type: s.type,
      selector: {},
      ports: '',
      ...(s.clusterIP ? { clusterIP: s.clusterIP } : {}),
      ...(s.externalName ? { externalName: s.externalName } : {})
    }))
    return egressRows(result.items, { services, pods: [] })
  }, [result])

  if (error) return <p className="text-xs text-danger">{error}</p>
  if (!rows || !result)
    return <p className="text-xs text-faint">{t('Reading workload configuration…')}</p>

  return (
    <div className="flex flex-col gap-3" data-testid="k8s-detail-outbound">
      <p className="text-xs text-faint">
        {t(
          'Where this workload is configured to connect — read from its environment variables, arguments, ConfigMaps and Secrets. Not observed traffic.'
        )}
      </p>
      {(result.listDenied ?? 0) > 0 && (
        <p className="rounded-md bg-warning-soft px-2 py-1.5 text-xs text-warning">
          {t('This workload could not be read (no permission).')}
        </p>
      )}
      {(result.skipped.denied > 0 || result.skipped.secrets > 0) && (
        <p className="rounded-md bg-warning-soft px-2 py-1.5 text-xs text-warning">
          {result.skipped.denied > 0 &&
            tn(
              result.skipped.denied,
              '{n} ConfigMap or Secret could not be read (no permission).',
              '{n} ConfigMaps or Secrets could not be read (no permission).'
            )}{' '}
          {result.skipped.secrets > 0 &&
            tn(
              result.skipped.secrets,
              '{n} Secret not read (reading Secrets is off).',
              '{n} Secrets not read (reading Secrets is off).'
            )}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-xs text-faint" data-testid="k8s-detail-outbound-empty">
          {t('No connection targets found in the configuration of this workload.')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.key}
              className="rounded-md border border-line px-2.5 py-2"
              data-testid="k8s-detail-outbound-row"
              data-host={r.dest.host}
              data-kind={r.dest.kind}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">
                  {r.dest.service
                    ? `${r.dest.service.ns}/${r.dest.service.name}${r.dest.port !== undefined ? `:${String(r.dest.port)}` : ''}`
                    : destLabel(r.dest)}
                </span>
                <span
                  className={cx(
                    'shrink-0 rounded px-1.5 py-px text-[11px] font-medium',
                    KIND_STYLE[r.dest.kind]
                  )}
                >
                  {KIND_LABEL(r.dest.kind)}
                </span>
                <button
                  type="button"
                  aria-label={t('Copy {value}', { value: destLabel(r.dest) })}
                  title={t('Copy host:port')}
                  className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
                  onClick={() => {
                    void navigator.clipboard.writeText(destLabel(r.dest))
                  }}
                >
                  <Copy size={12} />
                </button>
              </div>
              {r.dest.viaService && (
                <div className="mt-0.5 text-[11px] text-faint">
                  {t('via {service}', {
                    service: `${r.dest.viaService.ns}/${r.dest.viaService.name}`
                  })}
                </div>
              )}
              <div className="mt-1 flex flex-col gap-0.5 text-[11.5px] text-muted">
                {r.sources.map((x) => (
                  <span key={`${x.source}|${x.via}|${x.key}`} className="font-mono">
                    {egressSourceText(x.source, x.via, x.key)}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
