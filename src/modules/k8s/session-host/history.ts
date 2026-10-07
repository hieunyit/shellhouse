import type { EventCount, HistoryProbe, TrafficRange, TrafficSeries } from '../shared/history'
import type { K8sObject } from '../shared/resources'
import {
  mergeLinks,
  type TrafficLink,
  type TrafficPeer,
  type TrafficRate,
  type TrafficUnit
} from '../shared/traffic'
import { KubeError, type KubeClient } from './client'
import { escapeRe, promBase, type PromTarget } from './prometheus'
import { resolveServices, type TrafficCache } from './traffic'

/**
 * Lịch sử qua Prometheus: traffic Caretta / Hubble (trung bình theo khoảng, chuỗi thời gian của một
 * workload) và số event theo lý do (event exporter). Mọi truy vấn qua API server proxy.
 */

interface Vector {
  status?: string
  data?: { result?: { metric: Record<string, string>; value: [number, string] }[] }
}
interface Matrix {
  status?: string
  data?: { result?: { metric: Record<string, string>; values: [number, string][] }[] }
}

const CARETTA = 'caretta_links_observed'
const HUBBLE_SYN = 'hubble_tcp_flags_total'
const EVENT_METRICS = ['kube_events_total', 'kube_event_count'] as const

/** Một bước của chuỗi: ~120 điểm, tối thiểu 30 s. */
export function stepFor(seconds: number): number {
  return Math.max(30, Math.round(seconds / 120 / 30) * 30)
}

async function instant(
  client: KubeClient,
  t: PromTarget,
  query: string,
  time: number,
  signal?: AbortSignal
): Promise<NonNullable<NonNullable<Vector['data']>['result']>> {
  const r = await client.json<Vector>('GET', `${promBase(t)}/api/v1/query`, {
    query: { query, time: Math.floor(time / 1000) },
    ...(signal ? { signal } : {})
  })
  return r.data?.result ?? []
}

async function range(
  client: KubeClient,
  t: PromTarget,
  query: string,
  start: number,
  end: number,
  step: number,
  signal?: AbortSignal
): Promise<NonNullable<NonNullable<Matrix['data']>['result']>> {
  const r = await client.json<Matrix>('GET', `${promBase(t)}/api/v1/query_range`, {
    query: { query, start: Math.floor(start / 1000), end: Math.floor(end / 1000), step },
    ...(signal ? { signal } : {})
  })
  return r.data?.result ?? []
}

/** Prometheus có metric nào (một lượt vài truy vấn nhỏ). */
export async function probeHistory(
  client: KubeClient,
  t: PromTarget | null,
  signal?: AbortSignal
): Promise<HistoryProbe> {
  if (!t) return { prometheus: null, traffic: null, events: null }
  const now = Date.now()
  const has = async (q: string): Promise<boolean> =>
    instant(client, t, q, now, signal).then(
      (r) => r.some((x) => Number(x.value[1]) > 0),
      () => false
    )
  const [caretta, hubbleAny, hubbleWorkloads, ...events] = await Promise.all([
    has(`count(${CARETTA})`),
    has(`count(${HUBBLE_SYN})`),
    has(`count(${HUBBLE_SYN}{source_workload!=""})`),
    ...EVENT_METRICS.map((m) => has(`count(${m})`))
  ])
  const metric = EVENT_METRICS.find((_, i) => events[i])
  const byName = metric ? await has(`count(${metric}{involved_object_name!=""})`) : false
  return {
    prometheus: `${t.ns}/${t.name}`,
    traffic: caretta ? 'caretta' : hubbleWorkloads ? 'hubble' : null,
    ...(!caretta && hubbleAny && !hubbleWorkloads ? { hubbleNoWorkloads: true } : {}),
    events: metric ? { metric, byName } : null
  }
}

const NONE_REASON = {
  prometheus: 'No Prometheus found in the cluster (or not allowed to use services/proxy)',
  traffic:
    'Prometheus does not collect traffic metrics — scrape Caretta, or enable the Hubble "tcp" metric with labelsContext=source_namespace,source_workload,destination_namespace,destination_workload'
}

