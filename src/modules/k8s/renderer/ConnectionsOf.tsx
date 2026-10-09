import { useEffect, useMemo, useState } from 'react'
import { cleanError } from '../../../renderer/src/lib/format'
import { t, tn } from '../../registry/renderer-kit'
import { STATUS_ORDER } from '../shared/connections'
import { egressRows, type EgressResult } from '../shared/egress'
import { egressSourceText } from '../shared/appTopology'
import type { MapData } from '../shared/map'
import type { K8sObject } from '../shared/resources'
import { CopyButton, kindLabel, ObservedText, StatusPill } from './ConnectionBits'
import { loadOptions, saveOptions, type Request } from './mapModel'
import { sourceName } from './trafficUnit'
import { useConnections } from './useConnections'

/**
 * Tab "Connections" trong chi tiết workload: nơi workload này được cấu hình để kết nối (env, args,
 * ConfigMap, Secret) ghép với traffic quan sát được — cùng một danh sách thay vì hai tab lệch nhau.
 */

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})

/** Loại workload có pod template riêng để quét (ReplicaSet do Deployment quản lý nên không có tab). */
export const CONNECTION_KINDS = new Set([
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'jobs.batch',
  'cronjobs.batch'
])

/** Namespace cần để phân loại đích: của workload + namespace trong tên DNS name.ns.svc. */
function namespacesFor(ns: string, hosts: readonly string[]): string[] {
  const need = new Set([ns])
  for (const h of hosts) {
    const m = /^(?:[a-z0-9-]+\.)?[a-z0-9-]+\.([a-z0-9-]+)\.svc(?:\.|$)/.exec(h)
    const two = /^[a-z0-9-]+\.([a-z0-9-]+)$/.exec(h)
    if (m?.[1]) need.add(m[1])
    else if (two?.[1]) need.add(two[1])
  }
  return [...need].slice(0, 8)
}

export function ConnectionsOf({
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
  const [{ internalDns, secrets }, setOpts] = useState(() => {
    const opts = loadOptions()
    return { internalDns: opts.internalDns, secrets: opts.egressSecrets }
  })
  const [loaded, setLoaded] = useState<{ result: EgressResult; data: MapData | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    request<EgressResult>({
      op: 'egress',
      namespaces: [ns],
      secrets,
      workload: { kind: kindId, name }
    })
      .then(async (result) => {
        // Map của các namespace liên quan: Service → workload đứng sau, IP pod — để phân loại / ghép.
        const data = await request<MapData>({
          op: 'map',
          namespaces: namespacesFor(
            ns,
            result.items.map((i) => i.host)
          )
        }).catch(() => null)
        if (!cancelled) {
          setLoaded({ result, data })
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      })
    return () => {
      cancelled = true
    }
    // Đọc lại khi cấu hình đổi (generation tăng), không theo nhịp 10 giây: mỗi lần đọc là GET
    // ConfigMap / Secret (ghi vào audit log).
  }, [request, kindId, ns, name, secrets, generation])

  const declared = useMemo(() => {
    if (!loaded) return null
    const base = loaded.data ?? {
      services: (loaded.result.services ?? []).map((s) => ({
        ns: s.ns,
        name: s.name,
        type: s.type,
        selector: {},
        ports: '',
        ...(s.clusterIP ? { clusterIP: s.clusterIP } : {}),
        ...(s.externalName ? { externalName: s.externalName } : {})
      })),
      pods: []
    }
    return egressRows(loaded.result.items, base)
  }, [loaded])
  const only = useMemo(() => ({ kind: kindId, ns, name }), [kindId, ns, name])
  const conn = useConnections({
    request,
    declared,
    data: loaded?.data ?? null,
    only,
    active: true,
    internalDns
  })

  if (error) return <p className="text-xs text-danger">{error}</p>
  if (!loaded || !conn.rows)
    return <p className="text-xs text-faint">{t('Reading workload configuration…')}</p>
  const result = loaded.result
  const rows = [...conn.rows]
    .filter((r) => !r.system)
    .sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.label.localeCompare(b.label)
    )

  return (
    <div className="flex flex-col gap-3" data-testid="k8s-detail-connections">
      <p className="text-xs text-faint">
        {t(
          'Where this workload is configured to connect (env, arguments, ConfigMaps, Secrets), next to the traffic that was actually seen.'
        )}
      </p>
      <p className="text-[11px] text-faint" data-testid="k8s-detail-conn-note">
        {conn.traffic.status === 'live'
          ? t('Observed traffic: {source}, average over the last minute.', {
              source: sourceName(conn.traffic.source)
            })
          : conn.traffic.status === 'connecting'
            ? t('Measuring traffic…')
            : t(
                'No traffic source in this cluster (Caretta or Hubble) — only the configuration is shown.'
              )}
      </p>
      {conn.measured && (
        <label className="flex items-start gap-1.5 text-[11px] text-faint">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={internalDns}
            data-testid="k8s-detail-conn-internal-dns"
            onChange={(e) => {
              saveOptions({ internalDns: e.target.checked })
              setOpts((p) => ({ ...p, internalDns: e.target.checked }))
            }}
          />
          <span>
            {t(
              'Hostnames are looked up on this computer to match the IPs that were seen. Also look up internal names (.corp, .internal…) with this computer’s DNS'
            )}
          </span>
        </label>
      )}
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
        <p className="text-xs text-faint" data-testid="k8s-detail-conn-empty">
          {t('No connection targets found in the configuration of this workload.')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.key}
              className="rounded-md border border-line px-2.5 py-2"
              data-testid="k8s-detail-conn-row"
              data-status={r.status}
              data-label={r.label}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">
                  {r.label}
                </span>
                <StatusPill status={r.status} />
                {!r.members && <CopyButton value={r.label} />}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                <span>{kindLabel(r.kind)}</span>
                {r.dest?.viaService && (
                  <span>
                    {t('via {service}', {
                      service: `${r.dest.viaService.ns}/${r.dest.viaService.name}`
                    })}
                  </span>
                )}
              </div>
              <div className="mt-1.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11.5px]">
                <span className="text-faint">{t('Declared in')}</span>
                <span className="flex flex-col font-mono text-muted">
                  {r.declared ? (
                    r.declared.map((x) => (
                      <span key={`${x.source}|${x.via}|${x.key}`}>
                        {egressSourceText(x.source, x.via, x.key)}
                      </span>
                    ))
                  ) : (
                    <span className="font-sans text-faint">{t('not declared anywhere')}</span>
                  )}
                </span>
                <span className="text-faint">{t('Observed')}</span>
                <ObservedText observed={r.observed} measured={conn.measured} />
              </div>
              {r.members && (
                <div className="mt-1 font-mono text-[11px] text-faint">
                  {r.members.map((m) => m.label).join(' · ')}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
