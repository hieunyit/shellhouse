/**
 * Traffic live từ Caretta (eBPF, groundcover): mỗi agent (DaemonSet) xuất metric Prometheus
 * `caretta_links_observed` = tổng byte đã thấy trên một kết nối client → server từ khi agent chạy.
 * Thuần (Session Host, renderer, test dùng chung): parse, gộp, tính tốc độ, băng lưu lượng cố định.
 */

export interface TrafficPeer {
  ns: string
  name: string
  /** Deployment, StatefulSet, DaemonSet, Pod, Node, external… (như Caretta báo). */
  kind: string
}

export interface TrafficLink {
  client: TrafficPeer
  server: TrafficPeer
  port: string
  /** Byte tích luỹ (counter). */
  bytes: number
}

export interface TrafficSample {
  /** unavailable = không có Caretta / không đọc được; ok = đã đọc agent. */
  status: 'unavailable' | 'ok'
  reason?: string
  /** ms epoch lúc đọc. */
  at: number
  agents: number
  links: TrafficLink[]
}

export const METRIC = 'caretta_links_observed'

const LABEL = /(\w+)="((?:[^"\\]|\\.)*)"/g

/** Dòng Prometheus text của metric Caretta → link (bỏ dòng khác / hỏng). */
export function parseCaretta(text: string): (TrafficLink & { role: string })[] {
  const out: (TrafficLink & { role: string })[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${METRIC}{`)) continue
    const close = line.lastIndexOf('}')
    if (close < 0) continue
    const value = Number(
      line
        .slice(close + 1)
        .trim()
        .split(/\s+/)[0]
    )
    if (!Number.isFinite(value)) continue
    const labels: Record<string, string> = {}
    for (const m of line.slice(METRIC.length + 1, close).matchAll(LABEL))
      labels[m[1] ?? ''] = (m[2] ?? '').replace(/\\(.)/g, '$1')
    out.push({
      client: {
        ns: labels['client_namespace'] ?? '',
        name: labels['client_name'] ?? '',
        kind: labels['client_kind'] ?? ''
      },
      server: {
        ns: labels['server_namespace'] ?? '',
        name: labels['server_name'] ?? '',
        kind: labels['server_kind'] ?? ''
      },
      port: labels['server_port'] ?? '',
      role: labels['role'] ?? '',
      bytes: value
    })
  }
  return out
}

export const peerKey = (p: TrafficPeer): string => `${p.kind}|${p.ns}|${p.name}`
export const linkKey = (l: Pick<TrafficLink, 'client' | 'server' | 'port'>): string =>
  `${peerKey(l.client)}>${peerKey(l.server)}>${l.port}`

/**
 * Gộp các agent: cùng kết nối thấy ở nhiều agent (mỗi node một) → cộng theo vai trò; cùng kết nối
 * thấy từ cả phía client lẫn server → lấy phía lớn hơn (không đếm hai lần).
 */
export function mergeLinks(rows: readonly (TrafficLink & { role: string })[]): TrafficLink[] {
  const byRole = new Map<string, Map<string, TrafficLink>>()
  for (const r of rows) {
    if (!r.client.name || !r.server.name) continue
    const key = linkKey(r)
    const m = byRole.get(r.role) ?? new Map<string, TrafficLink>()
    const prev = m.get(key)
    if (prev) prev.bytes += r.bytes
    else m.set(key, { client: r.client, server: r.server, port: r.port, bytes: r.bytes })
    byRole.set(r.role, m)
  }
  const out = new Map<string, TrafficLink>()
  for (const m of byRole.values())
    for (const [key, l] of m) {
      const prev = out.get(key)
      if (!prev || l.bytes > prev.bytes) out.set(key, { ...l })
    }
  return [...out.values()]
}

export interface TrafficRate {
  client: TrafficPeer
  server: TrafficPeer
  port: string
  /** Byte / giây. */
  rate: number
}

/** Tốc độ giữa hai lần đọc; counter giảm (agent khởi động lại) → bỏ kết nối đó lần này. */
export function trafficRates(prev: TrafficSample, cur: TrafficSample): TrafficRate[] {
  const dt = (cur.at - prev.at) / 1000
  if (dt <= 0) return []
  const before = new Map(prev.links.map((l) => [linkKey(l), l.bytes]))
  const out: TrafficRate[] = []
  for (const l of cur.links) {
    const b = before.get(linkKey(l))
    if (b === undefined || l.bytes < b) continue
    out.push({ client: l.client, server: l.server, port: l.port, rate: (l.bytes - b) / dt })
  }
  return out
}

/**
 * Băng lưu lượng cố định (byte / giây, tuyệt đối — không co giãn theo cluster), nên độ dày / màu so
 * được giữa các cluster.
 */
export const BANDS = [
  { max: 1_024, label: '< 1 KB/s', width: 1.5 },
  { max: 10_240, label: '1–10 KB/s', width: 2.5 },
  { max: 102_400, label: '10–100 KB/s', width: 3.5 },
  { max: 1_048_576, label: '0.1–1 MB/s', width: 5 },
  { max: 10_485_760, label: '1–10 MB/s', width: 7 },
  { max: Number.POSITIVE_INFINITY, label: '> 10 MB/s', width: 9 }
] as const

export function bandOf(rate: number): number {
  const i = BANDS.findIndex((b) => rate < b.max)
  return i < 0 ? BANDS.length - 1 : i
}

export function formatRate(rate: number): string {
  if (rate < 1) return 'idle'
  if (rate < 1024) return `${rate.toFixed(0)} B/s`
  if (rate < 1_048_576) return `${(rate / 1024).toFixed(rate < 10_240 ? 1 : 0)} KB/s`
  return `${(rate / 1_048_576).toFixed(rate < 10_485_760 ? 1 : 0)} MB/s`
}

/** Kind Caretta (Deployment…) → id loại của module (deployments.apps…). */
export const WORKLOAD_KIND_ID: Record<string, string> = {
  Deployment: 'deployments.apps',
  StatefulSet: 'statefulsets.apps',
  DaemonSet: 'daemonsets.apps',
  Job: 'jobs.batch',
  CronJob: 'cronjobs.batch'
}

/** Gộp theo cặp (client, server), bỏ port — dùng vẽ đường. */
export function byPair(rates: readonly TrafficRate[]): TrafficRate[] {
  const m = new Map<string, TrafficRate>()
  for (const r of rates) {
    const key = `${peerKey(r.client)}>${peerKey(r.server)}`
    const prev = m.get(key)
    if (prev) prev.rate += r.rate
    else m.set(key, { ...r, port: '' })
  }
  return [...m.values()]
}

// ——— Service map từ Caretta ———

export interface TrafficGraphNode {
  id: string
  peer: TrafficPeer
  /** Cột (0 = nguồn: ingress / client ngoài cluster). */
  col: number
  x: number
  y: number
  w: number
  h: number
  /** Tổng byte / giây vào / ra. */
  inRate: number
  outRate: number
}

export interface TrafficGraph {
  nodes: TrafficGraphNode[]
  edges: { from: string; to: string; rate: number }[]
  width: number
  height: number
}

const NODE_W = 240
const NODE_H = 58
const COL_GAP = 150
const ROW_GAP = 22

/**
 * Service map: mỗi bên (workload / ngoài cluster) một node, xếp cột trái → phải theo hướng gọi
 * (nguồn trước, đích ngoài cluster ở cột cuối). Vòng lặp (A ↔ B) không làm lệch cột vô hạn.
 */
export function trafficGraph(rates: readonly TrafficRate[]): TrafficGraph {
  const pairs = byPair(rates)
  const peers = new Map<string, TrafficPeer>()
  for (const r of pairs) {
    peers.set(peerKey(r.client), r.client)
    peers.set(peerKey(r.server), r.server)
  }
  const edges = pairs
    .map((r) => ({ from: peerKey(r.client), to: peerKey(r.server), rate: r.rate }))
    .filter((e) => e.from !== e.to)
  const incoming = new Map<string, number>()
  for (const e of edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)
  // Cột = đường dài nhất từ một nguồn (lặp có giới hạn — chịu được vòng).
  const col = new Map<string, number>([...peers.keys()].map((k) => [k, 0]))
  for (let i = 0; i < peers.size; i++) {
    let changed = false
    for (const e of edges) {
      const c = (col.get(e.from) ?? 0) + 1
      if (c > (col.get(e.to) ?? 0) && c < peers.size) {
        col.set(e.to, c)
        changed = true
      }
    }
    if (!changed) break
  }
  // Đích ngoài cluster chỉ nhận (DB, API bên ngoài): cột cuối.
  const last = Math.max(0, ...col.values())
  for (const [k, p] of peers)
    if (p.kind === 'external' && (incoming.get(k) ?? 0) > 0 && !edges.some((e) => e.from === k))
      col.set(k, Math.max(last, 1))
  const rateIn = new Map<string, number>()
  const rateOut = new Map<string, number>()
  for (const e of edges) {
    rateIn.set(e.to, (rateIn.get(e.to) ?? 0) + e.rate)
    rateOut.set(e.from, (rateOut.get(e.from) ?? 0) + e.rate)
  }
  const cols = new Map<number, string[]>()
  for (const [k, c] of col) cols.set(c, [...(cols.get(c) ?? []), k])
  const nodes: TrafficGraphNode[] = []
  let height = 0
  for (const [c, keys] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
    keys.sort((a, b) => {
      const pa = peers.get(a)
      const pb = peers.get(b)
      return `${pa?.ns ?? ''}/${pa?.name ?? ''}`.localeCompare(`${pb?.ns ?? ''}/${pb?.name ?? ''}`)
    })
    keys.forEach((k, i) => {
      const peer = peers.get(k)
      if (!peer) return
      nodes.push({
        id: k,
        peer,
        col: c,
        x: c * (NODE_W + COL_GAP),
        y: i * (NODE_H + ROW_GAP),
        w: NODE_W,
        h: NODE_H,
        inRate: rateIn.get(k) ?? 0,
        outRate: rateOut.get(k) ?? 0
      })
    })
    height = Math.max(height, keys.length * (NODE_H + ROW_GAP) - ROW_GAP)
  }
  // Canh giữa từng cột theo chiều dọc (đồ thị cân, đường ngắn hơn).
  for (const n of nodes) {
    const count = cols.get(n.col)?.length ?? 1
    n.y += (height - (count * (NODE_H + ROW_GAP) - ROW_GAP)) / 2
  }
  const maxCol = Math.max(0, ...nodes.map((n) => n.col))
  return { nodes, edges, width: (maxCol + 1) * (NODE_W + COL_GAP) - COL_GAP, height }
}
