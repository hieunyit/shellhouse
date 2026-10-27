import type { K8sObject } from '../shared/resources'
import { linkKey, parseCaretta, type TrafficLink, type TrafficSample } from '../shared/traffic'
import { KubeError, type KubeClient } from './client'
import { HubbleCollector } from './hubble'
import { pool } from './operations'

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
  agents?: { at: number; value: { pods: K8sObject[]; truncated?: boolean } | { reason: string } }
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
): Promise<{ pods: K8sObject[]; truncated?: boolean } | { reason: string }> {
  const pods = new Map<string, K8sObject>()
  let truncated = false
  for (const sel of SELECTORS) {
    try {
      const r = await client.json<{ items: K8sObject[] | null; metadata?: { continue?: string } }>(
        'GET',
        '/api/v1/pods',
        {
          query: { labelSelector: sel, limit: 1000 },
          ...(signal ? { signal } : {})
        }
      )
      truncated ||= Boolean(r.metadata?.continue)
      for (const p of r.items ?? []) {
        if (
          p.metadata.deletionTimestamp ||
          ['Succeeded', 'Failed'].includes(String(o(p.status)['phase']))
        )
          continue
        pods.set(`${p.metadata.namespace ?? ''}/${p.metadata.name}`, p)
      }
    } catch (error) {
      if (error instanceof KubeError && error.status === 403)
        return { reason: 'Not allowed to list pods in all namespaces to find Caretta' }
      throw error
    }
  }
  return pods.size
    ? { pods: [...pods.values()], truncated }
    : { reason: 'Caretta is not installed in this cluster' }
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
      status: hubble.state === 'connecting' ? 'connecting' : 'ok',
      source: 'hubble',
      unit: 'observations',
      at,
      agents: 1,
      links: hubble.snapshot(),
      quality: hubble.quality()
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
  let found: { pods: K8sObject[]; truncated?: boolean } | { reason: string }
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
  const links = accumulate(cache.counters, reads, at)
  return {
    status: 'ok',
    source: 'caretta',
    unit: 'bytes',
    at,
    agents: seen.ok,
    links,
    quality: {
      partial: Boolean(found.truncated) || seen.ok < found.pods.length,
      expectedAgents: found.pods.length,
      reasons: [
        ...(found.truncated ? ['Caretta agent discovery was truncated'] : []),
        ...(found.pods.length > MAX_AGENTS ? ['Caretta agent read limit reached'] : []),
        ...(seen.ok < pods.length ? ['Some Caretta agents did not answer'] : [])
      ]
    }
  }
}
