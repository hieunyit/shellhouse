import { t } from '@shared/i18n'
import {
  destLabel,
  type EgressDest,
  type EgressKind,
  type EgressRow,
  type EgressWorkloadRef
} from './egress'
import { LabelIndex, type MapData } from './map'
import {
  externalGroup,
  WORKLOAD_KIND_ID,
  type TrafficPeer,
  type TrafficRate,
  type TrafficUnit
} from './traffic'
import { hasKnownTld } from './tlds'

/**
 * "Connections": một workload nối tới đâu — ghép HAI nguồn về cùng một đích:
 *   khai báo  (env / args / ConfigMap / Secret: tên máy, cổng — xem egress.ts), và
 *   quan sát  (Caretta / Hubble: IP, cổng, tốc độ — xem traffic.ts).
 * Điều SRE cần là chỗ giao nhau:
 *   active      khai báo và đang có traffic
 *   idle        khai báo, đã thấy kết nối nhưng đang yên
 *   declared    khai báo nhưng KHÔNG thấy kết nối nào (cấu hình chết / đường dự phòng / chưa ai gọi)
 *   unknown     khai báo bằng tên máy nhưng không phân giải được để đối chiếu với IP quan sát
 *   unmeasured  khai báo, cluster không có nguồn traffic (Caretta / Hubble) nên không biết
 *   undeclared  có traffic tới đích không khai báo ở đâu (hardcode, phụ thuộc động, bất ngờ)
 * Thuần (renderer + Session Host + test dùng chung).
 */

export type ConnStatus = 'active' | 'idle' | 'declared' | 'unknown' | 'unmeasured' | 'undeclared'

export interface ConnObserved {
  /** Tổng tốc độ các kết nối khớp đích này (byte/s hoặc kết nối/s — xem `unit`). */
  rate: number
  unit?: TrafficUnit
  /** Cổng quan sát được (cổng của phía server). */
  ports: string[]
  /** Bên server như nguồn traffic báo: IP, tên DNS hoặc workload. */
  peers: string[]
}

export type ConnKind = EgressKind | 'workload'

export interface ConnectionRow {
  /** Khoá ổn định: workload + đích. */
  key: string
  workload: EgressWorkloadRef
  /** Đích đã phân loại (có khai báo); null = chỉ quan sát. */
  dest: EgressDest | null
  /** Nhãn hiển thị: host:port, ns/service:port, IP:port hoặc nhóm CIDR. */
  label: string
  kind: ConnKind
  /** Nơi khai báo; null = không khai báo. */
  declared: EgressRow['sources'] | null
  /** Quan sát được; null = không thấy (hoặc không có nguồn traffic). */
  observed: ConnObserved | null
  status: ConnStatus
  /** Cách ghép khai báo ↔ quan sát. */
  matchedBy?: 'workload' | 'ip' | 'name'
  /** Nhóm các IP chỉ-quan-sát cùng dải (10.152.0.0/16 (7)). */
  members?: ConnectionRow[]
  /** Nhiễu hệ thống (DNS, kube-system) — mặc định ẩn. */
  system?: boolean
}

export interface ConnectionsInput {
  declared: readonly EgressRow[]
  /** null = cluster không có nguồn traffic (Caretta / Hubble): không biết quan sát. */
  observed: readonly TrafficRate[] | null
  unit?: TrafficUnit | undefined
  /** Tên máy → các IP (phân giải từ máy này). Thiếu tên = chưa / không phân giải được. */
  resolved?: ReadonlyMap<string, readonly string[]>
  /** Service → workload phía sau; thiếu → không ghép được đích kiểu Service bằng workload. */
  data?: Pick<MapData, 'services' | 'workloads'> | undefined
  /** Chỉ workload này (chi tiết workload). */
  only?: EgressWorkloadRef | undefined
}

const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease'])
/** Dưới mức này là "idle": 1 B/s · 0,01 kết nối/s (cùng ngưỡng với bản đồ traffic). */
const idleBelow = (unit: TrafficUnit | undefined): number => (unit === 'connections' ? 0.01 : 1)
/** Gom từ chừng này IP chỉ-quan-sát cùng dải. */
export const GROUP_FROM = 3

