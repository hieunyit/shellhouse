import type { ParsedKey } from 'ssh2'
import { utils } from 'ssh2'
import type {
  AccountDeleteResolution,
  AccountInput,
  AccountSummary,
  GroupInput,
  GroupSummary,
  HostInput,
  HostProtocol,
  HostSummary,
  HostTree,
  KeySummary
} from '@shared/hosts'
import { buildGroupTree, groupMoveProblem, type GroupTree } from '@shared/group-tree'
import { GroupDefaults, HOST_COLORS, MAX_JUMPS, Username } from '@shared/hosts'
import { inheritedDefaults, type GroupWithDefaults, type InheritedDefaults } from '@shared/inherit'
import type { SavedForward, SavedForwardInput } from '@shared/forwards'
import type { SerialSettings } from '@shared/serial'
import { DEFAULT_RDP, RdpSettings, RdpUsername } from '@shared/rdp'
import { parseQuickConnect } from '@shared/quick-connect'
import { HostOs, sameOs } from '@shared/host-os'
import { generateVerifiedKey, type KeyType } from './keygen'
import { fingerprintSha256 } from '../../node-shared/hostkey'
import { uuidv7 } from '../../node-shared/uuid'
import type { Db } from '../store/db'
import type { Vault } from '../vault/vault'
import type { Secret } from '../../node-shared/secret'
import { t, tn } from '@shared/i18n'

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
  /** Tự gắn vào tmux trên server (chỉ có nghĩa với đích cuối). */
  tmux?: boolean
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
  os: string | null
  username: string | null
  auth_type: 'password' | 'key' | 'agent' | null
  has_secret: number | null
  key_id: string | null
  shared: number | null
  split_secrets: number | null
}

/** Một dòng bảng identities (thông tin đăng nhập riêng của host, hoặc tài khoản dùng chung). */
interface IdentityRow {
  id: string
  name: string
  username: string | null
  auth_type: 'password' | 'key' | 'agent'
  secret_enc: Buffer | null
  key_id: string | null
  shared: number
  split_secrets: number
  passphrase_enc: Buffer | null
  domain: string | null
  notes: string | null
}

/** Trường cần để giải mã secret của một identity (theo đúng cách lưu của nó). */
interface IdentitySecretsRow {
  identity_id: string | null
  auth_type: string | null
  secret_enc: Buffer | null
  split_secrets: number | null
  passphrase_enc: Buffer | null
}

/** Mật khẩu / passphrase đã giải mã — người gọi dispose(). */
interface IdentitySecrets {
  password: Secret | null
  passphrase: Secret | null
}

/** Cách xác thực suy ra từ dữ liệu của identity dạng split (tài khoản): key → mật khẩu → tự động. */
function splitAuthType(keyId: string | null, hasPassword: boolean): 'key' | 'password' | 'agent' {
  return keyId ? 'key' : hasPassword ? 'password' : 'agent'
}

/** Username của tài khoản có dùng được cho host giao thức này không ('' = kế thừa, luôn được). */
function usernameProblem(protocol: HostProtocol, username: string): string | null {
  if (username === '') return null
  if (protocol === 'rdp')
    return RdpUsername.safeParse(username).success
      ? null
      : t('“{value}” is not a valid Windows username', { value: username })
  return Username.safeParse(username).success
    ? null
    : t('“{value}” is not a valid SSH username', { value: username })
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
  /** Tự gắn vào tmux trên server. */
  tmux?: boolean
  /** Không có = SSH. */
  protocol?: 'telnet' | 'serial' | 'rdp'
  serial?: SerialSettings
  /** Chỉ có khi protocol = 'rdp'. */
  rdp?: RdpSettings
}

/** Thứ launcher RDP cần (main/rdp) — mật khẩu đã giải mã, người gọi phải dispose(). */
export interface ResolvedRdp {
  label: string
  host: string
  port: number
  username: string
  settings: RdpSettings
  password: Secret | null
  /** SSH host làm tunnel; null = kết nối thẳng. */
  via: { id: string; label: string } | null
}

/** Cài đặt RDP đã lưu; dữ liệu hỏng / thiếu trường (bản cũ) → giá trị mặc định. */
function rdpSettingsOf(options: HostOptions): RdpSettings {
  const parsed = RdpSettings.safeParse({ ...DEFAULT_RDP, ...options.rdp })
  return parsed.success ? parsed.data : DEFAULT_RDP
}

function parseDefaults(raw: string): GroupDefaults {
  const parsed = GroupDefaults.safeParse(parseJson<unknown>(raw, {}))
  return parsed.success ? parsed.data : {}
}

