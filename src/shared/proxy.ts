import { z } from 'zod'

/**
 * Proxy cho kết nối ra ngoài của app (S3, Kubernetes API, kiểm tra cập nhật). Không dùng cho SSH /
 * Telnet (có jump host riêng). Hỗ trợ HTTP / HTTPS proxy (CONNECT) và SOCKS5.
 */

export const PROXY_SCHEMES = ['http:', 'https:', 'socks5:', 'socks5h:'] as const

/** Địa chỉ proxy hợp lệ: http(s)://host:port hoặc socks5(h)://host:port (có thể kèm user:pass@). */
export const ProxyUrl = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => v === '' || isProxyUrl(v),
    'Use http://host:port, https://host:port or socks5://host:port'
  )

export function isProxyUrl(v: string): boolean {
  if (!URL.canParse(v)) return false
  const u = new URL(v)
  return (PROXY_SCHEMES as readonly string[]).includes(u.protocol) && u.hostname !== ''
}

export interface ParsedProxy {
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: number
  /** socks5h: để proxy phân giải tên (không tự tra DNS). */
  remoteDns: boolean
  username?: string
  password?: string
}

export function parseProxy(url: string): ParsedProxy {
  const u = new URL(url)
  const scheme = u.protocol.replace(/:$/, '')
  const protocol = scheme === 'https' ? 'https' : scheme.startsWith('socks5') ? 'socks5' : 'http'
  const port = Number(u.port) || (protocol === 'https' ? 443 : protocol === 'socks5' ? 1080 : 8080)
  return {
    protocol,
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port,
    remoteDns: scheme === 'socks5h' || protocol !== 'socks5',
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {})
  }
}

/**
 * Host có nằm trong danh sách bỏ qua proxy không (kiểu NO_PROXY): `*`, tên đầy đủ, hậu tố
 * (`.corp.local` hoặc `corp.local` khớp cả tên con), IP, dải CIDR IPv4, `host:port`.
 */
export function bypassProxy(host: string, port: number, noProxy: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    const [name = '', p] = entry.includes(':') && !entry.includes('::') ? entry.split(':') : [entry]
    if (p && Number(p) !== port) continue
    if (name.includes('/')) {
      if (inCidr(h, name)) return true
      continue
    }
    const bare = name.replace(/^\*?\./, '')
    if (h === bare || h.endsWith(`.${bare}`)) return true
  }
  return false
}

function ipv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((x) => x > 255)) return null
  return parts.reduce((n, x) => n * 256 + x, 0)
}

function inCidr(host: string, cidr: string): boolean {
  const [base = '', bitsRaw = ''] = cidr.split('/')
  const ip = ipv4(host)
  const net = ipv4(base)
  const bits = Number(bitsRaw)
  if (ip === null || net === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const size = 2 ** (32 - bits)
  return Math.floor(ip / size) === Math.floor(net / size)
}

/** Cài đặt mạng của app (Settings › Network). */
export interface NetworkSettings {
  /** system = biến môi trường HTTPS_PROXY / HTTP_PROXY / ALL_PROXY (và proxy hệ thống cho cập nhật). */
  proxyMode: 'system' | 'none' | 'manual'
  proxyUrl: string
  noProxy: string
  /** Bỏ qua lỗi chứng chỉ khi kiểm tra / tải bản cập nhật (proxy công ty chặn TLS). */
  updatesInsecure: boolean
}

/** Proxy từ biến môi trường (như curl / kubectl). */
export function envProxy(
  env: Record<string, string | undefined>,
  secure: boolean
): { url: string; noProxy: string } | null {
  const pick = (...names: string[]): string | undefined =>
    names.map((n) => env[n] ?? env[n.toLowerCase()]).find((v) => v && v.trim() !== '')
  const url = secure
    ? pick('HTTPS_PROXY', 'ALL_PROXY', 'HTTP_PROXY')
    : pick('HTTP_PROXY', 'ALL_PROXY')
  if (!url) return null
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`
  return isProxyUrl(full) ? { url: full, noProxy: pick('NO_PROXY') ?? '' } : null
}

/**
 * Proxy dùng cho một đích (null = kết nối thẳng). `secure` = đích là https (chọn biến môi trường).
 */
export function proxyFor(
  network: NetworkSettings,
  host: string,
  port: number,
  secure: boolean,
  env: Record<string, string | undefined> = {}
): string | null {
  if (network.proxyMode === 'none') return null
  const chosen =
    network.proxyMode === 'manual'
      ? network.proxyUrl
        ? { url: network.proxyUrl, noProxy: network.noProxy }
        : null
      : envProxy(env, secure)
  if (!chosen) return null
  const noProxy = [chosen.noProxy, network.proxyMode === 'system' ? network.noProxy : '']
    .filter(Boolean)
    .join(',')
  return bypassProxy(host, port, noProxy) ? null : chosen.url
}

/** Lỗi chứng chỉ TLS (tự ký, CA nội bộ, proxy chặn TLS…) — để gợi ý tuỳ chọn bỏ qua. */
export function isCertificateError(message: string): boolean {
  return /self[- ]signed|UNABLE_TO_(GET_ISSUER_CERT|VERIFY_LEAF_SIGNATURE)|CERT_(HAS_EXPIRED|UNTRUSTED|NOT_YET_VALID)|certificate (has expired|is not trusted|verify failed)|unable to verify the first certificate|ERR_CERT_|Hostname\/IP does not match certificate/i.test(
    message
  )
}
