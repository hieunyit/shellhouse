/**
 * Traffic live từ Caretta (eBPF, groundcover): mỗi agent (DaemonSet) xuất metric Prometheus
 * `caretta_links_observed` = tổng byte đã thấy trên một kết nối client → server từ khi agent chạy.
 * Thuần (Session Host, renderer, test dùng chung): parse, gộp, tính tốc độ, băng lưu lượng cố định.
 */
import { t } from '@shared/i18n'
import { formatNumber, formatRate as formatBytesRate } from '@shared/i18n/format'

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

/** Nguồn số liệu traffic: Hubble (Cilium) hoặc Caretta. */
export type TrafficSource = 'hubble' | 'caretta'
/** Đơn vị của bộ đếm / tốc độ: byte (Caretta) hay số kết nối mới (Hubble không đếm byte). */
export type TrafficUnit = 'bytes' | 'connections'

export interface TrafficSample {
  /** unavailable = không có Caretta / Hubble hoặc không đọc được; ok = đã đọc. */
  status: 'unavailable' | 'ok'
  reason?: string
  /** Thiếu (bản cũ) = Caretta, byte. */
  source?: TrafficSource
  unit?: TrafficUnit
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
  /** Byte / giây (Caretta) hoặc kết nối mới / giây (Hubble — xem `unit`). */
  rate: number
  /** Thiếu = byte. */
  unit?: TrafficUnit
}

const unitOf = (s: TrafficSample): Pick<TrafficRate, 'unit'> =>
  s.unit === 'connections' ? { unit: 'connections' } : {}

/** Tốc độ giữa hai lần đọc; counter giảm (agent khởi động lại) → bỏ kết nối đó lần này. */
export function trafficRates(prev: TrafficSample, cur: TrafficSample): TrafficRate[] {
  const dt = (cur.at - prev.at) / 1000
  if (dt <= 0) return []
  const before = new Map(prev.links.map((l) => [linkKey(l), l.bytes]))
  const out: TrafficRate[] = []
  for (const l of cur.links) {
    const b = before.get(linkKey(l))
    if (b === undefined || l.bytes < b) continue
    out.push({
      client: l.client,
      server: l.server,
      port: l.port,
      rate: (l.bytes - b) / dt,
      ...unitOf(cur)
    })
  }
  return out
}

/**
 * Tốc độ trung bình trên cả cửa sổ mẫu (cũ → mới): mỗi kết nối lấy từ mẫu SỚM NHẤT mà chuỗi
 * counter của nó còn liền mạch (có mặt và không giảm tới mẫu mới nhất). Kết nối vừa xuất hiện có số
 * ngay ở lượt sau (không đợi hết cửa sổ); counter bị đặt lại giữa chừng chỉ tính phần sau lần đặt lại
 * — không bao giờ ra tốc độ âm hay vọt lên. Khoảng thời gian < 1 giây → bỏ (chia cho số quá nhỏ).
 */
