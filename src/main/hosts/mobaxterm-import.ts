import { existsSync } from 'node:fs'
import { normalize, parse as parsePath, sep } from 'node:path'
import { Hostname, Username, type ImportCandidate } from '@shared/hosts'
import { t } from '@shared/i18n'

/**
 * Nhập phiên SSH từ MobaXterm.ini (mục [Bookmarks], [Bookmarks_1]…). Mỗi mục có `SubRep=` (thư mục,
 * phân cấp bằng `\`) và các dòng `Tên=#icon#kiểu%host%port%user%…#font…#…`.
 *
 * CHỈ đọc các mục Bookmarks. Mật khẩu MobaXterm lưu ở mục [Passwords] / registry — không bao giờ
 * đọc tới (và chuỗi phiên không chứa mật khẩu).
 */

/** Kiểu phiên (số thứ hai sau `#`). Chỉ SSH được nhập; còn lại đếm để báo "bỏ qua". */
const SESSION_KIND: Record<string, string> = {
  '0': 'SSH',
  '1': 'Telnet',
  '2': 'Rsh',
  '3': 'Xdmcp',
  '4': 'RDP',
  '5': 'VNC',
  '6': 'FTP',
  '7': 'SFTP',
  '8': 'Serial',
  '9': 'File',
  '10': 'Shell',
  '11': 'Browser',
  '12': 'Mosh',
  '13': 'S3',
  '14': 'WSL'
}

// Vị trí trường trong chuỗi phiên SSH (tách bằng `%`, trường 0 = kiểu).
const F_HOST = 1
const F_PORT = 2
const F_USER = 3
const F_GATEWAY_HOST = 8
const F_GATEWAY_PORT = 9
const F_GATEWAY_USER = 10
const F_KEY = 14

/** Nhiều jump host trong một trường được nối bằng `__PIPE__`. */
const PIPE = '__PIPE__'

export interface MobaScanOptions {
  home: string
  existingLabels: readonly string[]
  /** null = không có user mặc định (người dùng nhập ở ô User lúc nhập). */
  defaultUser: string | null
}

export interface MobaScan {
  candidates: ImportCandidate[]
  /** Phiên không phải SSH, theo kiểu: { RDP: 2, WSL: 1 }. */
  ignored: Record<string, number>
}

/** MobaXterm cũ ghi file bằng code page của Windows; bản mới là UTF-8. */
export function decodeMobaIni(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/** Biến trong đường dẫn MobaXterm → đường dẫn thật. */
function expandPath(raw: string, home: string): string {
  const drive = parsePath(home).root.replace(/[\\/]+$/, '') || ''
  const expanded = raw.replace(/_ProfileDir_/g, home).replace(/_CurrentDrive_/g, drive)
  if (expanded === raw) return raw
  // File viết trên Windows (`\`) nhưng đang nhập trên macOS/Linux → đổi sang `/`.
  return normalize(sep === '/' ? expanded.replaceAll('\\', '/') : expanded)
}

function proxyJump(fields: string[]): { value: string | null; problem: string | null } {
  const hosts = (fields[F_GATEWAY_HOST] ?? '').split(PIPE)
  const ports = (fields[F_GATEWAY_PORT] ?? '').split(PIPE)
  const users = (fields[F_GATEWAY_USER] ?? '').split(PIPE)
  const hops: string[] = []
  for (const [i, raw] of hosts.entries()) {
    const host = raw.trim()
    if (!host) continue
    if (!Hostname.safeParse(host).success)
      return { value: null, problem: t('Invalid jump host: {value}', { value: host }) }
    const user = (users[i] ?? '').trim()
    if (user && !Username.safeParse(user).success)
      return { value: null, problem: t('Invalid jump host user: {value}', { value: user }) }
    const port = Number((ports[i] ?? '').trim() || 22)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return {
        value: null,
        problem: t('Invalid jump host port: {value}', { value: ports[i] ?? '' })
      }
    const target = host.includes(':') ? `[${host}]` : host
    hops.push(`${user ? `${user}@` : ''}${target}${port === 22 ? '' : `:${port}`}`)
  }
  return { value: hops.length ? hops.join(',') : null, problem: null }
}

/** Đọc MobaXterm.ini, trả về phiên SSH để xem trước. Không chạy gì, không đọc mật khẩu. */
export function scanMobaXterm(text: string, options: MobaScanOptions): MobaScan {
  const existing = new Set(options.existingLabels.map((l) => l.toLowerCase()))
  const candidates: ImportCandidate[] = []
  const ignored: Record<string, number> = {}
  const seen = new Set<string>()

  let inBookmarks = false
  let group: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      inBookmarks = /^Bookmarks(_\d+)?$/i.test(section[1] ?? '')
      group = []
      continue
    }
    if (!inBookmarks) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const name = line.slice(0, eq).trim()
    const value = line.slice(eq + 1)
    if (name === 'SubRep') {
      group = value
        .split('\\')
        .map((s) => s.trim())
        .filter(Boolean)
      continue
    }
    if (name === 'ImgNum' || !value.startsWith('#')) continue

    // "#icon#kiểu%trường%…#font…" → phần thứ ba là kiểu + các trường.
    const fields = (value.split('#')[2] ?? '').split('%')
    const kind = fields[0] ?? ''
    if (kind !== '0') {
      const label = SESSION_KIND[kind] ?? 'Other'
      ignored[label] = (ignored[label] ?? 0) + 1
      continue
    }

    // Tên phiên chỉ duy nhất trong một thư mục → khoá = đường dẫn thư mục + tên.
    const alias = [...group, name].join('\\')
    if (seen.has(alias.toLowerCase())) continue
    seen.add(alias.toLowerCase())

    const hostname = (fields[F_HOST] ?? '').trim()
    const portRaw = (fields[F_PORT] ?? '').trim()
    const port = portRaw ? Number(portRaw) : 22
    const username = (fields[F_USER] ?? '').trim() || options.defaultUser
    const keyRaw = (fields[F_KEY] ?? '').trim()
    const keyFile = keyRaw ? expandPath(keyRaw, options.home) : null
    const jump = proxyJump(fields)

    let problem: string | null = null
    if (!Hostname.safeParse(hostname).success)
      problem = t('Invalid hostname: {value}', { value: hostname })
    else if (!Number.isInteger(port) || port < 1 || port > 65535)
      problem = t('Invalid port: {value}', { value: portRaw })
    else if (username !== null && !Username.safeParse(username).success)
      problem = t('Invalid username: {value}', { value: username })
    else if (jump.problem) problem = jump.problem
    else if (keyFile && !existsSync(keyFile))
      problem = t('Private key not found: {path}', { path: keyFile })

    candidates.push({
      alias,
      label: name,
      group,
      hostname,
      port: Number.isInteger(port) ? port : 22,
      username,
      keyFile,
      proxyJump: jump.value,
      duplicate: existing.has(name.toLowerCase()),
      problem
    })
  }
  return { candidates, ignored }
}