const wkey = (w: EgressWorkloadRef): string => `${w.kind}|${w.ns}/${w.name}`
const isIp = (s: string): boolean => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(s) || s.includes(':')

function workloadOf(p: TrafficPeer): EgressWorkloadRef | null {
  const kind = WORKLOAD_KIND_ID[p.kind]
  return kind ? { kind, ns: p.ns, name: p.name } : null
}

interface Link {
  server: TrafficPeer
  port: string
  rate: number
}

/** Khớp một đích khai báo với một kết nối quan sát. */
function matches(
  d: EgressDest,
  l: Link,
  resolved: ReadonlyMap<string, readonly string[]> | undefined,
  backends: (svc: { ns: string; name: string }) => ReadonlySet<string>
): 'workload' | 'ip' | 'name' | null {
  const s = l.server
  if (d.kind === 'service' && d.service) {
    if (s.kind === 'Service' && s.ns === d.service.ns && s.name === d.service.name)
      return 'workload'
    const w = workloadOf(s)
    if (w && backends(d.service).has(wkey(w))) return 'workload'
    return null
  }
  if (s.kind !== 'external') return null
  const host = d.host.toLowerCase()
  const name = s.name.toLowerCase()
  // Cổng khai báo và cổng quan sát cùng biết mà khác nhau → không phải kết nối này.
  const portOk = d.port === undefined || !l.port || String(d.port) === l.port
  if (!portOk) return null
  if (name === host) return isIp(host) ? 'ip' : 'name'
  const ips = isIp(host) ? [host] : (resolved?.get(host) ?? [])
  return ips.includes(name) ? 'ip' : null
}

const sumRate = (links: readonly Link[]): number => links.reduce((n, l) => n + l.rate, 0)

function observedOf(links: readonly Link[], unit: TrafficUnit | undefined): ConnObserved {
  const ports = [...new Set(links.map((l) => l.port).filter(Boolean))].sort(
    (a, b) => Number(a) - Number(b)
  )
  const peers = [...new Set(links.map((l) => l.server.name))].sort()
  return { rate: sumRate(links), ...(unit ? { unit } : {}), ports, peers }
}

/** Tên máy công khai (có TLD thật, không phải hậu tố mạng riêng) — thứ đáng phân giải DNS. */
const PRIVATE_SUFFIX =
  /\.(internal|local|lan|corp|intranet|home|localdomain|svc|cluster|private|lab|priv|k8s|kube|docker)$/i
/** Tên có thể phân giải bằng DNS (không phải IP / một nhãn): gồm cả tên nội bộ khi người dùng cho phép. */
export function isResolvableHostname(host: string): boolean {
  return !isIp(host) && hasKnownTld(host)
}

export function isPublicHostname(host: string): boolean {
  return !isIp(host) && hasKnownTld(host) && !PRIVATE_SUFFIX.test(host)
}

