import { selectorMatches } from '../shared/map'
import type { K8sObject } from '../shared/resources'
import {
  mergeLinks,
  parseCaretta,
  type TrafficLink,
  type TrafficPeer,
  type TrafficSample
} from '../shared/traffic'
import { KubeError, type KubeClient } from './client'
import { podTemplate } from './related'

/**
 * Đọc traffic live từ Caretta mà không cần Prometheus: tìm pod agent (DaemonSet) rồi đọc
 * `/metrics` của từng agent qua API server proxy (quyền `pods/proxy`). Không có Caretta / không có
 * quyền → status "unavailable" kèm lý do (giao diện báo rõ, không nhầm với "không có traffic").
 */

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const a = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(o) : [])

const SELECTORS = ['app.kubernetes.io/name=caretta', 'app=caretta']
const DEFAULT_PORT = 7117
/** Cluster rất nhiều node: đọc tối đa chừng này agent mỗi lượt. */
const MAX_AGENTS = 300
const CONCURRENCY = 16
/** Danh sách agent / bảng Service → workload ít đổi: dùng lại trong chừng này (đọc nhanh hơn hẳn). */
const CACHE_MS = 60_000

/** Bộ nhớ đệm theo client (mỗi cluster một client). */
export interface TrafficCache {
  agents?: { at: number; value: { pods: K8sObject[] } | { reason: string } }
  services?: { at: number; byNs: Map<string, Map<string, TrafficPeer[]>> }
}

async function readText(client: KubeClient, path: string, signal?: AbortSignal): Promise<string> {
  const res = await client.open('GET', path, signal ? { signal } : {})
  const chunks: Buffer[] = []
  for await (const c of res as AsyncIterable<Buffer>) chunks.push(c)
  const body = Buffer.concat(chunks).toString('utf8')
  if ((res.statusCode ?? 0) >= 400) throw new KubeError(res.statusCode ?? 500, body.slice(0, 200))
  return body
}

function metricsPort(pod: K8sObject): number {
  for (const c of a(o(pod.spec)['containers']))
    for (const p of a(c['ports']))
      if (
        /prom|metric/i.test(typeof p['name'] === 'string' ? p['name'] : '') ||
        p['containerPort'] === DEFAULT_PORT
      )
        return Number(p['containerPort']) || DEFAULT_PORT
  return DEFAULT_PORT
}

async function findAgents(
  client: KubeClient,
  signal?: AbortSignal
): Promise<{ pods: K8sObject[] } | { reason: string }> {
  for (const sel of SELECTORS) {
    try {
      const r = await client.json<{ items: K8sObject[] }>('GET', '/api/v1/pods', {
        query: { labelSelector: sel, limit: 1000 },
        ...(signal ? { signal } : {})
      })
      const running = r.items.filter((p) => o(p.status)['phase'] === 'Running')
      if (running.length) return { pods: running }
    } catch (error) {
      if (error instanceof KubeError && error.status === 403)
        return { reason: 'Not allowed to list pods in all namespaces to find Caretta' }
      throw error
    }
  }
  return { reason: 'Caretta is not installed in this cluster' }
}

