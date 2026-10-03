import { createHmac } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fingerprintSha256, keyTypeOf } from '../node-shared/hostkey'
import type { Db } from './store/db'

export interface KnownKey {
  keyType: string
  fingerprint: string
}

export type HostKeyCheck =
  | { status: 'match' }
  | { status: 'unknown' }
  /** Host đã biết nhưng key khác — có thể bị MITM. */
  | { status: 'changed'; known: KnownKey[] }
  /** Key bị đánh dấu @revoked trong known_hosts của OpenSSH — luôn từ chối. */
  | { status: 'revoked' }

interface Entry {
  keyType: string
  blob: Buffer
}

/** Chuỗi host như OpenSSH ghi: `host` với port 22, `[host]:port` với port khác. */
export function hostToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/** So khớp trường host của một dòng known_hosts (danh sách pattern, hashed, phủ định `!`). */
export function hostFieldMatches(field: string, host: string, port: number): boolean {
  const token = hostToken(host, port)
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|')
    if (!salt || !hash) return false
    const mac = createHmac('sha1', Buffer.from(salt, 'base64')).update(token).digest('base64')
    return mac === hash
  }
  let matched = false
  for (const raw of field.split(',')) {
    const negated = raw.startsWith('!')
    const pattern = negated ? raw.slice(1) : raw
    if (globToRegex(pattern).test(token)) {
      if (negated) return false
      matched = true
    }
  }
  return matched
}

interface OpenSshEntries {
  normal: Entry[]
  revoked: Buffer[]
}

/** Một dòng known_hosts đã tách trường (chưa so host). */
interface OpenSshLine {
  revoked: boolean
  hosts: string
  keyType: string
  keyB64: string
}

function splitOpenSshKnownHosts(text: string): OpenSshLine[] {
  const lines: OpenSshLine[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    let marker: string | null = null
    if (parts[0]?.startsWith('@')) marker = parts.shift() ?? null
    const [hosts, keyType, keyB64] = parts
    if (!hosts || !keyType || !keyB64) continue
    if (marker === '@cert-authority') continue // chưa hỗ trợ CA; bỏ qua thay vì tin nhầm
    lines.push({ revoked: marker === '@revoked', hosts, keyType, keyB64 })
  }
  return lines
}

function matchOpenSshLines(
  lines: readonly OpenSshLine[],
  host: string,
  port: number
): OpenSshEntries {
  const result: OpenSshEntries = { normal: [], revoked: [] }
  for (const line of lines) {
    if (!hostFieldMatches(line.hosts, host, port)) continue
    const blob = Buffer.from(line.keyB64, 'base64')
    if (line.revoked) result.revoked.push(blob)
    else result.normal.push({ keyType: line.keyType, blob })
  }
  return result
}

/** Đọc các dòng khớp host trong một file known_hosts dạng OpenSSH. */
export function parseOpenSshKnownHosts(text: string, host: string, port: number): OpenSshEntries {
  return matchOpenSshLines(splitOpenSshKnownHosts(text), host, port)
}

/**
 * Kho host key của app (bảng `known_hosts`) + đọc thêm `~/.ssh/known_hosts` (chỉ đọc).
 * Key @revoked luôn bị từ chối, kể cả khi đã tin trong kho của app. Sau đó khớp chính xác trong
 * kho của app được ưu tiên: người dùng đã xác nhận thay key ở app thì không bị file OpenSSH cũ
 * báo động mãi.
 */
export class KnownHosts {
  /**
   * File OpenSSH đã tách dòng, theo mtime + cỡ: mỗi lần kết nối hỏi nhiều lần (loại key của host
   * và từng jump host, rồi kiểm key) — không đọc lại cả file trên main process mỗi lần.
   */
  private readonly fileCache = new Map<
    string,
    { mtimeMs: number; size: number; lines: OpenSshLine[] }
  >()

  constructor(
    private readonly db: Db,
    private readonly openSshFiles: readonly string[] = []
  ) {}

  check(rawHost: string, port: number, blob: Buffer): HostKeyCheck {
    const host = rawHost.toLowerCase()
    const openssh = this.openSshEntries(host, port)
    if (openssh.revoked.some((r) => r.equals(blob))) return { status: 'revoked' }

    const app = this.appEntries(host, port)
    if (app.some((e) => e.blob.equals(blob))) return { status: 'match' }
    if (app.length === 0 && openssh.normal.some((e) => e.blob.equals(blob))) {
      return { status: 'match' }
    }

    const known = [...app, ...openssh.normal]
    if (known.length === 0) return { status: 'unknown' }
    return {
      status: 'changed',
      known: known.map((e) => ({ keyType: e.keyType, fingerprint: fingerprintSha256(e.blob) }))
    }
  }

  /** Loại key đã biết — Session Host ưu tiên các loại này khi thương lượng, như OpenSSH. */
  knownKeyTypes(rawHost: string, port: number): string[] {
    const host = rawHost.toLowerCase()
    const types = [...this.appEntries(host, port), ...this.openSshEntries(host, port).normal].map(
      (e) => e.keyType
    )
    return [...new Set(types)]
  }

  /** Tin key này cho host:port; thay mọi key cũ của host:port trong kho của app. */
  trust(rawHost: string, port: number, blob: Buffer, now = Date.now()): void {
    const host = rawHost.toLowerCase()
    const keyType = keyTypeOf(blob)
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM known_hosts WHERE host = ? AND port = ?').run(host, port)
      this.db
        .prepare(
          `INSERT INTO known_hosts (host, port, key_type, public_key, fingerprint, added_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(host, port, keyType, blob.toString('base64'), fingerprintSha256(blob), now)
    })()
  }

  private appEntries(host: string, port: number): Entry[] {
    const rows = this.db
      .prepare('SELECT key_type, public_key FROM known_hosts WHERE host = ? AND port = ?')
      .all(host, port) as { key_type: string; public_key: string }[]
    return rows.map((r) => ({ keyType: r.key_type, blob: Buffer.from(r.public_key, 'base64') }))
  }

  private openSshEntries(host: string, port: number): OpenSshEntries {
    const all: OpenSshEntries = { normal: [], revoked: [] }
    for (const file of this.openSshFiles) {
      const lines = this.openSshLines(file)
      if (!lines) continue
      const found = matchOpenSshLines(lines, host, port)
      all.normal.push(...found.normal)
      all.revoked.push(...found.revoked)
    }
    return all
  }

  private openSshLines(file: string): OpenSshLine[] | null {
    try {
      const { mtimeMs, size } = statSync(file)
      const cached = this.fileCache.get(file)
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.lines
      const lines = splitOpenSshKnownHosts(readFileSync(file, 'utf8'))
      this.fileCache.set(file, { mtimeMs, size, lines })
      return lines
    } catch {
      this.fileCache.delete(file)
      return null
    }
  }
}
