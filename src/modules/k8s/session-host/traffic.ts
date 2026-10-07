import { selectorMatches } from '../shared/map'
import type { K8sObject } from '../shared/resources'
import {
  linkKey,
  parseCaretta,
  type TrafficLink,
  type TrafficPeer,
  type TrafficSample
} from '../shared/traffic'
import { KubeError, type KubeClient } from './client'
import { HubbleCollector } from './hubble'
import { pool } from './operations'
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
  /** Service → workload theo namespace (promise: nhiều lượt cùng lúc chỉ đọc một lần). */
  services?: { at: number; byNs: Map<string, Promise<Map<string, TrafficPeer[]>>> }
  /** Bộ đếm tích luỹ (xem `accumulate`). */
  counters?: TrafficCounters
  /** Bộ đọc Hubble (Cilium) của client đang dùng — đổi client (kết nối lại) thì tạo mới. */
  hubble?: { client: KubeClient; collector: HubbleCollector }
}

/**
 * Bộ đếm theo agent → tổng đơn điệu: mỗi lượt cộng phần TĂNG của từng agent (agent khởi động lại →
 * cộng giá trị mới). Agent không trả lời lượt này chỉ không cộng gì — tổng không bao giờ tụt rồi
 * vọt lên (tốc độ ảo), dù tập agent đọc được đổi giữa các lượt.
 */
export interface TrafficCounters {
  /** agent (ns/pod) → giá trị thô lần trước theo `${role}|${linkKey}`. */
  agents: Map<string, { at: number; raw: Map<string, number> }>
  /** `${role}|${linkKey}` → link + tổng tích luỹ. */
  acc: Map<string, { link: TrafficLink; role: string; bytes: number; at: number }>
}

/** Agent không thấy chừng này → quên mốc của nó; link không đổi chừng này → bỏ khỏi tổng. */
const AGENT_TTL_MS = 30 * 60_000
const LINK_TTL_MS = 60 * 60_000

/**
 * Cộng một lượt đọc vào bộ đếm; trả link đã gộp: cùng kết nối thấy ở nhiều agent → cộng theo vai
 * trò; thấy từ cả phía client lẫn server → lấy phía lớn hơn (không đếm hai lần).
 */
