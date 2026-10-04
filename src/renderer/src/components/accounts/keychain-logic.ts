import { bestScore } from '@shared/fuzzy'
import type { AccountSummary, GroupSummary, HostSummary, KeySummary } from '@shared/hosts'

/**
 * Logic thuần của Keychain (Settings → Keychain: tài khoản + SSH key trong một danh sách) — tách
 * khỏi component để test không cần DOM.
 */

export type KeychainFilter = 'all' | 'accounts' | 'keys'

export type KeychainItem =
  | { kind: 'account'; id: string; account: AccountSummary }
  | { kind: 'key'; id: string; key: KeySummary }

/** Chọn một mục: kind + id (giữ được khi danh sách nạp lại). */
export interface KeychainSelection {
  kind: KeychainItem['kind']
  id: string
}

/** Ai đang dùng một SSH key: tài khoản, host (trực tiếp hoặc qua tài khoản), nhóm đặt làm mặc định. */
export interface KeyUsage {
  accounts: AccountSummary[]
  /** Host đặt key này trực tiếp (thông tin riêng của host, không qua tài khoản). */
  directHostIds: string[]
  /** Mọi host dùng key: trực tiếp + qua tài khoản (không trùng). */
  hostIds: string[]
  /** Nhóm đặt key này làm mặc định cho host bên trong. */
  groups: GroupSummary[]
}

const byName = <T extends { name: string }>(a: T, b: T): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

/**
 * Host dùng key: trực tiếp (host không gắn tài khoản, keyId = key) và qua các tài khoản dùng key.
 * Khớp với điều kiện chặn xoá ở main (HostsService.deleteKey đếm mọi identity có key_id này).
 */
export function keyUsage(
  key: Pick<KeySummary, 'id'>,
  tree: {
    accounts: readonly AccountSummary[]
    hosts: readonly HostSummary[]
    groups?: readonly GroupSummary[]
  }
): KeyUsage {
  const accounts = tree.accounts.filter((a) => a.keyId === key.id).sort(byName)
  const directHostIds = tree.hosts
    .filter((h) => !h.accountId && h.keyId === key.id)
    .map((h) => h.id)
  const hostIds = [...new Set([...directHostIds, ...accounts.flatMap((a) => a.hostIds)])]
  const groups = (tree.groups ?? []).filter((g) => g.defaults.keyId === key.id).sort(byName)
  return { accounts, directHostIds, hostIds, groups }
}

/** Key đang được tài khoản / host dùng → main không cho xoá (gỡ khỏi chúng trước). */
export function keyInUse(usage: KeyUsage): boolean {
  return usage.accounts.length > 0 || usage.directHostIds.length > 0
}

function accountScore(a: AccountSummary, q: string): number | null {
  return bestScore(q, [a.name, a.username, a.domain, a.notes])
}

function keyScore(k: KeySummary, q: string): number | null {
  const fuzzy = bestScore(q, [k.name, k.type])
  // Fingerprint là base64 ngẫu nhiên: tìm mờ khớp gần như mọi thứ → chỉ khớp chuỗi con.
  const exact = k.fingerprint.toLowerCase().includes(q.trim().toLowerCase()) ? 1 : null
  return fuzzy === null ? exact : Math.max(fuzzy, exact ?? 0)
}

/** Mục khớp ô tìm của từng loại (đã xếp: có từ khoá thì theo điểm, không thì theo tên). */
export function matchKeychain(
  accounts: readonly AccountSummary[],
  keys: readonly KeySummary[],
  query: string
): { accounts: KeychainItem[]; keys: KeychainItem[] } {
  const q = query.trim()
  const rank = <T extends { name: string }>(
    list: readonly T[],
    score: (x: T, q: string) => number | null
  ): T[] =>
    q
      ? list
          .map((x) => ({ x, s: score(x, q) }))
          .filter((r): r is { x: T; s: number } => r.s !== null)
          .sort((a, b) => b.s - a.s || byName(a.x, b.x))
          .map((r) => r.x)
      : [...list].sort(byName)
  return {
    accounts: rank(accounts, accountScore).map((account) => ({
      kind: 'account' as const,
      id: account.id,
      account
    })),
    keys: rank(keys, keyScore).map((key) => ({ kind: 'key' as const, id: key.id, key }))
  }
}