/** Service → workload phía sau (selector khớp pod template); chia đều nếu nhiều workload. */
async function resolveServices(
  client: KubeClient,
  links: TrafficLink[],
  cache: TrafficCache,
  signal?: AbortSignal
): Promise<TrafficLink[]> {
  const namespaces = [
    ...new Set(
      links
        .flatMap((l) => [l.client, l.server])
        .filter((p) => p.kind === 'Service')
        .map((p) => p.ns)
    )
  ].filter(Boolean)
  if (!namespaces.length) return links
  const opts = signal ? { signal } : {}
  if (!cache.services || Date.now() - cache.services.at > CACHE_MS)
    cache.services = { at: Date.now(), byNs: new Map() }
  const byNs = cache.services.byNs
  const behind = new Map<string, TrafficPeer[]>()
  for (const ns of namespaces)
    for (const [svc, peers] of byNs.get(ns) ?? []) behind.set(`${ns}/${svc}`, peers)
  await Promise.all(
    namespaces
      .filter((ns) => !byNs.has(ns))
      .map(async (ns) => {
        const found = new Map<string, TrafficPeer[]>()
        byNs.set(ns, found)
        const base = `/namespaces/${encodeURIComponent(ns)}`
        const get = (path: string): Promise<K8sObject[]> =>
          client
            .json<{ items: K8sObject[] }>('GET', path, opts)
            .then((r) => r.items)
            .catch(() => [])
        const [services, deps, sts, ds] = await Promise.all([
          get(`/api/v1${base}/services`),
          get(`/apis/apps/v1${base}/deployments`),
          get(`/apis/apps/v1${base}/statefulsets`),
          get(`/apis/apps/v1${base}/daemonsets`)
        ])
        const workloads = [
          ...deps.map((w) => ({ w, kind: 'Deployment', id: 'deployments.apps' })),
          ...sts.map((w) => ({ w, kind: 'StatefulSet', id: 'statefulsets.apps' })),
          ...ds.map((w) => ({ w, kind: 'DaemonSet', id: 'daemonsets.apps' }))
        ]
        for (const svc of services) {
          const selector = o(o(svc.spec)['selector'])
          if (!Object.keys(selector).length) continue
          const peers = workloads
            .filter(({ w, id }) => {
              const tpl = podTemplate(id, w)
              return tpl ? selectorMatches(selector, tpl.labels) : false
            })
            .map(({ w, kind }) => ({ ns, name: w.metadata.name, kind }))
          if (peers.length) {
            behind.set(`${ns}/${svc.metadata.name}`, peers)
            found.set(svc.metadata.name, peers)
          }
        }
      })
  )
  const out: TrafficLink[] = []
  for (const l of links) {
    const servers =
      l.server.kind === 'Service' ? behind.get(`${l.server.ns}/${l.server.name}`) : undefined
    const clients =
      l.client.kind === 'Service' ? behind.get(`${l.client.ns}/${l.client.name}`) : undefined
    const ss = servers ?? [l.server]
    const cs = clients ?? [l.client]
    for (const server of ss)
      for (const c of cs)
        out.push({ client: c, server, port: l.port, bytes: l.bytes / (ss.length * cs.length) })
  }
  // Nhiều link Service gộp về cùng cặp workload → cộng.
  const merged = new Map<string, TrafficLink>()
  for (const l of out) {
    const key = `${l.client.kind}|${l.client.ns}|${l.client.name}>${l.server.kind}|${l.server.ns}|${l.server.name}>${l.port}`
    const prev = merged.get(key)
    if (prev) prev.bytes += l.bytes
    else merged.set(key, { ...l })
  }
  return [...merged.values()]
}

/** Một lượt đọc mọi agent Caretta. */
export async function trafficSample(
  client: KubeClient,
  cache: TrafficCache,
  signal?: AbortSignal
): Promise<TrafficSample> {
  const at = Date.now()
  // Chỉ nhớ khi đã thấy agent — chưa cài / chưa được phép thì lần sau dò lại (vừa cài là thấy ngay).
  let found: { pods: K8sObject[] } | { reason: string }
  if (cache.agents && at - cache.agents.at <= CACHE_MS) found = cache.agents.value
  else {
    found = await findAgents(client, signal)
    if ('pods' in found) cache.agents = { at, value: found }
  }
  if ('reason' in found)
    return { status: 'unavailable', reason: found.reason, at, agents: 0, links: [] }
  const pods = found.pods.slice(0, MAX_AGENTS)
  const rows: ReturnType<typeof parseCaretta> = []
  const seen = { ok: 0, forbidden: false }
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pods.length) }, async () => {
      while (next < pods.length) {
        const p = pods[next++]
        if (!p) continue
        const path = `/api/v1/namespaces/${encodeURIComponent(p.metadata.namespace ?? '')}/pods/${encodeURIComponent(p.metadata.name)}:${String(metricsPort(p))}/proxy/metrics`
        try {
          rows.push(...parseCaretta(await readText(client, path, signal)))
          seen.ok++
        } catch (error) {
          if (error instanceof KubeError && error.status === 403) seen.forbidden = true
        }
      }
    })
  )
  if (!seen.ok) {
    // Agent có thể vừa đổi (rollout) → lần sau dò lại.
    delete cache.agents
    return {
      status: 'unavailable',
      reason: seen.forbidden
        ? 'Caretta is installed but you are not allowed to read its metrics (pods/proxy)'
        : 'Caretta is installed but its agents did not answer',
      at,
      agents: pods.length,
      links: []
    }
  }
  const links = await resolveServices(client, mergeLinks(rows), cache, signal)
  return { status: 'ok', at, agents: seen.ok, links }
}