export function accumulate(
  counters: TrafficCounters,
  reads: readonly { agent: string; rows: ReturnType<typeof parseCaretta> }[],
  at: number
): TrafficLink[] {
  // Lượt đầu: tổng = giá trị thô (byte từ khi agent chạy, như Caretta báo). Về sau agent mới chỉ
  // lấy mốc — agent quay lại sau thời gian dài không cộng cả lịch sử của nó một lần.
  const first = counters.agents.size === 0 && counters.acc.size === 0
  for (const { agent, rows } of reads) {
    // Cùng agent có thể có nhiều dòng cho một cặp (nhiều kết nối) → cộng trong agent trước.
    const raw = new Map<string, number>()
    const links = new Map<string, { link: TrafficLink; role: string }>()
    for (const r of rows) {
      if (!r.client.name || !r.server.name) continue
      const key = `${r.role}|${linkKey(r)}`
      raw.set(key, (raw.get(key) ?? 0) + r.bytes)
      if (!links.has(key))
        links.set(key, {
          link: { client: r.client, server: r.server, port: r.port, bytes: 0 },
          role: r.role
        })
    }
    const prev = counters.agents.get(agent)
    for (const [key, value] of raw) {
      const before = prev?.raw.get(key)
      // Agent mới: chỉ lấy mốc (trừ lượt đầu). Link mới của agent đã biết: cả giá trị là phần tăng.
      const delta = !prev
        ? first
          ? value
          : 0
        : before === undefined
          ? value
          : value >= before
            ? value - before
            : value
      const entry = counters.acc.get(key)
      if (entry) {
        entry.bytes += delta
        entry.at = at
      } else {
        const l = links.get(key)
        if (l) counters.acc.set(key, { link: l.link, role: l.role, bytes: delta, at })
      }
    }
    counters.agents.set(agent, { at, raw })
  }
  for (const [agent, x] of counters.agents)
    if (at - x.at > AGENT_TTL_MS) counters.agents.delete(agent)
  for (const [key, e] of counters.acc) if (at - e.at > LINK_TTL_MS) counters.acc.delete(key)
  const out = new Map<string, TrafficLink>()
  for (const e of counters.acc.values()) {
    const key = linkKey(e.link)
    const prev = out.get(key)
    if (!prev || e.bytes > prev.bytes) out.set(key, { ...e.link, bytes: e.bytes })
  }
  return [...out.values()]
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
export async function resolveServices(
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
  const load = async (ns: string): Promise<Map<string, TrafficPeer[]>> => {
    const found = new Map<string, TrafficPeer[]>()
    const base = `/namespaces/${encodeURIComponent(ns)}`
    const get = (path: string): Promise<K8sObject[]> =>
      client.json<{ items: K8sObject[] }>('GET', path, opts).then((r) => r.items)
    const [services, deps, sts, ds] = await Promise.all([
      get(`/api/v1${base}/services`),
      get(`/apis/apps/v1${base}/deployments`).catch(() => []),
      get(`/apis/apps/v1${base}/statefulsets`).catch(() => []),
      get(`/apis/apps/v1${base}/daemonsets`).catch(() => [])
    ])
    const workloads = [
      ...deps.map((w) => ({ w, kind: 'Deployment', id: 'deployments.apps' })),
      ...sts.map((w) => ({ w, kind: 'StatefulSet', id: 'statefulsets.apps' })),
      ...ds.map((w) => ({ w, kind: 'DaemonSet', id: 'daemonsets.apps' }))
    ].map((x) => ({ ...x, labels: podTemplate(x.id, x.w)?.labels }))
    for (const svc of services) {
      const selector = o(o(svc.spec)['selector'])
      if (!Object.keys(selector).length) continue
      const peers = workloads
        .filter(({ labels }) => (labels ? selectorMatches(selector, labels) : false))
        .map(({ w, kind }) => ({ ns, name: w.metadata.name, kind }))
      if (peers.length) found.set(svc.metadata.name, peers)
    }
    return found
  }
  const behind = new Map<string, TrafficPeer[]>()
  await Promise.all(
    namespaces.map(async (ns) => {
      let p = byNs.get(ns)
      if (!p) {
        // Lưu promise ngay (lượt khác cùng lúc dùng chung); lỗi → không nhớ, lượt sau đọc lại.
        const loading = load(ns)
        p = loading
        byNs.set(ns, loading)
        loading.catch(() => {
          if (byNs.get(ns) === loading) byNs.delete(ns)
        })
      }
      const found = await p.catch(() => new Map<string, TrafficPeer[]>())
      for (const [svc, peers] of found) behind.set(`${ns}/${svc}`, peers)
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
  // Hubble (Cilium) trước: biết từng pod, có tên miền của đích ngoài cluster.
  if (cache.hubble?.client !== client) {
    cache.hubble?.collector.dispose()
    cache.hubble = { client, collector: new HubbleCollector(client) }
  }
  const hubble = cache.hubble.collector
  await hubble.touch(signal)
  if (hubble.present && (hubble.state === 'ok' || hubble.state === 'connecting'))
    return {
      status: 'ok',
      source: 'hubble',
      unit: 'connections',
      at,
      agents: 1,
      links: hubble.snapshot()
    }
  const caretta = await carettaSample(client, cache, at, signal)
  // Có Relay mà không đọc được, Caretta cũng không có → báo lỗi của Hubble (rõ hơn).
  if (caretta.status === 'unavailable' && hubble.present)
    return { ...caretta, reason: hubble.reason }
  return caretta
}

/** Dọn bộ đọc nền (đóng luồng Hubble) khi phiên cluster đóng. */
export function disposeTrafficCache(cache: TrafficCache): void {
  cache.hubble?.collector.dispose()
  delete cache.hubble
}

async function carettaSample(
  client: KubeClient,
  cache: TrafficCache,
  at: number,
  signal?: AbortSignal
): Promise<TrafficSample> {
  // Chỉ nhớ khi đã thấy agent — chưa cài / chưa được phép thì lần sau dò lại (vừa cài là thấy ngay).
  let found: { pods: K8sObject[] } | { reason: string }
  if (cache.agents && at - cache.agents.at <= CACHE_MS) found = cache.agents.value
  else {
    found = await findAgents(client, signal)
    if ('pods' in found) cache.agents = { at, value: found }
  }
  if ('reason' in found)
    return { status: 'unavailable', reason: found.reason, at, agents: 0, links: [] }
  // Cùng tập agent mỗi lượt (sắp theo tên) khi phải cắt bớt.
  const pods = [...found.pods]
    .sort((x, y) =>
      `${x.metadata.namespace ?? ''}/${x.metadata.name}`.localeCompare(
        `${y.metadata.namespace ?? ''}/${y.metadata.name}`
      )
    )
    .slice(0, MAX_AGENTS)
  const reads: { agent: string; rows: ReturnType<typeof parseCaretta> }[] = []
  const seen = { ok: 0, forbidden: false }
  await pool(pods, CONCURRENCY, async (p) => {
    const path = `/api/v1/namespaces/${encodeURIComponent(p.metadata.namespace ?? '')}/pods/${encodeURIComponent(p.metadata.name)}:${String(metricsPort(p))}/proxy/metrics`
    try {
      const text = await client.text('GET', path, signal ? { signal } : {})
      reads.push({
        agent: `${p.metadata.namespace ?? ''}/${p.metadata.name}`,
        rows: parseCaretta(text)
      })
      seen.ok++
    } catch (error) {
      if (error instanceof KubeError && error.status === 403) seen.forbidden = true
    }
  })
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
  cache.counters ??= { agents: new Map(), acc: new Map() }
  const links = await resolveServices(client, accumulate(cache.counters, reads, at), cache, signal)
  return { status: 'ok', source: 'caretta', unit: 'bytes', at, agents: seen.ok, links }
}
