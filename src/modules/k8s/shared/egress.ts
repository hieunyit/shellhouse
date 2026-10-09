import type { MapData, MapService } from './map'
import { hasKnownTld } from './tlds'

/**
 * Kết nối ra ngoài "khai báo" của workload: điểm đến (host / IP + cổng) tìm thấy trong biến môi
 * trường, tham số, ConfigMap và Secret mà pod template dùng — không cần traffic. Thuần (Session Host,
 * renderer, test dùng chung). Không bao giờ giữ lại phần đăng nhập / mật khẩu trong chuỗi kết nối:
 * chỉ host, cổng và scheme.
 */

/** Nguồn của một điểm đến. */
export type EgressSource = 'env' | 'args' | 'configmap' | 'secret'

export interface EgressWorkloadRef {
  /** Id loại: deployments.apps, statefulsets.apps… */
  kind: string
  ns: string
  name: string
}

/** Một điểm đến tìm thấy (chưa phân loại). */
export interface EgressItem {
  workload: EgressWorkloadRef
  source: EgressSource
  /** Tên ConfigMap / Secret (env / args: rỗng hoặc tên biến). */
  via: string
  /** Tên biến, khoá trong ConfigMap / Secret, hoặc cờ dòng lệnh. */
  key: string
  host: string
  port?: number
  /** postgres, https, redis… (nếu chuỗi có scheme). */
  scheme?: string
  /** Cổng suy ra từ scheme (https → 443), không ghi trong cấu hình. */
  portImplied?: boolean
}

export interface EgressResult {
  items: EgressItem[]
  /** ConfigMap / Secret không đọc được (thiếu quyền, lỗi API) hoặc bị bỏ vì quá nhiều. */
  skipped: { configMaps: number; secrets: number; denied: number }
  /** Số workload đã quét / tổng (bị cắt khi quá lớn). */
  scanned: number
  truncated: boolean
  /** Đã thử đọc Secret không. */
  readSecrets: boolean
  /** Số loại workload không list được (thiếu quyền) — danh sách có thể thiếu. */
  listDenied?: number
  /** Service ngoài phạm vi Map mà cấu hình nhắc tới (hoặc, ở chế độ một workload, mọi Service cần để phân loại). */
  services?: { ns: string; name: string; type: string; clusterIP?: string; externalName?: string }[]
}

export interface RawEndpoint {
  host: string
  port?: number
  scheme?: string
  portImplied?: boolean
}

/** Cổng mặc định của vài scheme phổ biến (khi chuỗi không ghi cổng). */
export const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  postgres: 5432,
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  redis: 6379,
  rediss: 6379,
  mongodb: 27017,
  amqp: 5672,
  amqps: 5671,
  kafka: 9092,
  nats: 4222,
  ldap: 389,
  ldaps: 636,
  smtp: 25,
  smtps: 465,
  ftp: 21,
  sftp: 22,
  ssh: 22,
  grpc: 80,
  grpcs: 443,
  clickhouse: 9000,
  memcached: 11211,
  elasticsearch: 9200,
  sqlserver: 1433,
  oracle: 1521
}