export function buildConnections(input: ConnectionsInput): ConnectionRow[] {
  const { observed, unit, resolved } = input
  const only = input.only ? wkey(input.only) : null

  // Service → workload phía sau (chỉ dựng khi cần).
  const byNs = new Map<string, LabelIndex<MapData['workloads'][number]>>()
  const svcIndex = new Map((input.data?.services ?? []).map((s) => [`${s.ns}/${s.name}`, s]))
  const backendCache = new Map<string, Set<string>>()
  const backends = (svc: { ns: string; name: string }): ReadonlySet<string> => {
    const key = `${svc.ns}/${svc.name}`
    let set = backendCache.get(key)
    if (set) return set
    set = new Set()
    const s = svcIndex.get(key)
    if (s && Object.keys(s.selector).length > 0) {
      let idx = byNs.get(svc.ns)
      if (!idx) {
        idx = new LabelIndex((input.data?.workloads ?? []).filter((w) => w.ns === svc.ns))
        byNs.set(svc.ns, idx)
      }
      for (const w of idx.match(s.selector)) set.add(wkey(w))
    }
    backendCache.set(key, set)
    return set
  }

  const declaredBy = new Map<string, EgressRow[]>()
  for (const r of input.declared) {
    const k = wkey(r.workload)
    if (only && k !== only) continue
    const list = declaredBy.get(k)
    if (list) list.push(r)
    else declaredBy.set(k, [r])
  }
  const observedBy = new Map<string, { workload: EgressWorkloadRef; links: Link[] }>()
  for (const r of observed ?? []) {
    const w = workloadOf(r.client)
    if (!w) continue
    const k = wkey(w)
    if (only && k !== only) continue
    if (peerSelf(r.client, r.server)) continue
    const e = observedBy.get(k) ?? { workload: w, links: [] }
    e.links.push({ server: r.server, port: r.port, rate: r.rate })
    observedBy.set(k, e)
  }

  const rows: ConnectionRow[] = []
  const keys = new Set([...declaredBy.keys(), ...observedBy.keys()])
  for (const k of [...keys].sort()) {
    const decl = declaredBy.get(k) ?? []
    const obs = observedBy.get(k)
    const links = obs?.links ?? []
    const workload = decl[0]?.workload ?? obs?.workload
    if (!workload) continue
    const used = new Set<number>()

    for (const r of decl) {
      const hit: number[] = []
      let by: 'workload' | 'ip' | 'name' | null = null
      for (const [i, l] of links.entries()) {
        const m = matches(r.dest, l, resolved, backends)
        if (m) {
          hit.push(i)
          by ??= m
        }
      }
      hit.forEach((i) => used.add(i))
      const matched = hit.map((i) => links[i] as Link)
      let status: ConnStatus
      if (observed === null) status = 'unmeasured'
      else if (matched.length > 0) status = sumRate(matched) >= idleBelow(unit) ? 'active' : 'idle'
      else if (
        r.dest.kind !== 'service' &&
        !isIp(r.dest.host) &&
        !(resolved?.get(r.dest.host.toLowerCase())?.length ?? 0)
      )
        status = 'unknown'
      else status = 'declared'
      rows.push({
        key: `${k}>${r.dest.key}`,
        workload,
        dest: r.dest,
        label: r.dest.service
          ? `${r.dest.service.ns}/${r.dest.service.name}${r.dest.port !== undefined ? `:${String(r.dest.port)}` : ''}`
          : destLabel(r.dest),
        kind: r.dest.kind,
        declared: r.sources,
        observed: matched.length > 0 ? observedOf(matched, unit) : null,
        status,
        ...(by ? { matchedBy: by } : {})
      })
    }

    // Quan sát mà không khai báo ở đâu.
    const rest = links.filter((_, i) => !used.has(i))
    const singles = new Map<string, Link[]>()
    for (const l of rest) {
      const label = peerLabel(l)
      const list = singles.get(label)
      if (list) list.push(l)
      else singles.set(label, [l])
    }
    const undeclared: ConnectionRow[] = []
    for (const [label, ls] of singles) {
      const first = ls[0] as Link
      undeclared.push({
        key: `${k}>obs:${label}`,
        workload,
        dest: null,
        label,
        kind: first.server.kind === 'external' ? externalKind(first.server.name) : 'workload',
        declared: null,
        observed: observedOf(ls, unit),
        status: 'undeclared',
        ...(isSystem(first) ? { system: true } : {})
      })
    }
    rows.push(...groupByCidr(undeclared, workload, k))
  }
  return rows
}

const peerSelf = (c: TrafficPeer, s: TrafficPeer): boolean =>
  c.kind === s.kind && c.ns === s.ns && c.name === s.name

function peerLabel(l: Link): string {
  const s = l.server
  const base = s.kind === 'external' || !s.ns ? s.name : `${s.ns}/${s.name}`
  return l.port ? `${base}:${l.port}` : base
}

function externalKind(name: string): ConnKind {
  const p = name.split('.').map(Number)
  const [a = 0, b = 0] = p
  const priv =
    isIp(name) &&
    !name.includes(':') &&
    (a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127))
  return priv ? 'private' : 'external'
}

function isSystem(l: Link): boolean {
  return SYSTEM_NS.has(l.server.ns) || l.port === '53'
}

