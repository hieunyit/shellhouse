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
import { buildGroupTree, groupMoveProblem, type GroupTree } from '@shared/group-tree'
import { GroupDefaults, HOST_COLORS } from '@shared/hosts'
import { inheritedDefaults, type GroupWithDefaults, type InheritedDefaults } from '@shared/inherit'
import type { SavedForward, SavedForwardInput } from '@shared/forwards'
import type { SerialSettings } from '@shared/serial'
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
  /** Cho phép thuật toán cũ (thiết bị đời cũ). */
  legacyAlgorithms?: boolean
  /** Host chọn rõ Password / SSH key: chỉ dùng thông tin đã lưu, không thử agent / key mặc định. */
  storedOnly?: boolean
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
  favorite: number
  sort: number
  username: string | null
  auth_type: 'password' | 'key' | 'agent' | null
  has_secret: number | null
  key_id: string | null
}

interface HostOptions {
  keyFile?: string
  proxyJump?: string
  /** Cột port chỉ là giá trị giữ chỗ; port thật lấy từ nhóm (ADR-010). */
  inheritPort?: boolean
  /** Bỏ qua jump host kế thừa từ nhóm. */
  direct?: boolean
  /** Cho phép thuật toán cũ (ssh-rsa/SHA-1, DH-SHA1, CBC) — thiết bị đời cũ. */
  legacy?: boolean
  /** Bảng mã output của server (không có = UTF-8). */
  encoding?: string
  /** Không có = SSH. */
  protocol?: 'telnet' | 'serial'
  serial?: SerialSettings
}

