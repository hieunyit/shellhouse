import { existsSync } from 'node:fs'
import { Hostname, Username, type ImportCandidate } from '@shared/hosts'

/**
 * Nhập host từ CSV (Termius, bảng tính, công cụ khác). Nhận cột theo tên, không phân biệt hoa
 * thường; cột mật khẩu / key riêng tư KHÔNG bao giờ được đọc.
 */

/** Tên cột chấp nhận cho từng trường (đã chuẩn hoá: chữ thường, bỏ khoảng trắng / _ / -). */
const COLUMNS = {
  label: ['label', 'name', 'alias', 'title', 'host label', 'session'],
  hostname: ['hostname', 'hostname/ip', 'host', 'ip', 'address', 'server', 'hostip'],
  port: ['port', 'sshport'],
  username: ['username', 'user', 'login', 'sshusername'],
  group: ['group', 'groups', 'folder', 'path'],
  tags: ['tags', 'tag', 'labels'],
  keyFile: ['keyfile', 'identityfile', 'privatekeypath', 'sshkeypath'],
  protocol: ['protocol', 'type']
} as const

const SECRET_COLUMNS = /pass|secret|privatekey$|^sshkey$|^key$|passphrase|token/

const normalize = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')

/** CSV theo RFC 4180: dấu phẩy hoặc chấm phẩy, trường trong "…" có thể chứa xuống dòng. */
export function parseCsv(text: string): string[][] {
  // Bỏ BOM (Excel lưu "CSV UTF-8" có BOM).
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const firstLine = body.split(/\r?\n/, 1)[0] ?? ''
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i)
    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === delimiter) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows
}

export interface CsvScanOptions {
  existingLabels: readonly string[]
  defaultUser: string
}

export interface CsvScan {
  candidates: ImportCandidate[]
  /** Dòng không phải SSH (Telnet, RDP…) — theo giao thức. */
  ignored: Record<string, number>
  /** Cột bị bỏ qua vì chứa bí mật. */
  secretColumns: string[]
}

export function scanCsv(text: string, options: CsvScanOptions): CsvScan {
  const rows = parseCsv(text)
  const header = rows.shift()
  if (!header) return { candidates: [], ignored: {}, secretColumns: [] }
  const names = header.map(normalize)
  const find = (keys: readonly string[]): number =>
    names.findIndex((n) => keys.some((k) => normalize(k) === n))
  const col = {
    label: find(COLUMNS.label),
    hostname: find(COLUMNS.hostname),
    port: find(COLUMNS.port),
    username: find(COLUMNS.username),
    group: find(COLUMNS.group),
    tags: find(COLUMNS.tags),
    keyFile: find(COLUMNS.keyFile),
    protocol: find(COLUMNS.protocol)
  }
  if (col.hostname === -1)
    throw new Error('No host column found (expected a column named Hostname, Host, IP or Address)')
  const secretColumns = header.filter((h) => SECRET_COLUMNS.test(normalize(h)))

  const existing = new Set(options.existingLabels.map((l) => l.toLowerCase()))
  const seen = new Set<string>()
  const candidates: ImportCandidate[] = []
  const ignored: Record<string, number> = {}
  const cell = (row: string[], index: number): string =>
    (index === -1 ? '' : (row[index] ?? '')).trim()

  for (const [i, row] of rows.entries()) {
    const protocol = cell(row, col.protocol).toLowerCase()
    if (protocol && protocol !== 'ssh' && protocol !== 'sftp') {
      const kind = protocol.toUpperCase()
      ignored[kind] = (ignored[kind] ?? 0) + 1
      continue
    }
    const hostname = cell(row, col.hostname)
    const label = cell(row, col.label) || hostname
    if (!hostname && !label) continue
    const group = cell(row, col.group)
      .split(/[\\/]|\s>\s/)
      .map((s) => s.trim())
      .filter(Boolean)
    // Khoá duy nhất: nhóm + tên (+ số dòng nếu trùng).
    let alias = [...group, label].join('\\')
    if (seen.has(alias.toLowerCase())) alias = `${alias} (row ${i + 2})`
    seen.add(alias.toLowerCase())

    const portRaw = cell(row, col.port)
    const port = portRaw ? Number(portRaw) : 22
    const username = cell(row, col.username) || options.defaultUser
    const keyFile = cell(row, col.keyFile) || null
    const tags = cell(row, col.tags)
      .split(/[;,|]/)
      .map((t) => t.trim())
      .filter((t) => t && t.length <= 40)

    let problem: string | null = null
    if (!Hostname.safeParse(hostname).success) problem = `Invalid hostname: ${hostname}`
    else if (!Number.isInteger(port) || port < 1 || port > 65535)
      problem = `Invalid port: ${portRaw}`
    else if (!Username.safeParse(username).success) problem = `Invalid username: ${username}`
    else if (keyFile && !existsSync(keyFile)) problem = `Private key not found: ${keyFile}`

    candidates.push({
      alias,
      label: label.slice(0, 100),
      group,
      hostname,
      port: Number.isInteger(port) ? port : 22,
      username,
      keyFile,
      proxyJump: null,
      duplicate: existing.has(label.toLowerCase()),
      problem,
      ...(tags.length ? { tags } : {})
    })
  }
  return { candidates, ignored, secretColumns }
}