const HOST_CHARS = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?'
const IPV4 = '(?:\\d{1,3}\\.){3}\\d{1,3}'
const HOST_PORT = new RegExp(`^(\\[[0-9A-Fa-f:.]+\\]|${HOST_CHARS})(?::(\\d{1,5}))?$`)
const URL_RE =
  /(?<![\w+.-])([a-z][a-z0-9+.-]{1,24}):\/\/((?:[^\s/?#@'"`<>)\]\\]*@)?(?:\[[0-9A-Fa-f:.]+\](?::\d{1,5})?|[^\s/?#'"`<>)\]\\]+))/gi
const BARE_RE = new RegExp(
  `(?<![\\w.@/:%$-])(${IPV4}|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+):(\\d{1,5})(?![\\w.])`,
  'g'
)
/** `host=db port=5432`, `Server=tcp:db.example.com,1433;…` (libpq, ADO.NET, MySQL…). */
const KV_HOST_RE =
  /(?:^|[;\s,&])(?:host|hostname|server|data source|address|addr|endpoint|hosts)\s*=\s*(?:tcp:|np:)?\s*(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*[,:]\s*(\d{1,5}))?/gi
const KV_PORT_RE = /(?:^|[;\s,&])port\s*=\s*(\d{1,5})/i
const SKIP_HOST = /^(localhost(\.localdomain)?|0\.0\.0\.0|127(\.\d{1,3}){3}|\[?::1?\]?)$/i
/** Scheme của kho object / tệp / ảnh: phần "host" là tên bucket hay đường dẫn, không phải máy chủ. */
const NON_NETWORK_SCHEME =
  /^(s3[an]?|gs|gcs|abfss?|wasbs?|az|oss|cos|file|unix|docker|oci|data|mailto|tel|git\+file)$/i
/** Giá trị cấu hình không phải tên máy ("true", "default"…). */
const KEYWORD =
  /^(true|false|yes|no|on|off|none|null|nil|nan|default|enabled?|disabled?|auto|any|all|local|internal|external|public|private|primary|secondary|master|replica|slave|main|prod|production|stage|staging|dev|development|test)$/i
/**
 * Khoá gợi ý "đây là địa chỉ": từ gợi ý phải đứng CUỐI tên (EMAIL_HOST, DB_URL…). "EMAIL_HOST_PASSWORD"
 * có chữ HOST nhưng là mật khẩu — không được coi là địa chỉ.
 */
const HOSTY_KEY =
  /(^|[_.\-/])(host|hostname|hosts|addr|address|addrs|server|servers|endpoint|endpoints|broker|brokers|url|urls|uri|dsn|connection|connstr|conn|target|upstream|backend|registry|proxy|api|remote|master|primary|replica)$/i
/** Khoá chặt hơn: đủ chắc để nhận cả tên chỉ một nhãn ("redis", "mysql"). */
const STRICT_HOSTY_KEY =
  /(^|[_.\-/])(host|hostname|hosts|addr|address|addrs|server|servers|endpoint|endpoints|broker|brokers|url|urls|uri|dsn)$/i
/** Khoá nói về bí mật: giá trị của nó không bao giờ là điểm đến (trừ khi là URL / host= rõ ràng). */
const SECRETISH_KEY =
  /(pass(word|wd|phrase)?|pwd|secret|token|credentials?|creds?|salt|signing|private[_-]?key|api[_-]?key|access[_-]?key|jwt)/i
/** Chuỗi một nhãn trông như token / mật khẩu ngẫu nhiên (dài, lẫn chữ và số) — không phải tên máy. */
const looksRandom = (host: string): boolean =>
  !host.includes('.') &&
  (host.length > 40 || (host.length >= 16 && /\d/.test(host) && /[a-z]/i.test(host)))

const validPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535

function ipv4Valid(host: string): boolean {
  const m = new RegExp(`^${IPV4}$`).test(host)
  return m && host.split('.').every((p) => Number(p) <= 255)
}

/** `host[:port]` đã tách; null nếu không phải địa chỉ dùng được. */
function parseHostPort(text: string): { host: string; port?: number } | null {
  const m = HOST_PORT.exec(text.trim())
  if (!m) return null
  const host = (m[1] ?? '').replace(/^\[|\]$/g, '')
  if (!host || SKIP_HOST.test(host) || /^\d+$/.test(host)) return null
  if (/^[\d.]+$/.test(host) && !ipv4Valid(host)) return null
  const port = m[2] ? Number(m[2]) : undefined
  if (port !== undefined && !validPort(port)) return null
  return { host: host.toLowerCase(), ...(port !== undefined ? { port } : {}) }
}

/** jdbc:postgresql://… → postgresql://… ; jdbc:oracle:thin:@//h:1521/s → oracle://h:1521/s */
const unJdbc = (v: string): string =>
  v
    .replace(/\bjdbc:oracle:thin:@\/{0,2}/gi, 'oracle://')
    .replace(/\bjdbc:([a-z0-9]+):(?=\/\/)/gi, '$1:')

/** Đuôi file / tài liệu: "config.yaml" không phải tên máy. */
const FILE_LIKE =
  /\.(?:js|mjs|cjs|ts|py|rb|json|ya?ml|sh|conf|cfg|ini|txt|log|so|jar|md|xml|html?|crt|pem|key)$/i

export interface EndpointOptions {
  /**
   * Giá trị từ Secret: chỉ nhận dạng có dấu hiệu rõ ràng (scheme://, host=…, khoá là địa chỉ). Không
   * nhận "host:port" trần nằm trong văn bản — một mật khẩu trông như "abc.def:1234" không được lộ
   * thành điểm đến.
   */
  strict?: boolean
}

/** Dòng "khoá: giá trị" / "khoá=giá trị" / `"khoá": "giá trị"` của tệp cấu hình (YAML, .properties, JSON). */
const LINE_RE = /^\s*(?:-\s*)?["']?([A-Za-z0-9_.-]{1,64})["']?\s*[:=]\s*(.*?)\s*,?\s*$/
const unquote = (v: string): string => v.replace(/^(["'])(.*)\1$/s, '$2')
const PORT_KEY = /(^|[_.-])port$/i

/** Tệp cấu hình nhiều dòng: từng dòng là một cặp khoá / giá trị; host ghép với `port` cùng khối. */
function textEndpoints(value: string, opts: EndpointOptions): RawEndpoint[] {
  const lines = value.split('\n').slice(0, 400)
  const parsed = lines.map((raw) => {
    const m = LINE_RE.exec(raw)
    const indent = raw.length - raw.trimStart().length
    return m
      ? { key: m[1] ?? '', value: unquote(m[2] ?? ''), indent }
      : { key: '', value: raw.trim(), indent }
  })
  const portOf = (v: string): number | undefined => {
    const n = Number(v)
    return /^\d{1,5}$/.test(v) && validPort(n) ? n : undefined
  }
  const out: RawEndpoint[] = []
  parsed.forEach((line, i) => {
    for (const ep of endpointsIn(line.value, line.key, opts)) {
      if (ep.port === undefined && !ep.scheme && line.key) {
        // 1) cùng tiền tố khoá: db.host ↔ db.port, DB_HOST ↔ DB_PORT (khoá chỉ là "host" thì không
        //    đủ để biết cổng nào — xem 2 và 3).
        const word = /(host(name)?|addr(ess)?|server|endpoint)$/i.exec(line.key)
        const prefixed = Boolean(word && word.index > 0)
        const portKey = line.key.replace(/(host(name)?|addr(ess)?|server|endpoint)$/i, (m) =>
          m === m.toUpperCase() ? 'PORT' : m[0] === m[0]?.toUpperCase() ? 'Port' : 'port'
        )
        const portLine = prefixed ? parsed.find((x) => x.key === portKey) : undefined
        let found = portLine ? portOf(portLine.value) : undefined
        // 2) YAML lồng nhau: dòng `port` cùng mức thụt lề trong cùng khối (dừng khi hết khối).
        if (found === undefined && line.indent > 0) {
          for (const dir of [1, -1]) {
            for (let j = i + dir; parsed[j]; j += dir) {
              const near = parsed[j]
              if (!near || near.indent < line.indent) break
              if (near.indent > line.indent) continue
              if (PORT_KEY.test(near.key)) {
                found = portOf(near.value)
                break
              }
              if (near.key && endpointsIn(near.value, near.key, opts).length > 0) break
            }
            if (found !== undefined) break
          }
        }
        // 3) tệp phẳng chỉ có một host và một port → ghép với nhau.
        if (found === undefined && line.indent === 0) {
          const ports = parsed.filter((x) => PORT_KEY.test(x.key) && portOf(x.value) !== undefined)
          const hosts = parsed.filter(
            (x) => x.key && endpointsIn(x.value, x.key, opts).some((e) => e.port === undefined)
          )
          if (ports.length === 1 && hosts.length === 1) found = portOf(ports[0]?.value ?? '')
        }
        if (found !== undefined) ep.port = found
      }
      out.push(ep)
    }
  })
  return out
}

/**
 * Điểm đến trong một giá trị chuỗi. `keyHint` = tên biến / khoá: cho phép nhận giá trị chỉ có host
 * ("db.internal") hoặc "name:port" không có dấu chấm ("redis:6379") khi tên gợi ý là địa chỉ.
 */
export function endpointsIn(
  value: string,
  keyHint = '',
  opts: EndpointOptions = {}
): RawEndpoint[] {
  const out: RawEndpoint[] = []
  const seen = new Set<string>()
  const add = (e: RawEndpoint): void => {
    const k = `${e.host}|${e.port ?? ''}`
    if (seen.has(k)) return
    seen.add(k)
    out.push(e)
  }
  if (value.length > 4096) value = value.slice(0, 4096)
  if (value.includes('\n')) return textEndpoints(value, opts)
  const text = unJdbc(value)

  // 1) scheme://[user:pass@]host[:port][,host2[:port]]/…
  let rest = text
  for (const m of text.matchAll(URL_RE)) {
    const scheme = (m[1] ?? '').toLowerCase()
    rest = rest.replace(m[0], ' ')
    if (NON_NETWORK_SCHEME.test(scheme)) continue
    let authority = m[2] ?? ''
    const at = authority.lastIndexOf('@')
    if (at >= 0) authority = authority.slice(at + 1)
    // sqlserver://host:1433;databaseName=x — phần sau dấu ; là tham số.
    authority = authority.split(';')[0] ?? ''
    for (const part of authority.split(',')) {
      const hp = parseHostPort(part)
      if (!hp) continue
      const implied = hp.port === undefined ? DEFAULT_PORTS[scheme.split('+')[0] ?? ''] : undefined
      add({
        host: hp.host,
        scheme,
        ...(hp.port !== undefined
          ? { port: hp.port }
          : implied !== undefined
            ? { port: implied, portImplied: true }
            : {})
      })
    }
  }

  // 2) host=…; port=… (libpq, ADO.NET, MySQL)
  if (out.length === 0) {
    const kvPort = KV_PORT_RE.exec(rest)?.[1]
    for (const m of rest.matchAll(KV_HOST_RE)) {
      const hp = parseHostPort(`${m[1] ?? ''}${m[2] ? `:${m[2]}` : kvPort ? `:${kvPort}` : ''}`)
      if (hp && !FILE_LIKE.test(hp.host) && !KEYWORD.test(hp.host))
        add({ host: hp.host, ...(hp.port !== undefined ? { port: hp.port } : {}) })
    }
    if (seen.size > 0) return out
  }

  // Nhận diện theo HÌNH DẠNG giá trị, không dựa vào tên biến. Tên biến chỉ là tín hiệu phụ cho các
  // dạng mơ hồ (một nhãn "redis", IP trần không cổng) và để loại giá trị của khoá nói về bí mật.
  const secretish = SECRETISH_KEY.test(keyHint)
  /** Địa chỉ "chắc": IPv4 hợp lệ hoặc tên miền có TLD thật — hiếm khi là mật khẩu / tên file. */
  const strong = (host: string): boolean => ipv4Valid(host) || hasKnownTld(host)

  // 3) host:port nằm trong văn bản. Chắc (IP / TLD thật) → luôn nhận; chỉ có dấu chấm (db.prod.myco:5432)
  //    → nhận trừ khi là Secret hoặc khoá nói về bí mật.
  for (const m of rest.matchAll(BARE_RE)) {
    const hp = parseHostPort(`${m[1] ?? ''}:${m[2] ?? ''}`)
    if (!hp || FILE_LIKE.test(hp.host)) continue
    if (strong(hp.host) || (!opts.strict && !secretish))
      add({ host: hp.host, ...(hp.port !== undefined ? { port: hp.port } : {}) })
  }

  // 4) cả giá trị là địa chỉ hoặc danh sách địa chỉ ("db.corp:5432", "k1:9092,k2:9092", "api.stripe.com")
  const whole = rest.trim().replace(/^["']|["']$/g, '')
  if (out.length === 0 && whole && !/\s/.test(whole)) {
    for (const token of whole.split(/[,;]/)) {
      const hp = parseHostPort(token.replace(/^["']|["']$/g, ''))
      if (!hp || FILE_LIKE.test(hp.host) || KEYWORD.test(hp.host) || looksRandom(hp.host)) continue
      const dotted = hp.host.includes('.')
      const hosty = (opts.strict ? STRICT_HOSTY_KEY : HOSTY_KEY).test(keyHint)
      let ok: boolean
      if (dotted && strong(hp.host)) {
        // IP trần (không cổng) giống số phiên bản ("1.2.3.4") → cần khoá địa chỉ; còn lại tự chứng tỏ.
        ok =
          hp.port !== undefined || !ipv4Valid(hp.host)
            ? !secretish || hp.port !== undefined
            : hosty && !secretish
      } else if (dotted) ok = !secretish && (hp.port !== undefined ? !opts.strict || hosty : hosty)
      else ok = !secretish && STRICT_HOSTY_KEY.test(keyHint) && hp.host.length >= 2
      if (ok) add({ host: hp.host, ...(hp.port !== undefined ? { port: hp.port } : {}) })
    }
  }
  return out
}

/**
 * Điểm đến của một nhóm cặp khoá → giá trị (env của một container, dữ liệu một ConfigMap…): ghép
 * `X_HOST` với `X_PORT` khi giá trị chỉ có host.
 */
export function endpointsInEntries(
  entries: readonly { key: string; value: string }[],
  opts: EndpointOptions = {}
): { key: string; endpoint: RawEndpoint }[] {
  const byKey = new Map(entries.map((e) => [e.key, e.value]))
  const out: { key: string; endpoint: RawEndpoint }[] = []
  for (const { key, value } of entries) {
    for (const ep of endpointsIn(value, key, opts)) {
      if (ep.port === undefined && !ep.scheme) {
        const portKey = key.replace(/(host(name)?|addr(ess)?|server|endpoint)/i, (m) =>
          m === m.toUpperCase() ? 'PORT' : m[0] === m[0]?.toUpperCase() ? 'Port' : 'port'
        )
        const raw = portKey !== key ? byKey.get(portKey) : undefined
        const port = raw && /^\d{1,5}$/.test(raw.trim()) ? Number(raw) : NaN
        if (validPort(port)) ep.port = port
      }
      out.push({ key, endpoint: ep })
    }
  }
  return out
}

/** Dòng lệnh → cặp khoá / giá trị: `--host=db`, `--host db`, `-h db`, và từng đối số. */
export function argEntries(args: readonly string[]): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const eq = /^(--?[A-Za-z][\w.-]*)=(.*)$/s.exec(a)
    if (eq) out.push({ key: (eq[1] ?? '').replace(/^-+/, ''), value: eq[2] ?? '' })
    else if (
      /^--?[A-Za-z][\w.-]*$/.test(a) &&
      i + 1 < args.length &&
      !/^-/.test(args[i + 1] ?? '')
    ) {
      out.push({ key: a.replace(/^-+/, ''), value: args[i + 1] ?? '' })
      i++ // giá trị đã đi cùng cờ — không xét lần nữa như đối số rời
    } else out.push({ key: '', value: a })
  }
  return out
}

// ——— Phân loại ———

export type EgressKind =
  /** Service trong cluster (tên DNS nội bộ / ClusterIP). */
  | 'service'
  /** Địa chỉ ngoài cluster: tên miền ngoài hoặc IP công khai. */
  | 'external'
  /** IP riêng không phải của Service / pod nào trong cluster (VM, DB nội bộ, VPC…). */
  | 'private'
  /** IP của một pod trong cluster. */
  | 'pod'
  /** Tên ngắn không khớp Service nào. */
  | 'unresolved'

export interface EgressDest {
  /** Khoá gộp: loại + host + cổng. */
  key: string
  kind: EgressKind
  host: string
  port?: number
  scheme?: string
  portImplied?: boolean
  /** kind=service: Service đích. */
  service?: { ns: string; name: string }
  /** kind=external qua Service ExternalName: Service đã dùng để gọi (host là tên bên ngoài). */
  viaService?: { ns: string; name: string }
}

const isPrivateIp = (ip: string): boolean => {
  const p = ip.split('.').map(Number)
  const [a = 0, b = 0] = p
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 169
  )
}

export interface EgressIndex {
  services: Map<string, MapService>
  byClusterIp: Map<string, MapService>
  podIps: Set<string>
}

export function indexEgress(data: Pick<MapData, 'services' | 'pods'>): EgressIndex {
  const services = new Map<string, MapService>()
  const byClusterIp = new Map<string, MapService>()
  for (const s of data.services) {
    services.set(`${s.ns}/${s.name}`, s)
    if (s.clusterIP && s.clusterIP !== 'None') byClusterIp.set(s.clusterIP, s)
  }
  const podIps = new Set<string>()
  for (const p of data.pods) if (p.ip) podIps.add(p.ip)
  return { services, byClusterIp, podIps }
}

/** Điểm đến thuộc loại nào, nhìn từ namespace `ns` của workload. */
export function classifyEndpoint(
  ep: RawEndpoint,
  ns: string,
  ix: EgressIndex
): Omit<EgressDest, 'key'> {
  const base = {
    host: ep.host,
    ...(ep.port !== undefined ? { port: ep.port } : {}),
    ...(ep.scheme ? { scheme: ep.scheme } : {}),
    ...(ep.portImplied ? { portImplied: true } : {})
  }
  const svcDest = (s: MapService): Omit<EgressDest, 'key'> =>
    // ExternalName: Service chỉ là tên khác của một địa chỉ ngoài cluster → đích thật là địa chỉ đó.
    s.type === 'ExternalName' && s.externalName
      ? {
          ...base,
          host: s.externalName.toLowerCase().replace(/\.$/, ''),
          kind: 'external',
          viaService: { ns: s.ns, name: s.name }
        }
      : { ...base, kind: 'service', service: { ns: s.ns, name: s.name } }
  const host = ep.host.replace(/\.$/, '')
  const labels = host.split('.')
  // IPv6: fc00::/7 (ULA) và fe80::/10 (link-local) là mạng riêng; còn lại coi là ngoài.
  if (host.includes(':'))
    return {
      ...base,
      kind: /^(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(host) ? 'private' : 'external'
    }
  // [pod.]service.ns.svc[.cluster.local] — gồm cả pod của StatefulSet qua headless Service.
  const svc = /^(?:([a-z0-9-]+)\.)?([a-z0-9-]+)\.([a-z0-9-]+)\.svc(?:\.[a-z0-9.-]+)?$/.exec(host)
  if (svc) {
    const s = ix.services.get(`${svc[3]}/${svc[2]}`)
    return s ? svcDest(s) : { ...base, kind: 'unresolved' }
  }
  // 10-42-0-5.ns.pod.cluster.local
  if (/^[a-z0-9-]+\.[a-z0-9-]+\.pod(?:\.[a-z0-9.-]+)?$/.test(host)) return { ...base, kind: 'pod' }
  if (labels.length === 1 && !/^\d+$/.test(host)) {
    const s = ix.services.get(`${ns}/${host}`)
    return s ? svcDest(s) : { ...base, kind: 'unresolved' }
  }
  if (labels.length === 2 && !/^\d+$/.test(labels[1] ?? '')) {
    // name.ns (dạng rút gọn); nếu không có Service như vậy → tên miền ngoài
    const s = ix.services.get(`${labels[1]}/${labels[0]}`)
    if (s) return svcDest(s)
  }
  if (ipv4Valid(host)) {
    const s = ix.byClusterIp.get(host)
    if (s) return svcDest(s)
    if (ix.podIps.has(host)) return { ...base, kind: 'pod' }
    return { ...base, kind: isPrivateIp(host) ? 'private' : 'external' }
  }
  return { ...base, kind: 'external' }
}

export interface EgressRow {
  /** Khoá ổn định: workload + đích. */
  key: string
  workload: EgressWorkloadRef
  dest: EgressDest
  /** Mọi nơi khai báo điểm đến này cho workload. */
  sources: { source: EgressSource; via: string; key: string }[]
}

const destKey = (d: Omit<EgressDest, 'key'>): string =>
  `${d.kind}|${d.service ? `${d.service.ns}/${d.service.name}` : d.host}|${d.port ?? ''}`

/** Gộp mục thô thành dòng (workload × đích), phân loại theo dữ liệu Map. */
export function egressRows(
  items: readonly EgressItem[],
  data: Pick<MapData, 'services' | 'pods'>
): EgressRow[] {
  const ix = indexEgress(data)
  const rows = new Map<string, EgressRow>()
  for (const it of items) {
    const cls = classifyEndpoint(
      {
        host: it.host,
        ...(it.port !== undefined ? { port: it.port } : {}),
        ...(it.scheme ? { scheme: it.scheme } : {}),
        ...(it.portImplied ? { portImplied: true } : {})
      },
      it.workload.ns,
      ix
    )
    const dest: EgressDest = { ...cls, key: destKey(cls) }
    const key = `${it.workload.kind}|${it.workload.ns}/${it.workload.name}>${dest.key}`
    const row = rows.get(key) ?? { key, workload: it.workload, dest, sources: [] }
    rows.set(key, row)
    if (!row.sources.some((s) => s.source === it.source && s.via === it.via && s.key === it.key))
      row.sources.push({ source: it.source, via: it.via, key: it.key })
  }
  return [...rows.values()].sort(
    (x, y) =>
      x.workload.ns.localeCompare(y.workload.ns) ||
      x.workload.name.localeCompare(y.workload.name) ||
      x.dest.host.localeCompare(y.dest.host) ||
      (x.dest.port ?? 0) - (y.dest.port ?? 0)
  )
}

/** "host:port" để hiện. */
export function destLabel(d: Pick<EgressDest, 'host' | 'port'>): string {
  return d.port !== undefined ? `${d.host}:${String(d.port)}` : d.host
}

/** Gộp Service bổ sung (namespace ngoài phạm vi Map) vào dữ liệu Map để phân loại đích. */
export function withExtraServices<T extends Pick<MapData, 'services'>>(
  data: T,
  extra: EgressResult['services']
): T {
  if (!extra?.length) return data
  const have = new Set(data.services.map((s) => `${s.ns}/${s.name}`))
  const add = extra
    .filter((s) => !have.has(`${s.ns}/${s.name}`))
    .map((s) => ({
      ns: s.ns,
      name: s.name,
      type: s.type,
      selector: {},
      ports: '',
      ...(s.clusterIP ? { clusterIP: s.clusterIP } : {}),
      ...(s.externalName ? { externalName: s.externalName } : {})
    }))
  return add.length ? { ...data, services: [...data.services, ...add] } : data
}