/** Cột `os` (JSON) → trường `os` của HostSummary; hỏng / chưa có → bỏ trống. */
function osOf(raw: string | null): { os?: HostOs } {
  if (!raw) return {}
  const parsed = HostOs.safeParse(parseJson<unknown>(raw, null))
  return parsed.success ? { os: parsed.data } : {}
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
                h.color, h.last_used_at, h.favorite, h.sort, h.os, i.username, i.auth_type,
                (i.secret_enc IS NOT NULL) AS has_secret, i.key_id, i.shared, i.split_secrets
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
        // Dạng split (tài khoản): secret_enc luôn là mật khẩu, có thể có cả key lẫn mật khẩu.
        const split = r.split_secrets === 1
        const kind = split ? splitAuthType(r.key_id, r.has_secret === 1) : (r.auth_type ?? 'agent')
        const auth = kind === 'password' ? 'password' : kind === 'key' ? 'key' : 'auto'
        return {
          id: r.id,
          groupId: r.group_id,
          label: r.label,
          hostname: r.hostname,
          port: options.inheritPort ? null : r.port,
          username: r.username ?? '',
          auth,
          hasPassword: r.has_secret === 1 && (split || auth === 'password'),
          keyId: r.key_id,
          keyFile: options.keyFile ?? null,
          proxyJump: options.proxyJump ?? null,
          jumpHostIds: parseJson<string[]>(r.jump_host_ids, []),
          mode: r.mode === 'system' ? 'system' : 'builtin',
          direct: options.direct === true,
          legacyAlgorithms: options.legacy === true,
          encoding: options.encoding ?? null,
          ...(options.tmux ? { tmux: true } : {}),
          protocol: options.protocol ?? 'ssh',
          serial: options.protocol === 'serial' ? (options.serial ?? null) : null,
          ...(options.protocol === 'rdp' ? { rdp: rdpSettingsOf(options) } : {}),
          tags: parseJson<string[]>(r.tags, []),
          color: toColor(r.color),
          lastUsedAt: r.last_used_at,
          favorite: r.favorite === 1,
          sort: r.sort,
          ...osOf(r.os),
          ...(r.shared === 1 && r.identity_id ? { accountId: r.identity_id } : {})
        }
      }),
      keys: keys.map((k): KeySummary => ({
        id: k.id,
        name: k.name,
        type: k.type,
        fingerprint: fingerprintSha256(Buffer.from(k.public_key.split(' ')[1] ?? '', 'base64')),
        encrypted: k.encrypted === 1
      })),
      accounts: this.accounts()
    }
  }

  saveHost(input: HostInput): string {
    const now = this.now()
    return this.db.transaction(() => {
      const existing = input.id
        ? (this.db
            .prepare(
              `SELECT h.identity_id, i.shared, i.split_secrets
               FROM hosts h LEFT JOIN identities i ON i.id = h.identity_id
               WHERE h.id = ? AND h.deleted_at IS NULL`
            )
            .get(input.id) as
            | { identity_id: string | null; shared: number | null; split_secrets: number | null }
            | undefined)
        : undefined
      if (input.id && !existing) throw new Error(t('Host not found'))
      const accountId = input.accountId ?? null
      if (!accountId && input.auth === 'key' && !input.keyId) throw new Error(t('No key selected'))
      this.checkProtocolFields(input)
      this.checkJumps(input.id ?? null, input.jumpHostIds)

      const hostId = input.id ?? uuidv7(now)
      // Identity riêng của host (không phải tài khoản dùng chung) — sửa tại chỗ hoặc bỏ đi.
      const ownIdentity =
        existing?.identity_id && existing.shared !== 1 ? existing.identity_id : null
      let identityId: string
      if (accountId) {
        identityId = this.linkAccount(input, accountId)
        if (ownIdentity) this.retireIdentity(ownIdentity, now)
      } else if (ownIdentity && existing?.split_secrets !== 1 && !input.secretsFrom) {
        identityId = ownIdentity
        this.writeOwnIdentity(input, ownIdentity, null, true)
      } else {
        // Host vừa thôi dùng tài khoản (hoặc identity tách từ tài khoản): tạo identity riêng mới,
        // mật khẩu / passphrase không nhập lại thì chép từ tài khoản / identity cũ.
        const sourceId =
          input.secretsFrom ??
          (existing?.shared === 1 ? existing.identity_id : null) ??
          (existing?.split_secrets === 1 ? ownIdentity : null)
        const source = sourceId ? this.identityRow(sourceId) : undefined
        if (input.secretsFrom && source?.shared !== 1)
          throw new Error(t('The selected account no longer exists'))
        identityId = uuidv7(now)
        this.writeOwnIdentity(input, identityId, source ?? null, false)
        if (ownIdentity) this.retireIdentity(ownIdentity, now)
      }

      const options: HostOptions = {}
      if (input.keyFile) options.keyFile = input.keyFile
      if (input.proxyJump) options.proxyJump = input.proxyJump
      if (input.port === null) options.inheritPort = true
      if (input.direct) options.direct = true
      if (input.legacyAlgorithms) options.legacy = true
      if (input.encoding && input.encoding !== 'utf-8') options.encoding = input.encoding
      if (input.tmux) options.tmux = true
      if (input.protocol === 'telnet') options.protocol = 'telnet'
      if (input.protocol === 'rdp' && input.rdp) {
        options.protocol = 'rdp'
        options.rdp = input.rdp
      }
      if (input.protocol === 'serial') {
        if (!input.serial) throw new Error(t('Choose a serial port'))
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

  /** Kiểm tài khoản host sắp liên kết tới; trả id của nó. */
  private linkAccount(input: HostInput, accountId: string): string {
    const protocol = input.protocol ?? 'ssh'
    if (protocol !== 'ssh' && protocol !== 'rdp')
      throw new Error(t('Accounts can only be used by SSH and Remote Desktop hosts'))
    const account = this.accountRow(accountId)
    if (!account) throw new Error(t('The selected account no longer exists'))
    const problem = usernameProblem(protocol, account.username ?? '')
    if (problem) throw new Error(problem)
    return account.id
  }

  /**
   * Ghi identity riêng của host theo cách lưu cũ (một secret: mật khẩu khi auth = password,
   * passphrase khi auth = key). `update` = sửa dòng có sẵn; không thì thêm mới. Secret không nhập
   * (undefined): dòng có sẵn giữ nguyên; dòng mới lấy từ `source` (tài khoản vừa bỏ chọn) nếu có.
   */
  private writeOwnIdentity(
    input: HostInput,
    identityId: string,
    source: IdentityRow | null,
    update: boolean
  ): void {
    const now = this.now()
    const authType = input.auth === 'auto' ? 'agent' : input.auth
    const keyId = input.auth === 'key' ? input.keyId : null
    let newSecret =
      input.auth === 'password' ? input.password : input.auth === 'key' ? input.passphrase : ''
    if (newSecret === undefined && !update && source) {
      const secrets = this.identitySecrets({ ...source, identity_id: source.id })
      try {
        if (input.auth === 'password') newSecret = secrets.password?.revealString()
        // Passphrase chỉ có nghĩa với đúng key của tài khoản.
        if (input.auth === 'key' && source.key_id === keyId)
          newSecret = secrets.passphrase?.revealString()
      } finally {
        secrets.password?.dispose()
        secrets.passphrase?.dispose()
      }
    }
    const sealed =
      newSecret === undefined || newSecret === ''
        ? null
        : this.vault.encryptString(
            { table: 'identities', id: identityId, field: 'secret_enc' },
            newSecret
          )
    if (update) {
      this.db
        .prepare(
          `UPDATE identities SET name = ?, username = ?, auth_type = ?,
                  secret_enc = ${newSecret === undefined ? 'secret_enc' : '?'},
                  key_id = ?, updated_at = ? WHERE id = ?`
        )
        .run(
          input.label,
          input.username,
          authType,
          ...(newSecret === undefined ? [] : [sealed]),
          keyId,
          now,
          identityId
        )
      return
    }
    this.db
      .prepare(
        `INSERT INTO identities (id, name, username, auth_type, secret_enc, key_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(identityId, input.label, input.username, authType, sealed, keyId, now)
  }

  /** Bỏ identity riêng của host (xoá mềm, xoá secret ngay). Không bao giờ đụng tài khoản dùng chung. */
  private retireIdentity(identityId: string, now: number): void {
    this.db
      .prepare(
        `UPDATE identities SET secret_enc = NULL, passphrase_enc = NULL, deleted_at = ?,
                updated_at = ? WHERE id = ? AND shared = 0`
      )
      .run(now, now, identityId)
  }

  /** Xoá mềm (giữ tombstone cho sync) và xoá secret ngay. Tài khoản dùng chung thì giữ nguyên. */
  deleteHost(id: string): void {
    const now = this.now()
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT identity_id FROM hosts WHERE id = ?').get(id) as
        { identity_id: string | null } | undefined
      if (!row) return
      this.db
        .prepare('UPDATE hosts SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, id)
      if (row.identity_id) this.retireIdentity(row.identity_id, now)
    })()
  }

  /** Chạy nhiều thao tác trong một transaction (nhập hàng loạt: một lần ghi đĩa, nguyên tử). */
  batch<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /** Danh sách nhóm (nhẹ hơn tree(): không đọc host / key). */
  groups(): GroupSummary[] {
    return this.groupRows()
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
      if (!key) throw new Error(t('The selected key no longer exists'))
    }
    for (const id of defaults.jumpHostIds ?? []) {
      const host = this.db
        .prepare('SELECT 1 FROM hosts WHERE id = ? AND deleted_at IS NULL')
        .get(id)
      if (!host) throw new Error(t('A selected jump host no longer exists'))
    }
  }

  /** Kiểm tra vị trí mới của nhóm: không tạo vòng, không quá sâu, không trùng tên cùng cấp. */
  private checkGroupPlacement(id: string | null, parentId: string | null, name: string): void {
    const tree = this.groupTree()
    if (id !== null && !tree.byId.has(id)) throw new Error(t('The group no longer exists'))
    const problem = groupMoveProblem(tree, id, parentId)
    if (problem) throw new Error(problem)
    const clash = tree
      .children(parentId)
      .some(
        (g) => g.id !== id && g.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0
      )
    if (clash) throw new Error(t('There is already a group named "{name}" here', { name }))
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
    if (!row) throw new Error(t('The group no longer exists'))
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
      throw new Error(t('The group no longer exists'))
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

  /**
   * Lưu hệ điều hành server vừa nhận ra lúc kết nối. Trả true nếu có thay đổi (để báo renderer);
   * không đụng `updated_at` — không phải người dùng sửa host.
   */
  setOs(hostId: string, os: HostOs): boolean {
    const parsed = HostOs.safeParse(os)
    if (!parsed.success) return false
    const row = this.db
      .prepare('SELECT os FROM hosts WHERE id = ? AND deleted_at IS NULL')
      .get(hostId) as { os: string | null } | undefined
    if (!row || sameOs(osOf(row.os).os, parsed.data)) return false
    this.db.prepare('UPDATE hosts SET os = ? WHERE id = ?').run(JSON.stringify(parsed.data), hostId)
    return true
  }

  setFavorite(ids: readonly string[], favorite: boolean): void {
    const now = this.now()
    this.db.transaction(() => {
      const stmt = this.db.prepare('UPDATE hosts SET favorite = ?, updated_at = ? WHERE id = ?')
      for (const id of ids) stmt.run(favorite ? 1 : 0, now, id)
    })()
  }

  /**
   * Lưu mật khẩu người dùng vừa gõ ở hộp hỏi mật khẩu (sau khi đăng nhập thành công). Host đang
   * "Automatic" chuyển sang "Password"; host dùng SSH key thì không đụng tới (secret của nó là
   * passphrase của key).
   */
  setHostPassword(hostId: string, password: string): void {
    if (!password) throw new Error(t('Password is empty'))
    const now = this.now()
    this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT h.label, h.identity_id, i.auth_type, i.id AS existing, i.split_secrets
           FROM hosts h LEFT JOIN identities i ON i.id = h.identity_id
           WHERE h.id = ? AND h.deleted_at IS NULL`
        )
        .get(hostId) as
        | {
            label: string
            identity_id: string | null
            auth_type: string | null
            existing: string | null
            split_secrets: number | null
          }
        | undefined
      if (!row) throw new Error(t('Host not found'))
      if (row.existing && row.split_secrets === 1) {
        // Tài khoản (hoặc identity tách từ tài khoản): mật khẩu có cột riêng, key giữ nguyên —
        // lưu vào tài khoản thì mọi host dùng tài khoản đó đều có mật khẩu mới.
        const ref = { table: 'identities', id: row.existing, field: 'secret_enc' }
        this.db
          .prepare(
            `UPDATE identities SET secret_enc = ?,
                    auth_type = CASE WHEN key_id IS NULL THEN 'password' ELSE 'key' END,
                    updated_at = ? WHERE id = ?`
          )
          .run(this.vault.encryptString(ref, password), now, row.existing)
        return
      }
      if (row.auth_type === 'key') throw new Error(t('This host signs in with an SSH key'))
      if (row.existing) {
        const ref = { table: 'identities', id: row.existing, field: 'secret_enc' }
        this.db
          .prepare(
            `UPDATE identities SET auth_type = 'password', secret_enc = ?, key_id = NULL,
                    updated_at = ? WHERE id = ?`
          )
          .run(this.vault.encryptString(ref, password), now, row.existing)
      } else {
        // Host chưa có identity (dữ liệu cũ): tạo mới, username trống = kế thừa từ nhóm.
        const identityId = uuidv7(now)
        const ref = { table: 'identities', id: identityId, field: 'secret_enc' }
        this.db
          .prepare(
            `INSERT INTO identities (id, name, username, auth_type, secret_enc, key_id, updated_at)
             VALUES (?, ?, '', 'password', ?, NULL, ?)`
          )
          .run(identityId, row.label, this.vault.encryptString(ref, password), now)
        this.db
          .prepare('UPDATE hosts SET identity_id = ?, updated_at = ? WHERE id = ?')
          .run(identityId, now, hostId)
      }
    })()
  }

  /** Thêm / bỏ tag trên nhiều host (giữ nguyên các tag khác). */
  tagHosts(ids: readonly string[], add: readonly string[], remove: readonly string[]): void {
    const now = this.now()
    const drop = new Set(remove.map((tag) => tag.toLowerCase()))
    this.db.transaction(() => {
      for (const id of ids) {
        const row = this.db.prepare('SELECT tags FROM hosts WHERE id = ?').get(id) as
          { tags: string } | undefined
        if (!row) continue
        const tags = parseJson<string[]>(row.tags, []).filter((tag) => !drop.has(tag.toLowerCase()))
        for (const tag of add)
          if (!tags.some((x) => x.toLowerCase() === tag.toLowerCase())) tags.push(tag)
        if (tags.length > 20) throw new Error(t('A host can have at most 20 tags'))
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
        if (!row) throw new Error(t('The group no longer exists'))
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
      if (!host) throw new Error(t('Host not found'))
      const newId = uuidv7(now)
      let identityId: string | null = null
      if (typeof host['identity_id'] === 'string') {
        const identity = this.identityRow(host['identity_id'])
        // Tài khoản dùng chung: bản sao cũng liên kết tới nó. Identity riêng: chép (kể cả secret).
        if (identity)
          identityId =
            identity.shared === 1
              ? identity.id
              : this.copyIdentity(identity, { name: identity.name, shared: false }, now)
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
    else throw new Error(t('Could not read the key: {error}', { error: outcome.error }))

    if (!publicKey) {
      // Key có passphrase: lấy public key từ phần header (OpenSSH lưu public key không mã hoá).
      publicKey = publicKeyFromOpenSshHeader(pem)
      if (!publicKey)
        throw new Error(t('Could not read the public key from the passphrase-protected file'))
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
    if (!row) throw new Error(t('Key not found'))
    const comment = row.name.replace(/[^\w.@+-]+/g, '-').slice(0, 64)
    return `${row.public_key} ${comment}`
  }

  /** Private key dạng OpenSSH (còn nguyên passphrase nếu có). Vault phải đang mở. */
  privateKeyPem(id: string): Secret {
    const row = this.db
      .prepare('SELECT private_key_enc FROM keys WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { private_key_enc: Buffer } | undefined
    if (!row) throw new Error(t('Key not found'))
    return this.vault.decrypt({ table: 'keys', id, field: 'private_key_enc' }, row.private_key_enc)
  }

  deleteKey(id: string): void {
    const accounts = this.db
      .prepare(
        `SELECT name FROM identities WHERE key_id = ? AND shared = 1 AND deleted_at IS NULL
         ORDER BY name COLLATE NOCASE`
      )
      .all(id) as { name: string }[]
    const [first] = accounts
    if (first && accounts.length === 1)
      throw new Error(t('The key is used by the account “{name}”', { name: first.name }))
    if (accounts.length > 1)
      throw new Error(
        tn(accounts.length, 'The key is used by {n} account', 'The key is used by {n} accounts')
      )
    const inUse = this.db
      .prepare('SELECT COUNT(*) AS n FROM identities WHERE key_id = ? AND deleted_at IS NULL')
      .get(id) as { n: number }
    if (inUse.n > 0)
      throw new Error(tn(inUse.n, 'The key is used by {n} host', 'The key is used by {n} hosts'))
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
    if (!row) throw new Error(t('Host not found'))
    const options = parseJson<HostOptions>(row.options, {})
    if (options.protocol === 'rdp')
      throw new Error(
        t('"{name}" is a Remote Desktop host — use Connect to open it', { name: row.label })
      )
    if (options.protocol !== 'telnet' && options.protocol !== 'serial') return null
    this.db.prepare('UPDATE hosts SET last_used_at = ? WHERE id = ?').run(this.now(), hostId)
    if (options.protocol === 'telnet')
      return { protocol: 'telnet', label: row.label, host: row.hostname, port: row.port }
    if (!options.serial)
      throw new Error(t('"{name}" has no serial port configured', { name: row.label }))
    return { protocol: 'serial', label: row.label, serial: options.serial }
  }

  resolveForConnect(hostId: string, defaultUser = 'root'): ResolvedHost {
    const host = this.resolveHop(hostId)
    const row = this.db
      .prepare('SELECT jump_host_ids, mode, options FROM hosts WHERE id = ?')
      .get(hostId) as { jump_host_ids: string; mode: string; options: string }
    const options = parseJson<HostOptions>(row.options, {})
    const jumps = this.resolveJumps(hostId, defaultUser, new Set([hostId]))
    this.db.prepare('UPDATE hosts SET last_used_at = ? WHERE id = ?').run(this.now(), hostId)
    return {
      ...host,
      mode: row.mode === 'system' ? 'system' : 'builtin',
      jumps,
      keyFile: options.keyFile ?? null
    }
  }

  /**
   * Jump host của một host: jumpHostIds (host đã lưu) hoặc chuỗi ProxyJump từ ~/.ssh/config.
   * `budget` đếm chặng trên CẢ cây (dùng chung giữa các nhánh): dừng ngay khi quá MAX_JUMPS thay
   * vì đi hết rồi mới đếm — đồ thị hình thoi lồng nhau không làm bùng nổ số lần đệ quy / giải mã.
   */
  private resolveJumps(
    hostId: string,
    defaultUser: string,
    visiting: Set<string>,
    budget = { hops: 0 }
  ): ResolvedHop[] {
    const spend = (): void => {
      if (++budget.hops > MAX_JUMPS)
        throw new Error(t('The jump host chain is too long (maximum {n})', { n: MAX_JUMPS }))
    }
    const row = this.db
      .prepare('SELECT jump_host_ids, options FROM hosts WHERE id = ? AND deleted_at IS NULL')
      .get(hostId) as { jump_host_ids: string; options: string } | undefined
    if (!row) throw new Error(t('Jump host not found'))
    const ids = parseJson<string[]>(row.jump_host_ids, [])
    const chain: ResolvedHop[] = []

    const addSaved = (id: string): void => {
      if (visiting.has(id)) throw new Error(t('The jump host chain contains a loop'))
      spend()
      const next = new Set(visiting).add(id)
      // Jump host cũng có thể có jump host riêng → đi qua chúng trước (như ProxyJump lồng nhau).
      chain.push(...this.resolveJumps(id, defaultUser, next, budget), this.resolveHop(id))
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
      if (!target) throw new Error(t('Invalid ProxyJump: {value}', { value: entry }))
      spend()
      chain.push({ label: entry, target, credentials: {} })
    }
    return chain
  }

  private checkJumps(hostId: string | null, jumpHostIds: readonly string[]): void {
    if (hostId && jumpHostIds.includes(hostId))
      throw new Error(t('A host cannot be its own jump host'))
    for (const id of jumpHostIds) {
      const exists = this.db
        .prepare('SELECT options FROM hosts WHERE id = ? AND deleted_at IS NULL')
        .get(id) as { options: string } | undefined
      if (!exists) throw new Error(t('Jump host not found'))
      if (parseJson<HostOptions>(exists.options, {}).protocol === 'rdp')
        throw new Error(t('A Remote Desktop host cannot be a jump host'))
      if (hostId) {
        // Jump host (hoặc jump host của nó) không được dẫn ngược về host này.
        try {
          this.resolveJumps(id, 'x', new Set([hostId, id]))
        } catch (error) {
          if (error instanceof Error && /contains a loop/.test(error.message)) {
            throw new Error(t('The jump host chain contains a loop'), { cause: error })
          }
        }
      }
    }
  }

  /**
   * Trường riêng theo giao thức. RDP: tên đăng nhập kiểu Windows (UPN…), không có SSH key, tunnel
   * phải là host SSH tích hợp (ssh hệ thống không forward được cổng). Giao thức khác: username
   * theo quy tắc SSH (HostInput nới lỏng để nhận UPN của RDP).
   */
  private checkProtocolFields(input: HostInput): void {
    if (input.protocol !== 'rdp') {
      if (input.username !== '' && !Username.safeParse(input.username).success)
        throw new Error(t('Invalid username'))
      return
    }
    if (!input.rdp) throw new Error(t('Remote Desktop settings are missing'))
    const settings = RdpSettings.safeParse(input.rdp)
    if (!settings.success)
      throw new Error(t(settings.error.issues[0]?.message ?? 'Invalid Remote Desktop settings'))
    if (input.username !== '' && !RdpUsername.safeParse(input.username).success)
      throw new Error(t('Invalid username'))
    if (input.auth === 'key') throw new Error(t('Remote Desktop hosts sign in with a password'))
    if (input.jumpHostIds.length > 0) throw new Error(t('Remote Desktop hosts have no jump hosts'))
    const via = input.rdp.viaHostId
    if (via) {
      if (via === input.id) throw new Error(t('A host cannot tunnel through itself'))
      this.tunnelHost(via)
    }
  }

  /** SSH host dùng làm tunnel cho RDP — phải còn, là SSH tích hợp. */
  private tunnelHost(id: string): { id: string; label: string } {
    const row = this.db
      .prepare('SELECT label, mode, options FROM hosts WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { label: string; mode: string; options: string } | undefined
    if (!row) throw new Error(t('The SSH host for the tunnel no longer exists'))
    const protocol = parseJson<HostOptions>(row.options, {}).protocol
    if (protocol !== undefined)
      throw new Error(
        t('“{name}” is not an SSH host — pick an SSH host for the tunnel', { name: row.label })
      )
    if (row.mode === 'system')
      throw new Error(
        t('“{name}” uses the system ssh command, which cannot forward ports for the tunnel', {
          name: row.label
        })
      )
    return { id, label: row.label }
  }

  /**
   * Host RDP → thông tin cho launcher (giải mã mật khẩu — người gọi dispose()). `touch` = cập nhật
   * "dùng gần nhất" (khi kết nối thật, không phải lúc kiểm tra trước).
   */
  resolveRdp(hostId: string, touch = true): ResolvedRdp {
    const row = this.db
      .prepare(
        `SELECT h.label, h.hostname, h.port, h.options, i.id AS identity_id, i.username,
                i.auth_type, i.secret_enc, i.split_secrets, i.passphrase_enc, i.domain
         FROM hosts h LEFT JOIN identities i ON i.id = h.identity_id
         WHERE h.id = ? AND h.deleted_at IS NULL`
      )
      .get(hostId) as
      | (IdentitySecretsRow & {
          label: string
          hostname: string
          port: number
          options: string
          username: string | null
          domain: string | null
        })
      | undefined
    if (!row) throw new Error(t('Host not found'))
    const options = parseJson<HostOptions>(row.options, {})
    if (options.protocol !== 'rdp')
      throw new Error(t('"{name}" is not a Remote Desktop host', { name: row.label }))
    const own = rdpSettingsOf(options)
    // Domain của tài khoản (nếu có) thay domain đặt ở host.
    const settings = row.domain ? { ...own, domain: row.domain } : own
    const via = settings.viaHostId ? this.tunnelHost(settings.viaHostId) : null
    // RDP không dùng key: chỉ lấy mật khẩu (passphrase không giải mã).
    const { password } = this.identitySecrets({ ...row, passphrase_enc: null })
    if (touch)
      this.db.prepare('UPDATE hosts SET last_used_at = ? WHERE id = ?').run(this.now(), hostId)
    return {
      label: row.label,
      host: row.hostname,
      port: row.port,
      username: row.username ?? '',
      settings,
      password,
      via
    }
  }

  // ---------- Tài khoản dùng chung (Settings → Accounts) ----------

  /** Danh sách tài khoản (không secret) kèm host đang dùng từng tài khoản. */
  accounts(): AccountSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, username, (secret_enc IS NOT NULL) AS has_password, key_id,
                (passphrase_enc IS NOT NULL) AS has_passphrase, domain, notes, updated_at
         FROM identities WHERE shared = 1 AND deleted_at IS NULL
         ORDER BY name COLLATE NOCASE`
      )
      .all() as {
      id: string
      name: string
      username: string | null
      has_password: number
      key_id: string | null
      has_passphrase: number
      domain: string | null
      notes: string | null
      updated_at: number
    }[]
    const users = new Map<string, string[]>()
    const linked = this.db
      .prepare(
        `SELECT h.id, h.identity_id FROM hosts h JOIN identities i ON i.id = h.identity_id
         WHERE h.deleted_at IS NULL AND i.shared = 1 ORDER BY h.label COLLATE NOCASE`
      )
      .all() as { id: string; identity_id: string }[]
    for (const l of linked) users.set(l.identity_id, [...(users.get(l.identity_id) ?? []), l.id])
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      username: r.username ?? '',
      hasPassword: r.has_password === 1,
      keyId: r.key_id,
      hasPassphrase: r.has_passphrase === 1,
      domain: r.domain ?? '',
      notes: r.notes ?? '',
      hostIds: users.get(r.id) ?? [],
      updatedAt: r.updated_at
    }))
  }

  /**
   * Tạo / sửa tài khoản. Mật khẩu / passphrase: undefined = giữ, '' = xoá. Đổi hoặc bỏ key thì
   * passphrase cũ bị xoá (nó thuộc về key cũ) trừ khi nhập passphrase mới.
   */
  saveAccount(input: AccountInput): string {
    const now = this.now()
    const name = input.name.trim()
    return this.db.transaction(() => {
      const existing = input.id ? this.accountRow(input.id) : undefined
      if (input.id && !existing) throw new Error(t('The account no longer exists'))
      const clash = this.db
        .prepare(
          `SELECT 1 FROM identities WHERE shared = 1 AND deleted_at IS NULL AND id IS NOT ?
             AND name = ? COLLATE NOCASE`
        )
        .get(input.id ?? null, name)
      if (clash) throw new Error(t('There is already an account named “{name}”', { name }))
      if (input.keyId) {
        const key = this.db
          .prepare('SELECT 1 FROM keys WHERE id = ? AND deleted_at IS NULL')
          .get(input.keyId)
        if (!key) throw new Error(t('The selected key no longer exists'))
      }
      if (existing) this.checkAccountUsers(existing.id, input.username)

      const id = existing?.id ?? uuidv7(now)
      const seal = (field: 'secret_enc' | 'passphrase_enc', value: string): Buffer =>
        this.vault.encryptString({ table: 'identities', id, field }, value)
      const password =
        input.password === undefined
          ? (existing?.secret_enc ?? null)
          : input.password === ''
            ? null
            : seal('secret_enc', input.password)
      const passphrase = !input.keyId
        ? null
        : input.passphrase !== undefined
          ? input.passphrase === ''
            ? null
            : seal('passphrase_enc', input.passphrase)
          : existing?.key_id === input.keyId
            ? existing.passphrase_enc
            : null
      const values = [
        name,
        input.username,
        splitAuthType(input.keyId, password !== null),
        password,
        input.keyId,
        passphrase,
        input.domain || null,
        input.notes.trim() || null,
        now
      ]
      if (existing) {
        this.db
          .prepare(
            `UPDATE identities SET name = ?, username = ?, auth_type = ?, secret_enc = ?, key_id = ?,
                    passphrase_enc = ?, domain = ?, notes = ?, updated_at = ? WHERE id = ?`
          )
          .run(...values, id)
      } else {
        this.db
          .prepare(
            `INSERT INTO identities (name, username, auth_type, secret_enc, key_id, passphrase_enc,
                                     domain, notes, updated_at, id, shared, split_secrets)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`
          )
          .run(...values, id)
      }
      return id
    })()
  }

  /** Nhân bản tài khoản (kể cả mật khẩu / passphrase trong vault). Trả về id mới. */
  duplicateAccount(id: string): string {
    const now = this.now()
    return this.db.transaction(() => {
      const account = this.accountRow(id)
      if (!account) throw new Error(t('The account no longer exists'))
      const root = account.name.replace(/ \(copy(?: \d+)?\)$/, '')
      const taken = this.db.prepare(
        `SELECT 1 FROM identities WHERE shared = 1 AND deleted_at IS NULL
           AND name = ? COLLATE NOCASE`
      )
      for (let n = 1; ; n++) {
        const name = n === 1 ? `${root} (copy)` : `${root} (copy ${n})`
        if (!taken.get(name)) return this.copyIdentity(account, { name, shared: true }, now)
      }
    })()
  }

  /**
   * Xoá tài khoản. Đang có host dùng thì phải chọn cách xử lý: chuyển các host sang tài khoản khác
   * (`reassign`) hoặc chép thông tin tài khoản vào từng host (`convert` — host vẫn kết nối được như
   * cũ). Không chọn → lỗi, không xoá gì.
   */
  deleteAccount(id: string, resolution: AccountDeleteResolution | null = null): void {
    const now = this.now()
    this.db.transaction(() => {
      const account = this.accountRow(id)
      if (!account) return
      const users = this.db
        .prepare('SELECT id FROM hosts WHERE identity_id = ? AND deleted_at IS NULL')
        .all(id) as { id: string }[]
      if (users.length > 0) {
        if (!resolution)
          throw new Error(
            tn(users.length, 'The account is used by {n} host', 'The account is used by {n} hosts')
          )
        if (resolution.mode === 'reassign') {
          if (resolution.accountId === id)
            throw new Error(t('Choose a different account for the hosts'))
          const target = this.accountRow(resolution.accountId)
          if (!target) throw new Error(t('The selected account no longer exists'))
          this.checkAccountUsers(id, target.username ?? '')
          this.db
            .prepare('UPDATE hosts SET identity_id = ?, updated_at = ? WHERE identity_id = ?')
            .run(target.id, now, id)
        } else {
          const relink = this.db.prepare(
            'UPDATE hosts SET identity_id = ?, updated_at = ? WHERE id = ?'
          )
          for (const host of users) {
            const copy = this.copyIdentity(account, { name: account.name, shared: false }, now)
            relink.run(copy, now, host.id)
          }
        }
      }
      // Host đã xoá (tombstone) có thể vẫn trỏ tới; khoá ngoại SET NULL không áp vì chỉ xoá mềm.
      this.db
        .prepare(
          `UPDATE identities SET secret_enc = NULL, passphrase_enc = NULL, deleted_at = ?,
                  updated_at = ? WHERE id = ?`
        )
        .run(now, now, id)
    })()
  }

  /** Username mới của tài khoản phải dùng được cho mọi host đang dùng nó (SSH / Windows). */
  private checkAccountUsers(accountId: string, username: string): void {
    const hosts = this.db
      .prepare('SELECT label, options FROM hosts WHERE identity_id = ? AND deleted_at IS NULL')
      .all(accountId) as { label: string; options: string }[]
    for (const h of hosts) {
      const protocol = parseJson<HostOptions>(h.options, {}).protocol ?? 'ssh'
      const problem = usernameProblem(protocol, username)
      if (problem) throw new Error(`${problem} (${h.label})`)
    }
  }

  private identityRow(id: string): IdentityRow | undefined {
    return this.db
      .prepare(
        `SELECT id, name, username, auth_type, secret_enc, key_id, shared, split_secrets,
                passphrase_enc, domain, notes
         FROM identities WHERE id = ? AND deleted_at IS NULL`
      )
      .get(id) as IdentityRow | undefined
  }

  private accountRow(id: string): IdentityRow | undefined {
    const row = this.identityRow(id)
    return row?.shared === 1 ? row : undefined
  }

  /** Chép một identity sang id mới (secret được mã hoá gắn với id → giải mã rồi mã hoá lại). */
  private copyIdentity(
    row: IdentityRow,
    target: { name: string; shared: boolean },
    now: number
  ): string {
    const id = uuidv7(now)
    const reseal = (field: 'secret_enc' | 'passphrase_enc', blob: Buffer | null): Buffer | null => {
      if (!blob) return null
      const secret = this.vault.decrypt({ table: 'identities', id: row.id, field }, blob)
      try {
        return this.vault.encryptString({ table: 'identities', id, field }, secret.revealString())
      } finally {
        secret.dispose()
      }
    }
    this.db
      .prepare(
        `INSERT INTO identities (id, name, username, auth_type, secret_enc, key_id, updated_at,
                                 shared, split_secrets, passphrase_enc, domain, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        target.name,
        row.username,
        row.auth_type,
        reseal('secret_enc', row.secret_enc),
        row.key_id,
        now,
        target.shared ? 1 : 0,
        row.split_secrets,
        reseal('passphrase_enc', row.passphrase_enc),
        row.domain,
        row.notes
      )
    return id
  }

  /**
   * Giải mã mật khẩu / passphrase của identity theo cách lưu của nó — dạng split: hai cột riêng;
   * dạng cũ: secret_enc là mật khẩu (auth = password) hoặc passphrase (auth = key).
   */
  private identitySecrets(row: IdentitySecretsRow): IdentitySecrets {
    const id = row.identity_id
    if (!id) return { password: null, passphrase: null }
    const open = (field: 'secret_enc' | 'passphrase_enc', blob: Buffer | null): Secret | null =>
      blob ? this.vault.decrypt({ table: 'identities', id, field }, blob) : null
    if (row.split_secrets === 1) {
      const password = open('secret_enc', row.secret_enc)
      try {
        return { password, passphrase: open('passphrase_enc', row.passphrase_enc) }
      } catch (error) {
        password?.dispose()
        throw error
      }
    }
    return {
      password: row.auth_type === 'password' ? open('secret_enc', row.secret_enc) : null,
      passphrase: row.auth_type === 'key' ? open('secret_enc', row.secret_enc) : null
    }
  }

  /** Private key trong vault (dạng gửi cho Session Host); null = key đã bị xoá. */
  private loadKey(id: string): { data: string; label: string } | null {
    const key = this.db
      .prepare('SELECT name, private_key_enc FROM keys WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { name: string; private_key_enc: Buffer } | undefined
    if (!key) return null
    const pem = this.vault.decrypt(
      { table: 'keys', id, field: 'private_key_enc' },
      key.private_key_enc
    )
    try {
      return { data: pem.revealString(), label: key.name }
    } finally {
      pem.dispose()
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
    if (!host) throw new Error(t('Host not found'))
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
      if (result.changes === 0) throw new Error(t('Forward not found'))
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
                i.auth_type, i.secret_enc, i.key_id, i.split_secrets, i.passphrase_enc
         FROM hosts h LEFT JOIN identities i ON i.id = h.identity_id
         WHERE h.id = ? AND h.deleted_at IS NULL`
      )
      .get(hostId) as
      | (IdentitySecretsRow & {
          label: string
          hostname: string
          port: number
          options: string
          username: string | null
          key_id: string | null
        })
      | undefined
    if (!row) throw new Error(t('Host not found'))
    const options = parseJson<HostOptions>(row.options, {})
    const inherited = this.inheritedFor(hostId)
    const username = row.username || inherited.username?.value
    if (!username)
      throw new Error(
        t('"{name}" has no username — set one on the host or on its group', { name: row.label })
      )
    const port = options.inheritPort ? (inherited.port?.value ?? 22) : row.port

    const credentials: ResolvedHost['credentials'] = {}
    // Dạng split (tài khoản): có thể có cả key lẫn mật khẩu — thử key trước rồi tới mật khẩu
    // (thứ tự của bộ xác thực trong Session Host). Dạng cũ: một trong hai theo auth_type.
    const split = row.split_secrets === 1
    const keyId = split || row.auth_type === 'key' ? row.key_id : null
    const secrets = this.identitySecrets(row)
    const automatic = split ? !keyId && !secrets.password : row.auth_type === 'agent'
    try {
      if (secrets.password) credentials.password = secrets.password.revealString()
      // Automatic: thử thêm key mặc định của nhóm (nếu key vẫn còn trong vault).
      if (automatic && inherited.keyId) {
        const groupKey = this.loadKey(inherited.keyId.value)
        if (groupKey) credentials.privateKey = groupKey
      }
      if (keyId) {
        const key = this.loadKey(keyId)
        if (!key) throw new Error(t('The key of this host has been deleted'))
        credentials.privateKey = {
          ...key,
          ...(secrets.passphrase ? { passphrase: secrets.passphrase.revealString() } : {})
        }
      }
    } finally {
      secrets.password?.dispose()
      secrets.passphrase?.dispose()
    }

    return {
      label: row.label,
      target: { host: row.hostname, port, username },
      credentials,
      ...(options.keyFile ? { keyFiles: [options.keyFile] } : {}),
      ...(options.legacy ? { legacyAlgorithms: true } : {}),
      ...((split ? !automatic : row.auth_type === 'password' || row.auth_type === 'key')
        ? { storedOnly: true }
        : {}),
      ...(options.tmux ? { tmux: true } : {})
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
