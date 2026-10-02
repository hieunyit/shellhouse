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
 * (cột = số bước từ điểm vào, đích ngoài cluster ở cột cuối) — vòng gọi không kéo dãn bản đồ. Trong
 * cột sắp theo vị trí các bên nối tới (barycenter) để ít đường cắt nhau.
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
  const out = new Map<string, string[]>()
  const indeg = new Map<string, number>([...peers.keys()].map((k) => [k, 0]))
  for (const e of edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to])
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }
  // Cột = số bước gọi tính từ điểm vào (BFS từ các node không ai gọi tới). Không dùng đường dài
  // nhất: mesh gọi qua lại dày đặc sẽ thành chuỗi hàng chục cột; số bước thì luôn gọn.
  const col = new Map<string, number>()
  const sent = new Map<string, number>()
  for (const e of edges) sent.set(e.from, (sent.get(e.from) ?? 0) + e.rate)
  let queue = [...peers.keys()].filter((k) => (indeg.get(k) ?? 0) === 0)
  for (;;) {
    for (const k of queue) col.set(k, 0)
    while (queue.length) {
      const next: string[] = []
      for (const u of queue)
        for (const v of out.get(u) ?? [])
          if (!col.has(v)) {
            col.set(v, (col.get(u) ?? 0) + 1)
            next.push(v)
          }
      queue = next
    }
    // Phần chỉ toàn vòng (không có điểm vào): lấy node gửi nhiều nhất làm gốc.
    const rest = [...peers.keys()].filter((k) => !col.has(k))
    if (!rest.length) break
    rest.sort((x, y) => (sent.get(y) ?? 0) - (sent.get(x) ?? 0) || x.localeCompare(y))
    queue = rest.slice(0, 1)
  }
  // Đích ngoài cluster chỉ nhận (DB, API bên ngoài): cột cuối.
  const last = Math.max(0, ...col.values())
  for (const [k, p] of peers)
    if (p.kind === 'external' && (indeg.get(k) ?? 0) > 0 && !(out.get(k)?.length ?? 0))
      col.set(k, Math.max(last, 1))
  const rateIn = new Map<string, number>()
  const rateOut = new Map<string, number>()
  for (const e of edges) {
    rateIn.set(e.to, (rateIn.get(e.to) ?? 0) + e.rate)
    rateOut.set(e.from, (rateOut.get(e.from) ?? 0) + e.rate)
  }
  const maxCol = Math.max(0, ...col.values())
  const cols: string[][] = Array.from({ length: maxCol + 1 }, () => [])
  for (const [k, c] of col) cols[c]?.push(k)
  // Thứ tự trong cột: ban đầu theo namespace / tên; rồi vài lượt barycenter theo cột bên trái
  // và bên phải (đường ngắn, ít cắt nhau).
  const label = (k: string): string => {
    const p = peers.get(k)
    return `${p?.ns || '~'}/${p?.name ?? ''}`
  }
  for (const c of cols) c.sort((a, b) => label(a).localeCompare(label(b)))
  const pos = new Map<string, number>()
  const reindex = (): void => {
    for (const c of cols) c.forEach((k, i) => pos.set(k, i / Math.max(1, c.length - 1)))
  }
  reindex()
  const neighbours = new Map<string, string[]>()
  for (const e of edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to])
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from])
  }
  for (let pass = 0; pass < 4; pass++) {
    for (const c of cols) {
      const bary = new Map<string, number>()
      for (const k of c) {
        const ns = (neighbours.get(k) ?? []).filter((n) => col.get(n) !== col.get(k))
        bary.set(
          k,
          ns.length ? ns.reduce((n, x) => n + (pos.get(x) ?? 0), 0) / ns.length : (pos.get(k) ?? 0)
        )
      }
      c.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || label(a).localeCompare(label(b)))
    }
    reindex()
  }
  const nodes: TrafficGraphNode[] = []
  const height = Math.max(0, ...cols.map((c) => c.length * (NODE_H + ROW_GAP) - ROW_GAP))
  cols.forEach((keys, c) => {
    const offset = (height - (keys.length * (NODE_H + ROW_GAP) - ROW_GAP)) / 2
    keys.forEach((k, i) => {
      const peer = peers.get(k)
      if (!peer) return
      nodes.push({
        id: k,
        peer,
        col: c,
        x: c * (NODE_W + COL_GAP),
        y: offset + i * (NODE_H + ROW_GAP),
        w: NODE_W,
        h: NODE_H,
        inRate: rateIn.get(k) ?? 0,
        outRate: rateOut.get(k) ?? 0
      })
    })
  })
  return { nodes, edges, width: (maxCol + 1) * (NODE_W + COL_GAP) - COL_GAP, height }
}