/** ≥ GROUP_FROM IP chỉ-quan-sát cùng /16 → một dòng "10.152.0.0/16 (7)" (mở ra thấy từng IP). */
function groupByCidr(
  rows: ConnectionRow[],
  workload: EgressWorkloadRef,
  k: string
): ConnectionRow[] {
  const ipRows = rows.filter(
    (r) => r.dest === null && r.kind !== 'workload' && isIp(r.label.split(':')[0] ?? '')
  )
  const groups = new Map<string, ConnectionRow[]>()
  for (const r of ipRows) {
    const cidr = externalGroup(r.label.split(':')[0] ?? '')
    const list = groups.get(cidr)
    if (list) list.push(r)
    else groups.set(cidr, [r])
  }
  const grouped = new Set<ConnectionRow>()
  const out: ConnectionRow[] = []
  for (const [cidr, list] of groups) {
    if (list.length < GROUP_FROM) continue
    list.forEach((r) => grouped.add(r))
    const rate = list.reduce((n, r) => n + (r.observed?.rate ?? 0), 0)
    const ports = [...new Set(list.flatMap((r) => r.observed?.ports ?? []))]
    out.push({
      key: `${k}>obs:${cidr}`,
      workload,
      dest: null,
      label: `${cidr} (${String(list.length)})`,
      kind: list[0]?.kind ?? 'external',
      declared: null,
      observed: {
        rate,
        ...(unitOfRows(list) ? { unit: unitOfRows(list) as TrafficUnit } : {}),
        ports,
        peers: list.flatMap((r) => r.observed?.peers ?? [])
      },
      status: 'undeclared',
      members: list,
      ...(list.every((r) => r.system) ? { system: true } : {})
    })
  }
  return [...rows.filter((r) => !grouped.has(r)), ...out]
}

const unitOfRows = (list: readonly ConnectionRow[]): TrafficUnit | undefined =>
  list[0]?.observed?.unit

/** Thứ tự ưu tiên khi liệt kê: điều bất thường trước. */
export const STATUS_ORDER: Record<ConnStatus, number> = {
  undeclared: 0,
  declared: 1,
  unknown: 2,
  unmeasured: 3,
  idle: 4,
  active: 5
}

/** Nhãn ngắn của trạng thái (đã dịch). */
export function connStatusLabel(s: ConnStatus): string {
  switch (s) {
    case 'active':
      return t('Active')
    case 'idle':
      return t('Idle')
    case 'declared':
      return t('Not seen')
    case 'unknown':
      return t("Can't tell")
    case 'unmeasured':
      return t('Not measured')
    case 'undeclared':
      return t('Undeclared')
  }
}

/** Trạng thái gộp của một đích có nhiều workload gọi tới: có workload đang active thì là active… */
export function aggregateStatus(list: readonly ConnStatus[]): ConnStatus {
  if (list.length === 0) return 'unmeasured'
  if (list.every((s) => s === 'undeclared')) return 'undeclared'
  const order: ConnStatus[] = ['active', 'idle', 'declared', 'unknown', 'unmeasured', 'undeclared']
  return order.find((o) => list.includes(o)) ?? 'unmeasured'
}

/**
 * "Hình dạng" của danh sách kết nối: mọi thứ TRỪ tốc độ (`observed.rate`). Topology chỉ dựng / xếp
 * lại khi hình dạng đổi (đích mới, trạng thái đổi, cổng / peer mới) — mỗi lần đo traffic (10 giây)
 * tốc độ được phủ lên thẻ và cạnh (`observedByKey` + `withObserved`), không dựng lại cả bản đồ.
 */
export function connectionShape(rows: readonly ConnectionRow[]): string {
  return JSON.stringify(rows, (key, value: unknown) => (key === 'rate' ? undefined : value))
}

/** Quan sát mới nhất theo `ConnectionRow.key` (chỉ hàng cấp trên — topology vẽ theo các hàng đó). */
export function observedByKey(rows: readonly ConnectionRow[]): Map<string, ConnObserved | null> {
  return new Map(rows.map((r) => [r.key, r.observed]))
}