/** Danh sách hiển thị theo bộ lọc: tài khoản trước, rồi SSH key. */
export function visibleItems(
  matched: { accounts: KeychainItem[]; keys: KeychainItem[] },
  filter: KeychainFilter
): KeychainItem[] {
  if (filter === 'accounts') return matched.accounts
  if (filter === 'keys') return matched.keys
  return [...matched.accounts, ...matched.keys]
}

export const sameItem = (a: KeychainSelection | null, b: KeychainSelection | null): boolean =>
  a !== null && b !== null && a.kind === b.kind && a.id === b.id

/**
 * Mục chọn sau khi danh sách đổi (lọc, tìm, xoá): giữ mục đang chọn nếu còn hiện; không thì mục
 * cùng vị trí cũ (xoá xong nhảy sang mục kế), rồi mục đầu tiên.
 */
export function reconcileSelection(
  items: readonly KeychainItem[],
  selected: KeychainSelection | null,
  previousIndex = 0
): KeychainSelection | null {
  if (selected && items.some((i) => sameItem(i, selected))) return selected
  const fallback = items[Math.min(Math.max(previousIndex, 0), items.length - 1)]
  return fallback ? { kind: fallback.kind, id: fallback.id } : null
}

/** ↑/↓/Home/End trong danh sách — trả mục mới (null = danh sách rỗng). */
export function moveSelection(
  items: readonly KeychainItem[],
  selected: KeychainSelection | null,
  move: 'up' | 'down' | 'first' | 'last'
): KeychainSelection | null {
  if (items.length === 0) return null
  const index = items.findIndex((i) => sameItem(i, selected))
  const next =
    move === 'first'
      ? 0
      : move === 'last'
        ? items.length - 1
        : index === -1
          ? 0
          : Math.min(Math.max(index + (move === 'down' ? 1 : -1), 0), items.length - 1)
  const item = items[next]
  return item ? { kind: item.kind, id: item.id } : null
}

// ---------- Public key ----------

function base64Bytes(text: string): Uint8Array | null {
  try {
    const raw = atob(text)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** Đọc một `string` của SSH wire format (uint32 độ dài + dữ liệu) tại `offset`. */
function readString(bytes: Uint8Array, offset: number): { value: Uint8Array; next: number } | null {
  if (offset + 4 > bytes.length) return null
  const length =
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  const start = offset + 4
  if (length < 0 || start + length > bytes.length) return null
  return { value: bytes.subarray(start, start + length), next: start + length }
}

function mpintBits(value: Uint8Array): number {
  let i = 0
  while (i < value.length && value[i] === 0) i++
  if (i === value.length) return 0
  return (value.length - i - 1) * 8 + (32 - Math.clz32(value[i] ?? 0))
}

/**
 * Độ dài key (bit) từ dòng public key `ssh-rsa AAAA… comment`, như `ssh-keygen -l`:
 * Ed25519 = 256, ECDSA theo đường cong, RSA theo modulus. null = không đọc được.
 */
export function publicKeyBits(line: string): number | null {
  const [type, blob] = line.trim().split(/\s+/)
  if (!type || !blob) return null
  if (type === 'ssh-ed25519') return 256
  const curve = /^ecdsa-sha2-nistp(\d+)$/.exec(type)
  if (curve) return Number(curve[1])
  if (type !== 'ssh-rsa') return null
  const bytes = base64Bytes(blob)
  if (!bytes) return null
  const name = readString(bytes, 0)
  const e = name && readString(bytes, name.next)
  const n = e && readString(bytes, e.next)
  return n ? mpintBits(n.value) : null
}

/** "ED25519", "RSA 4096", "ECDSA 256" — loại key (+ số bit nếu biết; Ed25519 luôn 256 nên bỏ). */
export function keyTypeLabel(type: string, bits: number | null | undefined): string {
  const name = type.toUpperCase()
  return bits && type !== 'ed25519' ? `${name} ${String(bits)}` : name
}

/** Fingerprint rút gọn cho danh sách: "SHA256:AbCdEf…WxYz" (đủ để phân biệt bằng mắt). */
export function shortFingerprint(fingerprint: string): string {
  const [algo, hash] = fingerprint.includes(':')
    ? [
        fingerprint.slice(0, fingerprint.indexOf(':')),
        fingerprint.slice(fingerprint.indexOf(':') + 1)
      ]
    : ['', fingerprint]
  const short = hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
  return algo ? `${algo}:${short}` : short
}
