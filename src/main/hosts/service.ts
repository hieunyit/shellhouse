import type { ParsedKey } from 'ssh2'
import { utils } from 'ssh2'
import type {
  GroupInput,
  GroupSummary,
  HostInput,
  HostSummary,
  HostTree,
  KeySummary
} from '@shared/hosts'
import { HOST_COLORS } from '@shared/hosts'
import type { SavedForward, SavedForwardInput } from '@shared/forwards'
import { parseQuickConnect } from '@shared/quick-connect'
import { generateVerifiedKey, type KeyType } from './keygen'
import { fingerprintSha256 } from '../../node-shared/hostkey'
import { uuidv7 } from '../../node-shared/uuid'
import type { Db } from '../store/db'
import type { Vault } from '../vault/vault'
import type { Secret } from '../../node-shared/secret'

export interface ResolvedHop {
  label: string
  target: { host: string; port: number; username: string }
  credentials: {
    password?: string
    privateKey?: { data: string; passphrase?: string; label: string }
  }
  /** IdentityFile từ ~/.ssh/config — dùng thay cho key mặc định. */
  keyFiles?: string[]
}

/** Thứ Session Host cần để kết nối một host đã lưu. */
export interface ResolvedHost extends ResolvedHop {
  mode: 'builtin' | 'system'
  /** Jump host theo thứ tự (đã phẳng hoá đệ quy). */
  jumps: ResolvedHop[]
  keyFile: string | null
}

interface HostRow {
  id: string
  group_id: string | null
  label: string
  hostname: string
  port: number
  identity_id: string | null
  jump_host_ids: string
  mode: string
  options: string
  tags: string
  color: string | null
  last_used_at: number | null
  username: string | null
  auth_type: 'password' | 'key' | 'agent' | null
  has_secret: number | null
  key_id: string | null
}

interface HostOptions {
  keyFile?: string
  proxyJump?: string
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function toColor(value: string | null): HostSummary['color'] {
  return (HOST_COLORS as readonly string[]).includes(value ?? '')
    ? (value as HostSummary['color'])
    : null
}

type ParseOutcome = { key: ParsedKey } | { encrypted: true } | { error: string }

function parsePrivateKey(pem: string, passphrase?: string): ParseOutcome {
  const parsed: ParsedKey | Error = utils.parseKey(pem, passphrase)
  if (parsed instanceof Error) {
    if (/passphrase|decrypt|encrypted/i.test(parsed.message)) return { encrypted: true }
    return { error: parsed.message }
  }
  if (!parsed.isPrivateKey())
    return { error: 'This is a public key; a private key file is required' }
  return { key: parsed }
}

export class HostService {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly now: () => number = Date.now
  ) {}

  tree(): HostTree {
    const groups = this.db
      .prepare(
        'SELECT id, parent_id, name, sort FROM groups WHERE deleted_at IS NULL ORDER BY sort, name'
      )
      .all() as { id: string; parent_id: string | null; name: string; sort: number }[]
    const rows = this.db
      .prepare(
        `SELECT h.id, h.group_id, h.label, h.hostname, h.port, h.identity_id, h.jump_host_ids,
                h.mode, h.options, h.tags,
                h.color, h.last_used_at, i.username, i.auth_type,
                (i.secret_enc IS NOT NULL) AS has_secret, i.key_id
         FROM hosts h LEFT JOIN identities i ON i.id = h.identity_id
         WHERE h.deleted_at IS NULL
         ORDER BY h.label COLLATE NOCASE`
      )
      .all() as HostRow[]
    const keys = this.db
      .prepare(
        `SELECT id, name, type, public_key, encrypted FROM keys
         WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`
      )
      .all() as { id: string; name: string; type: string; public_key: string; encrypted: number }[]

    return {
      groups: groups.map((g): GroupSummary => ({
        id: g.id,
        parentId: g.parent_id,
        name: g.name,
        sort: g.sort
      })),
      hosts: rows.map((r): HostSummary => {
        const options = parseJson<HostOptions>(r.options, {})
        const auth =
          r.auth_type === 'password' ? 'password' : r.auth_type === 'key' ? 'key' : 'auto'
        return {
          id: r.id,
          groupId: r.group_id,
          label: r.label,
          hostname: r.hostname,
          port: r.port,
          username: r.username ?? '',
          auth,
          hasPassword: auth === 'password' && r.has_secret === 1,
          keyId: r.key_id,
          keyFile: options.keyFile ?? null,
          proxyJump: options.proxyJump ?? null,
          jumpHostIds: parseJson<string[]>(r.jump_host_ids, []),
          mode: r.mode === 'system' ? 'system' : 'builtin',
          tags: parseJson<string[]>(r.tags, []),
          color: toColor(r.color),
          lastUsedAt: r.last_used_at
        }
      }),
      keys: keys.map((k): KeySummary => ({
        id: k.id,
        name: k.name,
        type: k.type,
        fingerprint: fingerprintSha256(Buffer.from(k.public_key.split(' ')[1] ?? '', 'base64')),
        encrypted: k.encrypted === 1
      }))
    }
  }