function parseDefaults(raw: string): GroupDefaults {
  const parsed = GroupDefaults.safeParse(parseJson<unknown>(raw, {}))
  return parsed.success ? parsed.data : {}
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
    const groups = this.groupRows()
    const rows = this.db
      .prepare(
        `SELECT h.id, h.group_id, h.label, h.hostname, h.port, h.identity_id, h.jump_host_ids,
                h.mode, h.options, h.tags,
                h.color, h.last_used_at, h.favorite, h.sort, i.username, i.auth_type,
                (i.secret_enc IS NOT NULL) AS has_secret, i.key_id
         FROM hosts h LEFT JOIN identities i ON i.id = h.identity_id
         WHERE h.deleted_at IS NULL
         ORDER BY h.sort, h.label COLLATE NOCASE`
      )
      .all() as HostRow[]
    const keys = this.db
      .prepare(
        `SELECT id, name, type, public_key, encrypted FROM keys
         WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`
      )
      .all() as { id: string; name: string; type: string; public_key: string; encrypted: number }[]

    return {
      groups,
      hosts: rows.map((r): HostSummary => {
        const options = parseJson<HostOptions>(r.options, {})
        const auth =
          r.auth_type === 'password' ? 'password' : r.auth_type === 'key' ? 'key' : 'auto'
        return {
          id: r.id,
          groupId: r.group_id,
          label: r.label,
          hostname: r.hostname,
          port: options.inheritPort ? null : r.port,
          username: r.username ?? '',
          auth,
          hasPassword: auth === 'password' && r.has_secret === 1,
          keyId: r.key_id,
          keyFile: options.keyFile ?? null,
          proxyJump: options.proxyJump ?? null,
          jumpHostIds: parseJson<string[]>(r.jump_host_ids, []),
          mode: r.mode === 'system' ? 'system' : 'builtin',
          direct: options.direct === true,
          legacyAlgorithms: options.legacy === true,
          encoding: options.encoding ?? null,
          protocol: options.protocol ?? 'ssh',
          serial: options.protocol === 'serial' ? (options.serial ?? null) : null,
          tags: parseJson<string[]>(r.tags, []),
          color: toColor(r.color),
          lastUsedAt: r.last_used_at,
          favorite: r.favorite === 1,
          sort: r.sort
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
      if (input.port === null) options.inheritPort = true
      if (input.direct) options.direct = true
      if (input.legacyAlgorithms) options.legacy = true
      if (input.encoding && input.encoding !== 'utf-8') options.encoding = input.encoding
      if (input.protocol === 'telnet') options.protocol = 'telnet'
      if (input.protocol === 'serial') {
        if (!input.serial) throw new Error('Choose a serial port')
        options.protocol = 'serial'
        options.serial = input.serial
      }
      const values = [
        input.groupId,
        input.label,
        input.hostname,
        input.port ?? 22,
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
                                options, tags, color, updated_at, id, sort)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(...values, hostId, this.nextHostSort(input.groupId))
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

  private groupRows(): GroupSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, parent_id, name, sort, defaults FROM groups WHERE deleted_at IS NULL
         ORDER BY sort, name COLLATE NOCASE`
      )
      .all() as {
      id: string
      parent_id: string | null
      name: string
      sort: number
      defaults: string
    }[]
    return rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      sort: r.sort,
      defaults: parseDefaults(r.defaults)
    }))
  }

  private groupTree(): GroupTree<GroupWithDefaults> {
    return buildGroupTree(this.groupRows())
  }

  /** Giá trị kế thừa cho một host (theo nhóm của nó). */
  private inheritedFor(hostId: string): InheritedDefaults {
    const row = this.db.prepare('SELECT group_id FROM hosts WHERE id = ?').get(hostId) as
      { group_id: string | null } | undefined
    return inheritedDefaults(this.groupTree(), row?.group_id ?? null)
  }

  /** Host mới: nếu nhóm đã được sắp xếp thủ công thì thêm vào cuối, không thì sort = 0 (theo tên). */
  private nextHostSort(groupId: string | null): number {
    const row = this.db
      .prepare('SELECT MAX(sort) AS m FROM hosts WHERE group_id IS ? AND deleted_at IS NULL')
      .get(groupId) as { m: number | null }
    return row.m && row.m > 0 ? row.m + 1 : 0
  }

  private checkGroupDefaults(defaults: GroupDefaults): void {
    if (defaults.keyId) {
      const key = this.db
        .prepare('SELECT 1 FROM keys WHERE id = ? AND deleted_at IS NULL')
        .get(defaults.keyId)
      if (!key) throw new Error('The selected key no longer exists')
    }
    for (const id of defaults.jumpHostIds ?? []) {
      const host = this.db
        .prepare('SELECT 1 FROM hosts WHERE id = ? AND deleted_at IS NULL')
        .get(id)
      if (!host) throw new Error('A selected jump host no longer exists')
    }
  }

  /** Kiểm tra vị trí mới của nhóm: không tạo vòng, không quá sâu, không trùng tên cùng cấp. */
  private checkGroupPlacement(id: string | null, parentId: string | null, name: string): void {
    const tree = this.groupTree()
    if (id !== null && !tree.byId.has(id)) throw new Error('The group no longer exists')
    const problem = groupMoveProblem(tree, id, parentId)
    if (problem) throw new Error(problem)
    const clash = tree
      .children(parentId)
      .some(
        (g) => g.id !== id && g.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0
      )
    if (clash) throw new Error(`There is already a group named "${name}" here`)
  }

  saveGroup(input: GroupInput): string {
    const now = this.now()
    const name = input.name.trim()
    this.checkGroupPlacement(input.id ?? null, input.parentId, name)
    if (input.defaults) this.checkGroupDefaults(input.defaults)
    const defaults = input.defaults ? JSON.stringify(input.defaults) : null
    if (input.id) {
      this.db
        .prepare(
          `UPDATE groups SET name = ?, parent_id = ?, defaults = COALESCE(?, defaults), updated_at = ?
           WHERE id = ?`
        )
        .run(name, input.parentId, defaults, now, input.id)
      return input.id
    }
    const id = uuidv7(now)
    this.db
      .prepare(
        'INSERT INTO groups (id, parent_id, name, defaults, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, input.parentId, name, defaults ?? '{}', now)
    return id
  }

  /** Chuyển nhóm (cùng toàn bộ nhóm con và host bên trong) vào nhóm khác / ra cấp cao nhất. */
  moveGroup(id: string, parentId: string | null): void {
    const row = this.db.prepare('SELECT name FROM groups WHERE id = ?').get(id) as
      { name: string } | undefined
    if (!row) throw new Error('The group no longer exists')
    this.checkGroupPlacement(id, parentId, row.name)
    this.db
      .prepare('UPDATE groups SET parent_id = ?, updated_at = ? WHERE id = ?')
      .run(parentId, this.now(), id)
  }

  /**
   * Xoá một nhóm mà không mất gì: host và nhóm con bên trong được dời lên nhóm cha của nó (hoặc
   * ra cấp cao nhất). Nhóm con trùng tên với một nhóm đã có ở cấp trên thì được thêm hậu tố.
   */
  deleteGroup(id: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT parent_id FROM groups WHERE id = ?').get(id) as
        { parent_id: string | null } | undefined
      if (!row) return
      const parent = row.parent_id
      const now = this.now()
      this.db
        .prepare('UPDATE hosts SET group_id = ?, updated_at = ? WHERE group_id = ?')
        .run(parent, now, id)
      const tree = this.groupTree()
      const taken = new Set(
        tree
          .children(parent)
          .filter((g) => g.id !== id)
          .map((g) => g.name.toLocaleLowerCase())
      )
      for (const child of tree.children(id)) {
        let name = child.name
        for (let n = 2; taken.has(name.toLocaleLowerCase()); n++) name = `${child.name} (${n})`
        taken.add(name.toLocaleLowerCase())
        this.db
          .prepare('UPDATE groups SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?')
          .run(parent, name, now, child.id)
      }
      this.db.prepare('DELETE FROM groups WHERE id = ?').run(id)
    })()
  }

  moveHost(hostId: string, groupId: string | null): void {
    this.moveHosts([hostId], groupId)
  }

  /** Chuyển nhiều host vào một nhóm; thêm vào cuối nếu nhóm đích đã được sắp xếp thủ công. */
  moveHosts(ids: readonly string[], groupId: string | null): void {
    if (groupId !== null && !this.groupTree().byId.has(groupId))
      throw new Error('The group no longer exists')
    const now = this.now()
    this.db.transaction(() => {
      const move = this.db.prepare(
        'UPDATE hosts SET group_id = ?, sort = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
      )
      for (const id of ids) move.run(groupId, this.nextHostSort(groupId), now, id)
    })()
  }

  deleteHosts(ids: readonly string[]): void {
    this.db.transaction(() => {
      for (const id of ids) this.deleteHost(id)
    })()
  }

  setFavorite(ids: readonly string[], favorite: boolean): void {
    const now = this.now()
    this.db.transaction(() => {
      const stmt = this.db.prepare('UPDATE hosts SET favorite = ?, updated_at = ? WHERE id = ?')
      for (const id of ids) stmt.run(favorite ? 1 : 0, now, id)
    })()
  }

  /** Thêm / bỏ tag trên nhiều host (giữ nguyên các tag khác). */
  tagHosts(ids: readonly string[], add: readonly string[], remove: readonly string[]): void {
    const now = this.now()
    const drop = new Set(remove.map((t) => t.toLowerCase()))
    this.db.transaction(() => {
      for (const id of ids) {
        const row = this.db.prepare('SELECT tags FROM hosts WHERE id = ?').get(id) as
          { tags: string } | undefined
        if (!row) continue
        const tags = parseJson<string[]>(row.tags, []).filter((t) => !drop.has(t.toLowerCase()))
        for (const t of add)
          if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t)
        if (tags.length > 20) throw new Error('A host can have at most 20 tags')
        this.db
          .prepare('UPDATE hosts SET tags = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(tags), now, id)
      }
    })()
  }

  /**
   * Sắp xếp thủ công: `orderedIds` là thứ tự mới của các host trong nhóm `groupId` (host từ nhóm
   * khác được chuyển vào). Host của nhóm không có trong danh sách được xếp sau, giữ thứ tự cũ.
   */
  reorderHosts(groupId: string | null, orderedIds: readonly string[]): void {
    const now = this.now()
    this.db.transaction(() => {
      const rest = (
        this.db
          .prepare(
            `SELECT id FROM hosts WHERE group_id IS ? AND deleted_at IS NULL
             ORDER BY sort, label COLLATE NOCASE`
          )
          .all(groupId) as { id: string }[]
      )
        .map((r) => r.id)
        .filter((id) => !orderedIds.includes(id))
      const stmt = this.db.prepare(
        'UPDATE hosts SET group_id = ?, sort = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
      )
      ;[...orderedIds, ...rest].forEach((id, i) => stmt.run(groupId, i + 1, now, id))
    })()
  }

  /** Sắp xếp thủ công các nhóm cùng cấp (và chuyển nhóm vào cấp này nếu cần). */
  reorderGroups(parentId: string | null, orderedIds: readonly string[]): void {
    const now = this.now()
    this.db.transaction(() => {
      for (const id of orderedIds) {
        const row = this.db.prepare('SELECT name, parent_id FROM groups WHERE id = ?').get(id) as
          { name: string; parent_id: string | null } | undefined
        if (!row) throw new Error('The group no longer exists')
        if (row.parent_id !== parentId) this.moveGroup(id, parentId)
      }
      const rest = this.groupTree()
        .children(parentId)
        .map((g) => g.id)
        .filter((id) => !orderedIds.includes(id))
      const stmt = this.db.prepare('UPDATE groups SET sort = ?, updated_at = ? WHERE id = ?')
      ;[...orderedIds, ...rest].forEach((id, i) => stmt.run(i + 1, now, id))
    })()
  }

  /** Nhân bản host (kể cả mật khẩu / key trong vault và forward đã lưu). Trả về id mới. */
  duplicateHost(id: string): string {
    const now = this.now()
    return this.db.transaction(() => {
      const host = this.db
        .prepare('SELECT * FROM hosts WHERE id = ? AND deleted_at IS NULL')
        .get(id) as Record<string, unknown> | undefined
      if (!host) throw new Error('Host not found')
      const newId = uuidv7(now)
      let identityId: string | null = null
      if (typeof host['identity_id'] === 'string') {
        const identity = this.db
          .prepare('SELECT * FROM identities WHERE id = ?')
          .get(host['identity_id']) as Record<string, unknown> | undefined
        if (identity) {
          identityId = uuidv7(now)
          // Secret được mã hoá gắn với id identity (AD) → giải mã rồi mã hoá lại cho id mới.
          let secretEnc: Buffer | null = null
          if (identity['secret_enc'] instanceof Buffer) {
            const secret = this.vault.decrypt(
              { table: 'identities', id: String(identity['id']), field: 'secret_enc' },
              identity['secret_enc']
            )
            try {
              secretEnc = this.vault.encryptString(
                { table: 'identities', id: identityId, field: 'secret_enc' },
                secret.revealString()
              )
            } finally {
              secret.dispose()
            }
          }
          this.db
            .prepare(
              `INSERT INTO identities (id, name, username, auth_type, secret_enc, key_id, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              identityId,
              identity['name'],
              identity['username'],
              identity['auth_type'],
              secretEnc,
              identity['key_id'],
              now
            )
        }
      }
      const label = this.uniqueLabel(String(host['label']))
      this.db
        .prepare(
          `INSERT INTO hosts (id, group_id, label, hostname, port, identity_id, jump_host_ids, mode,
                              options, tags, color, favorite, sort, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(
          newId,
          host['group_id'],
          label,
          host['hostname'],
          host['port'],
          identityId,
          host['jump_host_ids'],
          host['mode'],
          host['options'],
          host['tags'],
          host['color'],
          this.nextHostSort((host['group_id'] as string | null) ?? null),
          now
        )
      for (const f of this.listForwards(id))
        this.saveForward({
          hostId: newId,
          kind: f.kind,
          bindAddr: f.bindAddr,
          bindPort: f.bindPort,
          destHost: f.destHost,
          destPort: f.destPort,
          autoStart: f.autoStart
        })
      return newId
    })()
  }

  private uniqueLabel(base: string): string {
    const root = base.replace(/ \(copy(?: \d+)?\)$/, '')
    for (let n = 1; ; n++) {
      const label = n === 1 ? `${root} (copy)` : `${root} (copy ${n})`
      const taken = this.db
        .prepare('SELECT 1 FROM hosts WHERE label = ? COLLATE NOCASE AND deleted_at IS NULL')
        .get(label)
      if (!taken) return label
    }
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
  /**
   * Host Telnet / Serial → thông tin kết nối (không cần user, mật khẩu, jump host); null = SSH.
   * Cập nhật "dùng gần nhất".
   */
  resolveDirect(
    hostId: string
  ):
    | { protocol: 'telnet'; label: string; host: string; port: number }
    | { protocol: 'serial'; label: string; serial: SerialSettings }
    | null {
    const row = this.db
      .prepare(
        'SELECT label, hostname, port, options FROM hosts WHERE id = ? AND deleted_at IS NULL'
      )
      .get(hostId) as { label: string; hostname: string; port: number; options: string } | undefined
    if (!row) throw new Error('Host not found')
    const options = parseJson<HostOptions>(row.options, {})
    if (options.protocol !== 'telnet' && options.protocol !== 'serial') return null
    this.db.prepare('UPDATE hosts SET last_used_at = ? WHERE id = ?').run(this.now(), hostId)
    if (options.protocol === 'telnet')
      return { protocol: 'telnet', label: row.label, host: row.hostname, port: row.port }
    if (!options.serial) throw new Error(`"${row.label}" has no serial port configured`)
    return { protocol: 'serial', label: row.label, serial: options.serial }
  }

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
    const options = parseJson<HostOptions>(row.options, {})
    const proxyJump = options.proxyJump
    if (!proxyJump) {
      if (options.direct) return chain
      // Jump host kế thừa từ nhóm. Bỏ qua chính host này và các host đang trên đường đi
      // (bastion nằm trong chính nhóm có jump = bastion thì kết nối thẳng), và host đã bị xoá.
      const inherited = this.inheritedFor(hostId).jumpHostIds?.value ?? []
      for (const id of inherited) {
        if (visiting.has(id)) continue
        const exists = this.db
          .prepare('SELECT 1 FROM hosts WHERE id = ? AND deleted_at IS NULL')
          .get(id)
        if (exists) addSaved(id)
      }
      return chain
    }
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
    const options = parseJson<HostOptions>(row.options, {})
    const inherited = this.inheritedFor(hostId)
    const username = row.username || inherited.username?.value
    if (!username)
      throw new Error(`"${row.label}" has no username — set one on the host or on its group`)
    const port = options.inheritPort ? (inherited.port?.value ?? 22) : row.port

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
      // Automatic: thử thêm key mặc định của nhóm (nếu key vẫn còn trong vault).
      if (row.auth_type === 'agent' && inherited.keyId) {
        const groupKey = this.db
          .prepare('SELECT name, private_key_enc FROM keys WHERE id = ? AND deleted_at IS NULL')
          .get(inherited.keyId.value) as { name: string; private_key_enc: Buffer } | undefined
        if (groupKey) {
          const pem = this.vault.decrypt(
            { table: 'keys', id: inherited.keyId.value, field: 'private_key_enc' },
            groupKey.private_key_enc
          )
          try {
            credentials.privateKey = { data: pem.revealString(), label: groupKey.name }
          } finally {
            pem.dispose()
          }
        }
      }
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

    return {
      label: row.label,
      target: { host: row.hostname, port, username },
      credentials,
      ...(options.keyFile ? { keyFiles: [options.keyFile] } : {}),
      ...(options.legacy ? { legacyAlgorithms: true } : {}),
      ...(row.auth_type === 'password' || row.auth_type === 'key' ? { storedOnly: true } : {})
    }
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
