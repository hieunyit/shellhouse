import { useEffect, useMemo, useState } from 'react'
import {
  buildConnections,
  isPublicHostname,
  isResolvableHostname,
  type ConnectionRow
} from '../shared/connections'
import type { EgressRow, EgressWorkloadRef } from '../shared/egress'
import type { MapData } from '../shared/map'
import type { K8sOp } from '../shared/ops'
import { useTraffic, type TrafficState } from './useTraffic'

type Request = <T>(op: K8sOp) => Promise<T>

interface ResolveResult {
  results: Record<string, string[]>
  skipped: string[]
}

/** Tên máy → IP (phân giải trên máy này) cho các đích khai báo bằng tên. Chỉ chạy khi cần đối chiếu. */
export function useResolved(
  request: Request,
  hosts: readonly string[],
  enabled: boolean,
  internal: boolean
): { map: ReadonlyMap<string, readonly string[]>; loading: boolean } {
  const key = `${internal ? 'i' : 'p'}|${[...hosts].sort().join(',')}`
  const [done, setDone] = useState<{
    request: Request
    key: string
    map: ReadonlyMap<string, readonly string[]>
  } | null>(null)
  useEffect(() => {
    if (!enabled || hosts.length === 0) return
    let cancelled = false
    const run = (): void => {
      request<ResolveResult>({
        op: 'resolve',
        hosts: [...hosts],
        ...(internal ? { internal } : {})
      }).then(
        (r) => {
          if (!cancelled) setDone({ request, key, map: new Map(Object.entries(r.results)) })
        },
        () => {
          if (!cancelled) setDone({ request, key, map: new Map() })
        }
      )
    }
    run()
    // DNS đổi chậm; Session Host còn nhớ kết quả 10 phút — hỏi lại thưa.
    const timer = setInterval(run, 10 * 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // `hosts` đã nằm trong `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, key, enabled, internal])
  const ready = done && done.request === request && done.key === key
  return {
    map: ready ? done.map : new Map(),
    loading: enabled && hosts.length > 0 && !ready
  }
}

export interface ConnectionsState {
  rows: ConnectionRow[] | null
  traffic: TrafficState
  /** Có nguồn traffic và đã đo (live). */
  measured: boolean
  resolving: boolean
}

/**
 * Connections của một hay mọi workload: ghép khai báo (Outbound) với traffic quan sát được
 * (Caretta / Hubble), phân giải tên máy công khai để đối chiếu với IP.
 */
export function useConnections({
  request,
  declared,
  data,
  only,
  active,
  internalDns,
  traffic: sharedTraffic,
  observe = true
}: {
  request: Request
  declared: readonly EgressRow[] | null
  data?: Pick<MapData, 'services' | 'workloads'> | null
  only?: EgressWorkloadRef
  active: boolean
  internalDns: boolean
  /** Dùng luồng traffic đã có (Map đã đọc sẵn) thay vì tự đọc. */
  traffic?: TrafficState
  /** false = không ghép với traffic (người dùng tắt lớp traffic): mọi đích là "chưa đo". */
  observe?: boolean
}): ConnectionsState {
  const own = useTraffic(request, active && !sharedTraffic && observe)
  const traffic = sharedTraffic ?? own
  const measured = observe && traffic.status === 'live'
  const hosts = useMemo(() => {
    const set = new Set<string>()
    for (const r of declared ?? []) {
      if (
        only &&
        (r.workload.kind !== only.kind ||
          r.workload.ns !== only.ns ||
          r.workload.name !== only.name)
      )
        continue
      if (r.dest.kind !== 'external') continue
      const h = r.dest.host
      if (internalDns ? isResolvableHostname(h) : isPublicHostname(h)) set.add(h)
    }
    return [...set].slice(0, 64)
  }, [declared, only, internalDns])
  const resolved = useResolved(request, hosts, active && measured, internalDns)
  const rows = useMemo(
    () =>
      declared
        ? buildConnections({
            declared,
            observed: measured ? traffic.rates : null,
            unit: traffic.unit,
            resolved: resolved.map,
            data: data ?? undefined,
            only
          })
        : null,
    [declared, measured, traffic.rates, traffic.unit, resolved.map, data, only]
  )
  return { rows, traffic, measured, resolving: resolved.loading }
}