  saveHost(input: HostInput): string {
    const now = this.now()
    return this.db.transaction(() => {
      const existing = input.id
        ? (this.db
            .prepare('SELECT identity_id FROM hosts WHERE id = ? AND deleted_at IS NULL')
            .get(input.id) as { identity_id: string | null } | undefined)
        : undefined
      if (input.id && !existing) throw new Error('Host not found')
      if (input.auth === 'key' && !input.keyId) throw new Error('No key selected')
      this.checkJumps(input.id ?? null, input.jumpHostIds)

      const hostId = input.id ?? uuidv7(now)
      const identityId = existing?.identity_id ?? uuidv7(now)
      const authType = input.auth === 'auto' ? 'agent' : input.auth

      // Secret: password (auth=password) hoặc passphrase (auth=key). undefined = giữ nguyên.
      const newSecret =
        input.auth === 'password' ? input.password : input.auth === 'key' ? input.passphrase : ''
      const ref = { table: 'identities', id: identityId, field: 'secret_enc' }
      let secretSql = 'secret_enc'
      const params: unknown[] = []
      if (newSecret !== undefined) {
        secretSql = '?'
        params.push(newSecret === '' ? null : this.vault.encryptString(ref, newSecret))
      }

      if (existing?.identity_id) {
        this.db
          .prepare(
            `UPDATE identities SET name = ?, username = ?, auth_type = ?, secret_enc = ${secretSql},
                    key_id = ?, updated_at = ? WHERE id = ?`
          )
          .run(
            input.label,
            input.username,
            authType,
            ...params,
            input.auth === 'key' ? input.keyId : null,
            now,
            identityId
          )
      } else {
        this.db
          .prepare(
            `INSERT INTO identities (id, name, username, auth_type, secret_enc, key_id, updated_at)
             VALUES (?, ?, ?, ?, ${newSecret === undefined ? 'NULL' : '?'}, ?, ?)`
          )
          .run(
            identityId,
            input.label,
            input.username,
            authType,
            ...params,
            input.auth === 'key' ? input.keyId : null,
            now
          )
      }

      const options: HostOptions = {}
      if (input.keyFile) options.keyFile = input.keyFile
      if (input.proxyJump) options.proxyJump = input.proxyJump
      const values = [
        input.groupId,
        input.label,
        input.hostname,
        input.port,
        identityId,
        JSON.stringify(input.jumpHostIds),
        input.mode,
        JSON.stringify(options),
        JSON.stringify([...new Set(input.tags)]),
        input.color,
        now
      ]
      if (input.id) {
        this.db
          .prepare(
            `UPDATE hosts SET group_id = ?, label = ?, hostname = ?, port = ?, identity_id = ?,
                    jump_host_ids = ?, mode = ?, options = ?, tags = ?, color = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(...values, hostId)
      } else {
        this.db
          .prepare(
            `INSERT INTO hosts (group_id, label, hostname, port, identity_id, jump_host_ids, mode,
                                options, tags, color, updated_at, id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(...values, hostId)
      }
      return hostId
    })()
  }

  /** Xoá mềm (giữ tombstone cho sync) và xoá secret ngay. */
  deleteHost(id: string): void {
    const now = this.now()
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT identity_id FROM hosts WHERE id = ?').get(id) as
        { identity_id: string | null } | undefined
      if (!row) return
      this.db
        .prepare('UPDATE hosts SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, id)
      if (row.identity_id) {
        this.db
          .prepare(
            'UPDATE identities SET secret_enc = NULL, deleted_at = ?, updated_at = ? WHERE id = ?'
          )
          .run(now, now, row.identity_id)
      }
    })()
  }

  saveGroup(input: GroupInput): string {
    const now = this.now()
    if (input.id && input.parentId && this.isDescendant(input.parentId, input.id)) {
      throw new Error('A group cannot be moved into its own subgroup')
    }
    if (input.id) {
      this.db
        .prepare('UPDATE groups SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.parentId, now, input.id)
      return input.id
    }
    const id = uuidv7(now)
    this.db
      .prepare('INSERT INTO groups (id, parent_id, name, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, input.parentId, input.name, now)
    return id
  }

  /** Xoá nhóm và nhóm con; host bên trong chuyển ra ngoài (không bị xoá). */
  deleteGroup(id: string): void {
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id)
  }

  moveHost(hostId: string, groupId: string | null): void {
    this.db
      .prepare('UPDATE hosts SET group_id = ?, updated_at = ? WHERE id = ?')
      .run(groupId, this.now(), hostId)
  }

  /** Lưu private key vào vault. Key có passphrase: passphrase nhập ở host hoặc khi kết nối. */
  importKey(name: string, pem: string): KeySummary {
    const outcome = parsePrivateKey(pem)
    let publicKey: { type: string; blob: Buffer } | null = null
    let encrypted = false
    if ('key' in outcome) publicKey = { type: outcome.key.type, blob: outcome.key.getPublicSSH() }
    else if ('encrypted' in outcome) encrypted = true
    else throw new Error(`Could not read the key: ${outcome.error}`)

    if (!publicKey) {
      // Key có passphrase: lấy public key từ phần header (OpenSSH lưu public key không mã hoá).
      publicKey = publicKeyFromOpenSshHeader(pem)
      if (!publicKey)
        throw new Error('Could not read the public key from the passphrase-protected file')
    }

    const id = uuidv7(this.now())
    const now = this.now()
    const sealed = this.vault.encryptString({ table: 'keys', id, field: 'private_key_enc' }, pem)
    const shortType = publicKey.type.replace(/^ssh-/, '').replace(/^ecdsa-sha2-nistp\d+$/, 'ecdsa')
    const type = ['ed25519', 'rsa', 'ecdsa'].includes(shortType) ? shortType : 'ed25519'
    this.db
      .prepare(
        `INSERT INTO keys (id, name, type, public_key, private_key_enc, encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        name,
        type,
        `${publicKey.type} ${publicKey.blob.toString('base64')}`,
        sealed,
        encrypted ? 1 : 0,
        now,
        now
      )
    return {
      id,
      name,
      type,
      fingerprint: fingerprintSha256(publicKey.blob),
      encrypted
    }
  }

  generateKey(options: {
    name: string
    type: KeyType
    bits?: number
    passphrase?: string
    comment: string
  }): KeySummary {
    const { privateKey } = generateVerifiedKey({
      type: options.type,
      ...(options.bits ? { bits: options.bits } : {}),
      comment: options.comment,
      ...(options.passphrase ? { passphrase: options.passphrase } : {})
    })
    return this.importKey(options.name, privateKey)
  }

  /** Public key dạng một dòng `type base64 tên` (để copy / triển khai). */
  publicKeyLine(id: string): string {
    const row = this.db
      .prepare('SELECT name, public_key FROM keys WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { name: string; public_key: string } | undefined
    if (!row) throw new Error('Key not found')
    const comment = row.name.replace(/[^\w.@+-]+/g, '-').slice(0, 64)
    return `${row.public_key} ${comment}`
  }

  /** Private key dạng OpenSSH (còn nguyên passphrase nếu có). Vault phải đang mở. */
  privateKeyPem(id: string): Secret {
    const row = this.db
      .prepare('SELECT private_key_enc FROM keys WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { private_key_enc: Buffer } | undefined
    if (!row) throw new Error('Key not found')
    return this.vault.decrypt({ table: 'keys', id, field: 'private_key_enc' }, row.private_key_enc)
  }

  deleteKey(id: string): void {
    const inUse = this.db
      .prepare('SELECT COUNT(*) AS n FROM identities WHERE key_id = ? AND deleted_at IS NULL')
      .get(id) as { n: number }
    if (inUse.n > 0)
      throw new Error(`The key is used by ${inUse.n} host${inUse.n === 1 ? '' : 's'}`)
    this.db.transaction(() => {
      this.db.prepare('UPDATE identities SET key_id = NULL WHERE key_id = ?').run(id)
      this.db.prepare('DELETE FROM keys WHERE id = ?').run(id)
    })()
  }

  /** Giải mã thông tin để kết nối (kèm chuỗi jump). Cập nhật "dùng gần nhất". */
  resolveForConnect(hostId: string, defaultUser = 'root'): ResolvedHost {
    const host = this.resolveHop(hostId)
    const row = this.db
      .prepare('SELECT jump_host_ids, mode, options FROM hosts WHERE id = ?')
      .get(hostId) as { jump_host_ids: string; mode: string; options: string }
    const options = parseJson<HostOptions>(row.options, {})
    const jumps = this.resolveJumps(hostId, defaultUser, new Set([hostId]))
    if (jumps.length > 8) throw new Error('The jump host chain is too long (maximum 8)')
    this.db.prepare('UPDATE hosts SET last_used_at = ? WHERE id = ?').run(this.now(), hostId)
    return {
      ...host,
      mode: row.mode === 'system' ? 'system' : 'builtin',
      jumps,
      keyFile: options.keyFile ?? null
    }
  }

  /** Jump host của một host: jumpHostIds (host đã lưu) hoặc chuỗi ProxyJump từ ~/.ssh/config. */
  private resolveJumps(hostId: string, defaultUser: string, visiting: Set<string>): ResolvedHop[] {
    const row = this.db
      .prepare('SELECT jump_host_ids, options FROM hosts WHERE id = ? AND deleted_at IS NULL')
      .get(hostId) as { jump_host_ids: string; options: string } | undefined
    if (!row) throw new Error('Jump host not found')
    const ids = parseJson<string[]>(row.jump_host_ids, [])
    const chain: ResolvedHop[] = []

    const addSaved = (id: string): void => {
      if (visiting.has(id)) throw new Error('The jump host chain contains a loop')
      const next = new Set(visiting).add(id)
      // Jump host cũng có thể có jump host riêng → đi qua chúng trước (như ProxyJump lồng nhau).
      chain.push(...this.resolveJumps(id, defaultUser, next), this.resolveHop(id))
    }

    if (ids.length > 0) {
      for (const id of ids) addSaved(id)
      return chain
    }
    const proxyJump = parseJson<HostOptions>(row.options, {}).proxyJump
    if (!proxyJump) return chain
    for (const entry of proxyJump
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)) {
      const saved = this.db
        .prepare('SELECT id FROM hosts WHERE label = ? COLLATE NOCASE AND deleted_at IS NULL')
        .get(entry) as { id: string } | undefined
      if (saved) {
        addSaved(saved.id)
        continue
      }
      const target = parseQuickConnect(entry, defaultUser)
      if (!target) throw new Error(`Invalid ProxyJump: ${entry}`)
      chain.push({ label: entry, target, credentials: {} })
    }
    return chain
  }

  private checkJumps(hostId: string | null, jumpHostIds: readonly string[]): void {
    if (hostId && jumpHostIds.includes(hostId))
      throw new Error('A host cannot be its own jump host')
    for (const id of jumpHostIds) {
      const exists = this.db
        .prepare('SELECT 1 FROM hosts WHERE id = ? AND deleted_at IS NULL')
        .get(id)
      if (!exists) throw new Error('Jump host not found')
      if (hostId) {
        // Jump host (hoặc jump host của nó) không được dẫn ngược về host này.
        try {
          this.resolveJumps(id, 'x', new Set([hostId, id]))
        } catch (error) {
          if (error instanceof Error && /contains a loop/.test(error.message)) {
            throw new Error('The jump host chain contains a loop', { cause: error })
          }
        }
      }
    }
  }

  listForwards(hostId: string): SavedForward[] {
    const rows = this.db
      .prepare(
        `SELECT id, host_id, kind, bind_addr, bind_port, dest_host, dest_port, auto_start
         FROM forwards WHERE host_id = ? AND deleted_at IS NULL ORDER BY rowid`
      )
      .all(hostId) as {
      id: string
      host_id: string
      kind: 'L' | 'R' | 'D'
      bind_addr: string
      bind_port: number
      dest_host: string | null
      dest_port: number | null
      auto_start: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      hostId: r.host_id,
      kind: r.kind,
      bindAddr: r.bind_addr,
      bindPort: r.bind_port,
      destHost: r.dest_host,
      destPort: r.dest_port,
      autoStart: r.auto_start === 1
    }))
  }

  saveForward(input: SavedForwardInput): string {
    const now = this.now()
    const host = this.db
      .prepare('SELECT 1 FROM hosts WHERE id = ? AND deleted_at IS NULL')
      .get(input.hostId)
    if (!host) throw new Error('Host not found')
    const destHost = input.kind === 'D' ? null : input.destHost
    const destPort = input.kind === 'D' ? null : input.destPort
    if (input.id) {
      const result = this.db
        .prepare(
          `UPDATE forwards SET kind = ?, bind_addr = ?, bind_port = ?, dest_host = ?, dest_port = ?,
                  auto_start = ?, updated_at = ? WHERE id = ? AND host_id = ? AND deleted_at IS NULL`
        )
        .run(
          input.kind,
          input.bindAddr,
          input.bindPort,
          destHost,
          destPort,
          input.autoStart ? 1 : 0,
          now,
          input.id,
          input.hostId
        )
      if (result.changes === 0) throw new Error('Forward not found')
      return input.id
    }
    const id = uuidv7(now)
    this.db
      .prepare(
        `INSERT INTO forwards (id, host_id, kind, bind_addr, bind_port, dest_host, dest_port, auto_start, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.hostId,
        input.kind,
        input.bindAddr,
        input.bindPort,
        destHost,
        destPort,
        input.autoStart ? 1 : 0,
        now
      )
    return id
  }

  deleteForward(id: string): void {
    const now = this.now()
    this.db
      .prepare('UPDATE forwards SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id)
  }

  /** Thông tin kết nối của MỘT host (không kèm jump). */
  private resolveHop(hostId: string): ResolvedHop {
    const row = this.db
      .prepare(
        `SELECT h.label, h.hostname, h.port, h.options, i.id AS identity_id, i.username,
                i.auth_type, i.secret_enc, i.key_id
         FROM hosts h LEFT JOIN identities i ON i.id = h.identity_id
         WHERE h.id = ? AND h.deleted_at IS NULL`
      )
      .get(hostId) as
      | {
          label: string
          hostname: string
          port: number
          options: string
          identity_id: string | null
          username: string | null
          auth_type: string | null
          secret_enc: Buffer | null
          key_id: string | null
        }
      | undefined
    if (!row) throw new Error('Host not found')
    if (!row.username) throw new Error('The host has no username')

    const credentials: ResolvedHost['credentials'] = {}
    const secret =
      row.secret_enc && row.identity_id
        ? this.vault.decrypt(
            { table: 'identities', id: row.identity_id, field: 'secret_enc' },
            row.secret_enc
          )
        : null
    try {
      if (row.auth_type === 'password' && secret) credentials.password = secret.revealString()
      if (row.auth_type === 'key' && row.key_id) {
        const key = this.db
          .prepare('SELECT name, private_key_enc FROM keys WHERE id = ?')
          .get(row.key_id) as { name: string; private_key_enc: Buffer } | undefined
        if (!key) throw new Error('The key of this host has been deleted')
        const pem = this.vault.decrypt(
          { table: 'keys', id: row.key_id, field: 'private_key_enc' },
          key.private_key_enc
        )
        try {
          credentials.privateKey = {
            data: pem.revealString(),
            label: key.name,
            ...(secret ? { passphrase: secret.revealString() } : {})
          }
        } finally {
          pem.dispose()
        }
      }
    } finally {
      secret?.dispose()
    }

    const options = parseJson<HostOptions>(row.options, {})
    return {
      label: row.label,
      target: { host: row.hostname, port: row.port, username: row.username },
      credentials,
      ...(options.keyFile ? { keyFiles: [options.keyFile] } : {})
    }
  }

  private isDescendant(candidate: string, ancestor: string): boolean {
    let current: string | null = candidate
    for (let depth = 0; current && depth < 100; depth++) {
      if (current === ancestor) return true
      const row = this.db.prepare('SELECT parent_id FROM groups WHERE id = ?').get(current) as
        { parent_id: string | null } | undefined
      current = row?.parent_id ?? null
    }
    return false
  }
}

/**
 * File OpenSSH private key ("openssh-key-v1") lưu public key KHÔNG mã hoá trong header,
 * nên đọc được loại key + fingerprint mà không cần passphrase.
 */
export function publicKeyFromOpenSshHeader(pem: string): { type: string; blob: Buffer } | null {
  const match =
    /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(pem)
  if (!match?.[1]) return null
  const data = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
  const magic = 'openssh-key-v1\0'
  if (data.subarray(0, magic.length).toString('latin1') !== magic) return null
  let offset = magic.length
  const readString = (): Buffer | null => {
    if (offset + 4 > data.length) return null
    const len = data.readUInt32BE(offset)
    offset += 4
    if (offset + len > data.length) return null
    const value = data.subarray(offset, offset + len)
    offset += len
    return value
  }
  readString() // ciphername
  readString() // kdfname
  readString() // kdfoptions
  if (offset + 4 > data.length) return null
  const count = data.readUInt32BE(offset)
  offset += 4
  if (count < 1) return null
  const blob = readString()
  if (!blob) return null
  const typeLen = blob.readUInt32BE(0)
  return { type: blob.subarray(4, 4 + typeLen).toString('ascii'), blob: Buffer.from(blob) }
}