export function windowRates(samples: readonly TrafficSample[]): TrafficRate[] {
  const latest = samples.at(-1)
  if (!latest || samples.length < 2) return []
  const older = samples.slice(0, -1).map((x) => ({
    at: x.at,
    bytes: new Map(x.links.map((l) => [linkKey(l), l.bytes]))
  }))
  const out: TrafficRate[] = []
  for (const l of latest.links) {
    const key = linkKey(l)
    let from: { at: number; bytes: number } | null = null
    let next = l.bytes
    for (let i = older.length - 1; i >= 0; i--) {
      const b = older[i]?.bytes.get(key)
      if (b === undefined || b > next) break
      from = { at: older[i]?.at ?? 0, bytes: b }
      next = b
    }
    if (!from) continue
    const dt = (latest.at - from.at) / 1000
    if (dt < 1) continue
    out.push({
      client: l.client,
      server: l.server,
      port: l.port,
      rate: (l.bytes - from.bytes) / dt,
      ...unitOf(latest)
    })
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

/** Băng theo số kết nối mới / giây (Hubble): cùng độ dày với băng byte tương ứng. */
export const CONNECTION_BANDS = [
  { max: 0.1, label: '< 0.1 conn/s', width: 1.5 },
  { max: 1, label: '0.1–1 conn/s', width: 2.5 },
  { max: 10, label: '1–10 conn/s', width: 3.5 },
  { max: 100, label: '10–100 conn/s', width: 5 },
  { max: 1_000, label: '100–1000 conn/s', width: 7 },
  { max: Number.POSITIVE_INFINITY, label: '> 1000 conn/s', width: 9 }
] as const

export function bandsFor(
  unit: TrafficUnit | undefined
): readonly { max: number; label: string; width: number }[] {
  return unit === 'connections' ? CONNECTION_BANDS : BANDS
}

export function bandOf(rate: number, unit?: TrafficUnit): number {
  const bands = bandsFor(unit)
  const i = bands.findIndex((b) => rate < b.max)
  return i < 0 ? bands.length - 1 : i
}

/**
 * Tốc độ theo locale (1.2 MB/s · 1,2 MB/s); dưới 1 B/s là "idle". Hubble: kết nối mới / giây
 * (0.4 conn/s); dưới 0.01 là "idle".
 */
export function formatRate(rate: number, unit?: TrafficUnit): string {
  if (unit === 'connections')
    return rate < 0.01 ? t('idle') : t('{n} conn/s', { n: formatNumber(rate, rate < 10 ? 1 : 0) })
  return rate < 1 ? t('idle') : formatBytesRate(rate)
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
//
// Cluster thật: hàng chục workload, hàng trăm địa chỉ ngoài cluster. Vẽ thẳng mọi cặp ra một mớ
// bùi nhùi — nên dựng theo phạm vi: workload của namespace đang chọn là node riêng; bên ngoài phạm
// vi gộp một node mỗi namespace; địa chỉ ngoài cluster gộp "External (N)" (mở ra theo /16 hay tên
// miền, rồi từng địa chỉ); đường idle ẩn (trừ khi tất cả đều idle); chỉ giữ N đường lớn nhất.

export type FlowNodeKind = 'peer' | 'namespace' | 'external' | 'more'

export interface FlowNode {
  id: string
  kind: FlowNodeKind
  /** Tên workload / namespace / địa chỉ / nhóm địa chỉ; '' = node gộp (giao diện tự đặt nhãn). */
  label: string
  ns: string
  /** Một bên cụ thể (workload, Pod, địa chỉ ngoài cluster đã mở ra). */
  peer?: TrafficPeer
  /** Các bên nằm trong node (node gộp: namespace, External, nhóm, "+N") kèm tốc độ của từng bên. */
  members: { peer: TrafficPeer; rate: number }[]
  /** Mở ra được (id của node nằm trong `expanded` khi mở). */
  expandable: boolean
  /** Node có được từ việc mở node này (để gập lại). */
  parent?: string
  /** Thuộc phạm vi đang xem (ngoài phạm vi: viền đứt, nhạt hơn). */
  scoped: boolean
  /** Workload trung tâm (chế độ focus của tab Traffic). */
  focus: boolean
  /** Node gộp theo hướng: in = bên gọi tới (trái), out = bên được gọi (phải). */
  side?: 'in' | 'out'
  /** Tổng byte / giây vào / ra (mọi đường của node, kể cả phần vượt top-N). */
  inRate: number
  outRate: number
  /** Có ít nhất một đường ≥ 1 B/s. */
  active: boolean
}

export interface FlowEdge {
  id: string
  from: string
  to: string
  rate: number
  ports: string[]
}

export interface FlowGraph {
  /** Node / đường được vẽ (top-N). */
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** Mọi node / đường sau khi gộp (cả phần vượt top-N) — bảng chi tiết dùng số đầy đủ. */
  allNodes: FlowNode[]
  allEdges: FlowEdge[]
  /** Số kết nối idle đang ẩn ("Show idle" tắt). */
  hiddenIdle: number
  /** Số đường vượt giới hạn top-N (nhỏ nhất bị bỏ). */
  hiddenMore: number
  /** Mọi kết nối trong phạm vi đều idle → vẫn vẽ cấu trúc (mờ), không để trống. */
  allIdle: boolean
  /** Số cặp kết nối trong phạm vi (trước khi lọc idle / top-N). */
  links: number
}

export interface FlowOptions {
  /** Namespace đang xem ([] = mọi namespace). */
  scope: readonly string[]
  /** Node gộp đang mở (id). */
  expanded?: ReadonlySet<string>
  showIdle?: boolean
  /** Tối đa chừng này đường (lớn nhất theo tốc độ). */
  limit?: number
  /** Chế độ focus: chỉ các đường của workload này (bên gọi trái, bên được gọi phải). */
  focus?: TrafficPeer
  /** Chế độ focus: mỗi bên tối đa chừng này node, phần còn lại gộp "+N". */
  perSide?: number
}

/** Mỗi bên có tới chừng này địa chỉ ngoài cluster thì vẽ riêng từng cái (ít thì gộp chẳng ích gì). */
export const EXTERNAL_INLINE = 4

const isExternal = (p: TrafficPeer): boolean => p.kind === 'external'

/** Nhóm địa chỉ ngoài cluster: IPv4 theo /16, IPv6 theo /32, tên DNS theo tên miền (example.com). */
export function externalGroup(name: string): string {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(name)
  if (v4) return `${v4[1] ?? ''}.${v4[2] ?? ''}.0.0/16`
  if (name.includes(':')) {
    const parts = name.split(':')
    return `${parts[0] || '0'}:${parts[1] || '0'}::/32`
  }
  const labels = name.toLowerCase().replace(/\.$/, '').split('.')
  if (labels.length <= 2) return labels.join('.')
  // Tên miền cấp hai theo quốc gia (example.com.vn, example.co.uk) giữ ba nhãn.
  const n = /^(com|net|org|co|gov|edu|ac)\.[a-z]{2}$/.test(labels.slice(-2).join('.')) ? 3 : 2
  return labels.slice(-n).join('.')
}

interface Pair {
  client: TrafficPeer
  server: TrafficPeer
  rate: number
  ports: Set<string>
}

function pairsOf(rates: readonly TrafficRate[]): Pair[] {
  const m = new Map<string, Pair>()
  for (const r of rates) {
    const ck = peerKey(r.client)
    const sk = peerKey(r.server)
    if (ck === sk) continue
    const key = `${ck}>${sk}`
    const prev = m.get(key)
    if (prev) {
      prev.rate += r.rate
      if (r.port) prev.ports.add(r.port)
    } else
      m.set(key, {
        client: r.client,
        server: r.server,
        rate: r.rate,
        ports: new Set(r.port ? [r.port] : [])
      })
  }
  return [...m.values()]
}

type Spec = Omit<FlowNode, 'members' | 'inRate' | 'outRate' | 'active'>

/** Tốc độ / phạm vi / gộp → đồ thị (chưa có toạ độ — xem `layoutFlow`). Hàm thuần. */
export function flowGraph(rates: readonly TrafficRate[], opts: FlowOptions): FlowGraph {
  const expanded = opts.expanded ?? new Set<string>()
  const focusKey = opts.focus ? peerKey(opts.focus) : null
  const inScope = (p: TrafficPeer): boolean =>
    focusKey !== null || !opts.scope.length || (!isExternal(p) && opts.scope.includes(p.ns))
  const scoped = pairsOf(rates).filter((r) =>
    focusKey
      ? peerKey(r.client) === focusKey || peerKey(r.server) === focusKey
      : inScope(r.client) || inScope(r.server)
  )
  const anyActive = scoped.some((r) => r.rate >= 1)
  const kept = opts.showIdle || !anyActive ? scoped : scoped.filter((r) => r.rate >= 1)

  // Địa chỉ ngoài cluster theo hướng (gọi tới / được gọi) và theo nhóm.
  const externals = { in: new Map<string, Set<string>>(), out: new Map<string, Set<string>>() }
  for (const r of kept)
    for (const [p, side] of [
      [r.client, 'in'],
      [r.server, 'out']
    ] as const)
      if (isExternal(p)) {
        const g = externalGroup(p.name)
        const set = externals[side].get(g) ?? new Set<string>()
        set.add(peerKey(p))
        externals[side].set(g, set)
      }
  const extCount = (side: 'in' | 'out'): number =>
    [...externals[side].values()].reduce((n, s) => n + s.size, 0)
  const aggregate = { in: extCount('in') > EXTERNAL_INLINE, out: extCount('out') > EXTERNAL_INLINE }

  const resolve = (p: TrafficPeer, side: 'in' | 'out'): Spec => {
    const base = { ns: p.ns, expandable: false, scoped: inScope(p), focus: false }
    if (focusKey && peerKey(p) === focusKey)
      return { ...base, id: `p:${focusKey}`, kind: 'peer', label: p.name, peer: p, focus: true }
    if (isExternal(p)) {
      const one: Spec = {
        ...base,
        id: `x:${side}:${peerKey(p)}`,
        kind: 'external',
        label: p.name,
        peer: p,
        side
      }
      if (!aggregate[side]) return one
      const top = `x:${side}`
      if (!expanded.has(top))
        return { ...base, id: top, kind: 'external', label: '', expandable: true, side }
      const g = externalGroup(p.name)
      const gid = `${top}:g:${g}`
      // Nhóm chỉ một địa chỉ: vẽ thẳng địa chỉ đó.
      if ((externals[side].get(g)?.size ?? 0) <= 1) return { ...one, parent: top }
      if (expanded.has(gid)) return { ...one, parent: gid }
      return {
        ...base,
        id: gid,
        kind: 'external',
        label: g,
        expandable: true,
        parent: top,
        side
      }
    }
    const peer: Spec = { ...base, id: `p:${peerKey(p)}`, kind: 'peer', label: p.name, peer: p }
    if (base.scoped) return peer
    const nid = `n:${p.ns}`
    if (expanded.has(nid)) return { ...peer, parent: nid }
    return { ...base, id: nid, kind: 'namespace', label: p.ns, expandable: true }
  }

  const specs = new Map<string, Spec>()
  const members = new Map<string, Map<string, { peer: TrafficPeer; rate: number }>>()
  const edgeMap = new Map<string, FlowEdge>()
  const note = (s: Spec, p: TrafficPeer, rate: number): void => {
    specs.set(s.id, s)
    const m = members.get(s.id) ?? new Map<string, { peer: TrafficPeer; rate: number }>()
    const k = peerKey(p)
    const prev = m.get(k)
    if (prev) prev.rate += rate
    else m.set(k, { peer: p, rate })
    members.set(s.id, m)
  }
  for (const r of kept) {
    const a = resolve(r.client, 'in')
    const b = resolve(r.server, 'out')
    if (a.id === b.id) continue
    note(a, r.client, r.rate)
    note(b, r.server, r.rate)
    const id = `${a.id}>${b.id}`
    const prev = edgeMap.get(id)
    if (prev) {
      prev.rate += r.rate
      for (const port of r.ports) if (!prev.ports.includes(port)) prev.ports.push(port)
    } else edgeMap.set(id, { id, from: a.id, to: b.id, rate: r.rate, ports: [...r.ports] })
  }
  let edges = [...edgeMap.values()]
  for (const e of edges) e.ports.sort((x, y) => Number(x) - Number(y) || x.localeCompare(y))

  // Focus: mỗi bên chỉ giữ vài node lớn nhất, phần còn lại gộp "+N" (mở ra được).
  if (focusKey && opts.perSide) {
    const fid = `p:${focusKey}`
    for (const side of ['in', 'out'] as const) {
      const mid = `m:${side}`
      if (expanded.has(mid)) continue
      const list = edges
        .filter((e) => (side === 'in' ? e.to === fid : e.from === fid))
        .sort((x, y) => y.rate - x.rate || x.id.localeCompare(y.id))
      if (list.length <= opts.perSide) continue
      const rest = list.slice(opts.perSide - 1)
      const drop = new Set(rest.map((e) => e.id))
      const m = new Map<string, { peer: TrafficPeer; rate: number }>()
      const ports: string[] = []
      for (const e of rest) {
        const other = side === 'in' ? e.from : e.to
        for (const [k, x] of members.get(other) ?? []) m.set(k, x)
        for (const port of e.ports) if (!ports.includes(port)) ports.push(port)
      }
      edges = edges.filter((e) => !drop.has(e.id))
      specs.set(mid, {
        id: mid,
        kind: 'more',
        label: '',
        ns: '',
        expandable: true,
        scoped: true,
        focus: false,
        side
      })
      members.set(mid, m)
      const rate = rest.reduce((n, e) => n + e.rate, 0)
      const id = side === 'in' ? `${mid}>${fid}` : `${fid}>${mid}`
      edges.push({
        id,
        from: side === 'in' ? mid : fid,
        to: side === 'in' ? fid : mid,
        rate,
        ports
      })
    }
  }

  // Tốc độ node: mọi đường (kể cả phần vượt top-N) — số trên thẻ là tổng thật.
  const rateIn = new Map<string, number>()
  const rateOut = new Map<string, number>()
  for (const e of edges) {
    rateIn.set(e.to, (rateIn.get(e.to) ?? 0) + e.rate)
    rateOut.set(e.from, (rateOut.get(e.from) ?? 0) + e.rate)
  }
  edges.sort((x, y) => y.rate - x.rate || x.id.localeCompare(y.id))
  const limit = opts.limit ?? Number.POSITIVE_INFINITY
  const shown = edges.slice(0, limit)
  const used = new Set(shown.flatMap((e) => [e.from, e.to]))
  if (focusKey) used.add(`p:${focusKey}`)
  const allNodes: FlowNode[] = []
  for (const [id, s] of specs) {
    if (!edges.some((e) => e.from === id || e.to === id) && !s.focus) continue
    const inRate = rateIn.get(id) ?? 0
    const outRate = rateOut.get(id) ?? 0
    allNodes.push({
      ...s,
      members: [...(members.get(id)?.values() ?? [])].sort(
        (x, y) =>
          y.rate - x.rate ||
          `${x.peer.ns}/${x.peer.name}`.localeCompare(`${y.peer.ns}/${y.peer.name}`)
      ),
      inRate,
      outRate,
      active: inRate >= 1 || outRate >= 1
    })
  }
  return {
    nodes: allNodes.filter((n) => used.has(n.id)),
    edges: shown,
    allNodes,
    allEdges: edges,
    hiddenIdle: scoped.length - kept.length,
    hiddenMore: edges.length - shown.length,
    allIdle: scoped.length > 0 && !anyActive,
    links: scoped.length
  }
}

export interface FlowLayoutOptions {
  nodeW: number
  nodeH: number
  colGap: number
  rowGap: number
  /** Cột dài hơn chừng này node → chia thành vài cột con (bản đồ không cao vô tận). */
  maxRows: number
  /** Bề ngang riêng theo cột (vd. workload trung tâm hẹp hơn); thiếu → nodeW. */
  colWidths?: readonly number[]
}

export interface FlowPlaced {
  id: string
  col: number
  x: number
  y: number
  w: number
  h: number
}

export interface FlowLayout {
  nodes: Map<string, FlowPlaced>
  width: number
  height: number
}

/** Bước gọi tối đa vẽ thành cột riêng (chuỗi dài hơn dồn vào cột cuối — mesh dày không kéo dãn). */
const MAX_DEPTH = 3

/**
 * Xếp trái → phải theo hướng gọi. Focus: bên gọi | workload | bên được gọi. Bản đồ: cột = đường
 * gọi dài nhất từ điểm vào (sau khi bỏ cạnh ngược của vòng, giữ cạnh lớn), tối đa MAX_DEPTH; bên
 * ngoài phạm vi chỉ nhận (DB, API ngoài, kube-system) ngay sau bên gọi xa nhất của nó. Trong cột
 * sắp theo barycenter để ít đường cắt nhau; ổn định giữa các lượt (cùng dữ liệu → cùng chỗ).
 */
export function layoutFlow(g: FlowGraph, o: FlowLayoutOptions): FlowLayout {
  const ids = g.nodes.map((n) => n.id)
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const out = new Map<string, FlowEdge[]>()
  const inc = new Map<string, FlowEdge[]>()
  for (const e of g.edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e])
    inc.set(e.to, [...(inc.get(e.to) ?? []), e])
  }
  const label = (id: string): string => {
    const n = byId.get(id)
    return `${n?.ns || '~'}/${n?.label ?? ''}/${id}`
  }
  const col = new Map<string, number>()
  const focus = g.nodes.find((n) => n.focus)
  if (focus) {
    for (const id of ids)
      col.set(id, id === focus.id ? 1 : (out.get(focus.id) ?? []).some((e) => e.to === id) ? 2 : 0)
  } else {
    // Bỏ cạnh ngược: DFS từ điểm vào (rồi node gửi nhiều nhất), đi cạnh lớn trước.
    const sent = (id: string): number => (out.get(id) ?? []).reduce((n, e) => n + e.rate, 0)
    const roots = [...ids].sort(
      (x, y) =>
        Number((inc.get(x)?.length ?? 0) > 0) - Number((inc.get(y)?.length ?? 0) > 0) ||
        sent(y) - sent(x) ||
        label(x).localeCompare(label(y))
    )
    const state = new Map<string, 1 | 2>()
    const forward: FlowEdge[] = []
    const visit = (u: string): void => {
      state.set(u, 1)
      const list = [...(out.get(u) ?? [])].sort(
        (x, y) => y.rate - x.rate || x.to.localeCompare(y.to)
      )
      for (const e of list) {
        const s = state.get(e.to)
        if (s === 1) continue
        forward.push(e)
        if (!s) visit(e.to)
      }
      state.set(u, 2)
    }
    for (const r of roots) if (!state.has(r)) visit(r)
    // Đường dài nhất trên DAG còn lại (thứ tự topo bằng Kahn).
    const indeg = new Map(ids.map((id) => [id, 0]))
    const fwdOut = new Map<string, string[]>()
    for (const e of forward) {
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
      fwdOut.set(e.from, [...(fwdOut.get(e.from) ?? []), e.to])
    }
    const depth = new Map(ids.map((id) => [id, 0]))
    const queue = ids.filter((id) => !indeg.get(id))
    while (queue.length) {
      const u = queue.shift() ?? ''
      for (const v of fwdOut.get(u) ?? []) {
        depth.set(v, Math.max(depth.get(v) ?? 0, (depth.get(u) ?? 0) + 1))
        const d = (indeg.get(v) ?? 1) - 1
        indeg.set(v, d)
        if (!d) queue.push(v)
      }
    }
    for (const id of ids) col.set(id, Math.min(MAX_DEPTH, depth.get(id) ?? 0))
    // Bên gọi tới từ ngoài cluster luôn ở cột đầu.
    const sink = (id: string): boolean => {
      const n = byId.get(id)
      return !!n && !(out.get(id)?.length ?? 0) && (!n.scoped || n.kind === 'external')
    }
    for (const id of ids) if (byId.get(id)?.side === 'in') col.set(id, 0)
    // Đích chỉ nhận: ngay sau bên gọi xa nhất của nó (không dồn hết về một cột cuối — đường
    // không phải chạy ngầm dưới các thẻ ở giữa, bản đồ cũng hẹp hơn).
    for (const id of ids)
      if (sink(id))
        col.set(
          id,
          Math.max(
            1,
            ...(inc.get(id) ?? []).map((e) => (sink(e.from) ? 0 : (col.get(e.from) ?? 0)) + 1)
          )
        )
  }
  const maxCol = Math.max(0, ...col.values())
  const cols: string[][] = Array.from({ length: maxCol + 1 }, () => [])
  for (const id of ids) cols[col.get(id) ?? 0]?.push(id)
  const neighbours = new Map<string, string[]>()
  for (const e of g.edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to])
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from])
  }
  const rateOf = (id: string): number => {
    const n = byId.get(id)
    return (n?.inRate ?? 0) + (n?.outRate ?? 0)
  }
  if (focus) {
    // Focus: lớn nhất trên cùng; "+N" luôn cuối.
    for (const c of cols)
      c.sort(
        (a, b) =>
          Number(byId.get(a)?.kind === 'more') - Number(byId.get(b)?.kind === 'more') ||
          rateOf(b) - rateOf(a) ||
          label(a).localeCompare(label(b))
      )
  } else {
    // Ban đầu: trong phạm vi trước, theo namespace / tên; rồi vài lượt barycenter.
    for (const c of cols)
      c.sort(
        (a, b) =>
          Number(!byId.get(a)?.scoped) - Number(!byId.get(b)?.scoped) ||
          label(a).localeCompare(label(b))
      )
    const pos = new Map<string, number>()
    const reindex = (): void => {
      for (const c of cols) c.forEach((k, i) => pos.set(k, i / Math.max(1, c.length - 1)))
    }
    reindex()
    for (let pass = 0; pass < 6; pass++) {
      for (const c of cols) {
        const bary = new Map<string, number>()
        for (const k of c) {
          const ns = (neighbours.get(k) ?? []).filter((n) => col.get(n) !== col.get(k))
          bary.set(
            k,
            ns.length
              ? ns.reduce((n, x) => n + (pos.get(x) ?? 0), 0) / ns.length
              : (pos.get(k) ?? 0)
          )
        }
        c.sort(
          (a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || label(a).localeCompare(label(b))
        )
      }
      reindex()
    }
  }
  // Cột dài → chia cột con (đều nhau), cột con sát nhau hơn khoảng cách giữa các bước gọi.
  const blocks = cols.map((c) => {
    const parts = Math.max(1, Math.ceil(c.length / o.maxRows))
    const rows = Math.ceil(c.length / parts)
    return { ids: c, parts: c.length ? parts : 1, rows }
  })
  const pitch = o.nodeH + o.rowGap
  const height = Math.max(0, ...blocks.map((b) => b.rows * pitch - o.rowGap))
  const subGap = Math.round(o.colGap * 0.35)
  const nodes = new Map<string, FlowPlaced>()
  let x = 0
  blocks.forEach((b, c) => {
    const w = o.colWidths?.[c] ?? o.nodeW
    for (let part = 0; part < b.parts; part++) {
      const chunk = b.ids.slice(part * b.rows, (part + 1) * b.rows)
      const offset = (height - (chunk.length * pitch - o.rowGap)) / 2
      chunk.forEach((id, i) => {
        nodes.set(id, { id, col: c, x, y: offset + i * pitch, w, h: o.nodeH })
      })
      x += w + (part < b.parts - 1 ? subGap : o.colGap)
    }
  })
  return { nodes, width: Math.max(0, x - o.colGap), height }
}