/** Workload (không rõ loại — Hubble chỉ ghi tên) → loại thật trong namespace; không thấy → Pod. */
async function resolveKinds(
  client: KubeClient,
  peers: readonly TrafficPeer[],
  signal?: AbortSignal
): Promise<(p: TrafficPeer) => TrafficPeer> {
  const namespaces = [...new Set(peers.filter((p) => p.ns && !p.kind).map((p) => p.ns))]
  const kinds = new Map<string, string>()
  await Promise.all(
    namespaces.map(async (ns) => {
      const base = `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}`
      const list = (path: string, kind: string): Promise<void> =>
        client
          .json<{ items: K8sObject[] }>('GET', path, signal ? { signal } : {})
          .then((r) => {
            for (const w of r.items) kinds.set(`${ns}/${w.metadata.name}`, kind)
          })
          .catch(() => undefined)
      await Promise.all([
        list(`${base}/deployments`, 'Deployment'),
        list(`${base}/statefulsets`, 'StatefulSet'),
        list(`${base}/daemonsets`, 'DaemonSet')
      ])
    })
  )
  return (p) => (p.kind ? p : { ...p, kind: kinds.get(`${p.ns}/${p.name}`) ?? 'Pod' })
}

/** Tốc độ trung bình từng cặp trong [start, end] (ms). */
export async function trafficRange(
  client: KubeClient,
  t: PromTarget | null,
  probe: HistoryProbe,
  cache: TrafficCache,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<TrafficRange> {
  if (!t) return { source: 'none', reason: NONE_REASON.prometheus }
  if (!probe.traffic) return { source: 'none', reason: NONE_REASON.traffic }
  const seconds = Math.max(60, Math.round((end - start) / 1000))
  const via = `${t.ns}/${t.name}`
  if (probe.traffic === 'caretta') {
    const rows = await instant(
      client,
      t,
      `sum by (role, client_namespace, client_name, client_kind, server_namespace, server_name, server_kind, server_port) (increase(${CARETTA}[${String(seconds)}s]))`,
      end,
      signal
    )
    const links = mergeLinks(
      rows.map((r) => ({
        client: {
          ns: r.metric['client_namespace'] ?? '',
          name: r.metric['client_name'] ?? '',
          kind: r.metric['client_kind'] ?? ''
        },
        server: {
          ns: r.metric['server_namespace'] ?? '',
          name: r.metric['server_name'] ?? '',
          kind: r.metric['server_kind'] ?? ''
        },
        port: r.metric['server_port'] ?? '',
        role: r.metric['role'] ?? '',
        bytes: Math.max(0, Number(r.value[1]) || 0)
      }))
    )
    const resolved = await resolveServices(client, links, cache, signal)
    return {
      source: 'prometheus',
      via,
      unit: 'bytes',
      start,
      end,
      rates: toRates(resolved, seconds, 'bytes')
    }
  }
  const rows = await instant(
    client,
    t,
    `sum by (source_namespace, source_workload, destination_namespace, destination_workload) (increase(${HUBBLE_SYN}{flag="SYN", source_workload!=""}[${String(seconds)}s]))`,
    end,
    signal
  )
  const raw: TrafficLink[] = rows.map((r) => {
    const dest = r.metric['destination_workload'] ?? ''
    return {
      client: {
        ns: r.metric['source_namespace'] ?? '',
        name: r.metric['source_workload'] ?? '',
        kind: ''
      },
      server: dest
        ? { ns: r.metric['destination_namespace'] ?? '', name: dest, kind: '' }
        : { ns: '', name: 'world', kind: 'external' },
      port: '',
      bytes: Math.max(0, Number(r.value[1]) || 0)
    }
  })
  const kindOf = await resolveKinds(
    client,
    raw.flatMap((l) => [l.client, l.server]),
    signal
  )
  const links = raw.map((l) => ({ ...l, client: kindOf(l.client), server: kindOf(l.server) }))
  return {
    source: 'prometheus',
    via,
    unit: 'connections',
    start,
    end,
    rates: toRates(links, seconds, 'connections')
  }
}

function toRates(links: readonly TrafficLink[], seconds: number, unit: TrafficUnit): TrafficRate[] {
  return links
    .filter((l) => l.bytes > 0)
    .map((l) => ({
      client: l.client,
      server: l.server,
      port: l.port,
      rate: l.bytes / seconds,
      ...(unit === 'connections' ? { unit } : {})
    }))
}

/** Lấy giá trị lớn nhất theo thời điểm giữa các chuỗi (cùng kết nối thấy từ client và server). */
function maxByTime(series: readonly { values: [number, string][] }[]): [number, number][] {
  const at = new Map<number, number>()
  for (const s of series)
    for (const [t, v] of s.values) at.set(t, Math.max(at.get(t) ?? 0, Number(v) || 0))
  return [...at.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => [t * 1000, v])
}

/**
 * Vào / ra của một workload theo thời gian. Caretta: phía server có thể là Service trỏ tới workload
 * (`services` — tên các Service chọn pod của nó).
 */
export async function trafficSeries(
  client: KubeClient,
  t: PromTarget | null,
  probe: HistoryProbe,
  workload: { ns: string; name: string; kind: string; services: readonly string[] },
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<TrafficSeries> {
  if (!t) return { source: 'none', reason: NONE_REASON.prometheus }
  if (!probe.traffic) return { source: 'none', reason: NONE_REASON.traffic }
  const step = stepFor((end - start) / 1000)
  const window = `${String(Math.max(60, step * 2))}s`
  const via = `${t.ns}/${t.name}`
  const ns = `"${workload.ns.replace(/"/g, '')}"`
  if (probe.traffic === 'caretta') {
    const servers = [workload.name, ...workload.services].map(escapeRe).join('|')
    const [inbound, outbound] = await Promise.all([
      range(
        client,
        t,
        `sum by (role) (rate(${CARETTA}{server_namespace=${ns}, server_name=~"${servers}"}[${window}]))`,
        start,
        end,
        step,
        signal
      ),
      range(
        client,
        t,
        `sum by (role) (rate(${CARETTA}{client_namespace=${ns}, client_name="${escapeRe(workload.name)}"}[${window}]))`,
        start,
        end,
        step,
        signal
      )
    ])
    return {
      source: 'prometheus',
      via,
      unit: 'bytes',
      step: step * 1000,
      inbound: maxByTime(inbound),
      outbound: maxByTime(outbound)
    }
  }
  const name = `"${escapeRe(workload.name)}"`
  const [inbound, outbound] = await Promise.all([
    range(
      client,
      t,
      `sum(rate(${HUBBLE_SYN}{flag="SYN", destination_namespace=${ns}, destination_workload=${name}}[${window}]))`,
      start,
      end,
      step,
      signal
    ),
    range(
      client,
      t,
      `sum(rate(${HUBBLE_SYN}{flag="SYN", source_namespace=${ns}, source_workload=${name}}[${window}]))`,
      start,
      end,
      step,
      signal
    )
  ])
  return {
    source: 'prometheus',
    via,
    unit: 'connections',
    step: step * 1000,
    inbound: maxByTime(inbound),
    outbound: maxByTime(outbound)
  }
}

/**
 * Số event theo lý do trong [start, end] của một namespace (lọc tên đối tượng khi exporter giữ
 * nhãn tên). Mỗi bước có tăng → một mục.
 */
export async function eventCounts(
  client: KubeClient,
  t: PromTarget | null,
  probe: HistoryProbe,
  namespace: string,
  namePattern: string | null,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<EventCount[]> {
  if (!t || !probe.events) return []
  const { metric, byName } = probe.events
  const step = Math.max(300, stepFor((end - start) / 1000))
  const sel = [
    `involved_object_namespace="${namespace.replace(/"/g, '')}"`,
    ...(byName && namePattern ? [`involved_object_name=~"${namePattern}"`] : [])
  ].join(', ')
  const by = `reason, type, involved_object_kind${byName ? ', involved_object_name' : ''}`
  let rows: Awaited<ReturnType<typeof range>>
  try {
    rows = await range(
      client,
      t,
      `sum by (${by}) (increase(${metric}{${sel}}[${String(step)}s]))`,
      start,
      end,
      step,
      signal
    )
  } catch (error) {
    if (error instanceof KubeError) return []
    throw error
  }
  const out: EventCount[] = []
  for (const r of rows)
    for (const [time, v] of r.values) {
      const count = Math.round(Number(v) || 0)
      if (count < 1) continue
      out.push({
        at: time * 1000,
        reason: r.metric['reason'] ?? '',
        type: r.metric['type'] ?? 'Normal',
        kind: r.metric['involved_object_kind'] ?? '',
        ...(r.metric['involved_object_name'] ? { name: r.metric['involved_object_name'] } : {}),
        count
      })
    }
  return out
}
