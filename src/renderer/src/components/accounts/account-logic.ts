import { t } from '@shared/i18n'
import { bestScore } from '@shared/fuzzy'
import {
  Username,
  type AccountSummary,
  type AuthKind,
  type HostProtocol,
  type KeySummary
} from '@shared/hosts'
import { RdpUsername } from '@shared/rdp'

/**
 * Logic thuần của tài khoản dùng chung phía renderer (chọn tài khoản trong form host, danh sách ở
 * Settings → Accounts) — tách khỏi component để test không cần DOM.
 */

export type AccountBadgeKind = 'key' | 'password' | 'passphrase' | 'domain'

export interface AccountBadge {
  kind: AccountBadgeKind
  label: string
}

/** Nhãn ngắn cho những gì tài khoản có: SSH key (tên key), mật khẩu, passphrase, domain. */
export function accountBadges(
  account: AccountSummary,
  keys: readonly KeySummary[]
): AccountBadge[] {
  const badges: AccountBadge[] = []
  if (account.keyId) {
    const key = keys.find((k) => k.id === account.keyId)
    badges.push({ kind: 'key', label: key ? key.name : t('SSH key (deleted)') })
  }
  if (account.hasPassword) badges.push({ kind: 'password', label: t('Password') })
  if (account.keyId && account.hasPassphrase)
    badges.push({ kind: 'passphrase', label: 'passphrase' })
  if (account.domain) badges.push({ kind: 'domain', label: account.domain })
  return badges
}

/** "deploy" / "CORP\\john" — chuỗi username hiển thị; '' = tài khoản không đặt username. */
export function accountUser(account: AccountSummary): string {
  if (!account.username) return ''
  return account.domain ? `${account.domain}\\${account.username}` : account.username
}

/** Lọc + xếp hạng tài khoản theo ô tìm (tên, username, domain, ghi chú). */
export function filterAccounts(
  accounts: readonly AccountSummary[],
  query: string
): AccountSummary[] {
  const q = query.trim()
  if (!q) return [...accounts]
  return accounts
    .map((a) => ({ a, score: bestScore(q, [a.name, a.username, a.domain, a.notes]) }))
    .filter((x): x is { a: AccountSummary; score: number } => x.score !== null)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a)
}

/** Lý do tài khoản không dùng được cho host giao thức này (username sai quy tắc); null = được. */
export function accountProblem(account: AccountSummary, protocol: HostProtocol): string | null {
  if (protocol !== 'ssh' && protocol !== 'rdp')
    return t('Accounts can only be used by SSH and Remote Desktop hosts')
  if (!account.username) return null
  if (protocol === 'rdp')
    return RdpUsername.safeParse(account.username).success
      ? null
      : t('“{value}” is not a valid Windows username', { value: account.username })
  return Username.safeParse(account.username).success
    ? null
    : t('“{value}” is not a valid SSH username', { value: account.username })
}

/** Giá trị form host sau khi chuyển từ tài khoản sang "Custom" (secret do main chép — secretsFrom). */
export interface CustomCredentials {
  username: string
  auth: AuthKind
  keyId: string | null
  /** RDP: domain của tài khoản ('' = giữ domain đang có ở host). */
  domain: string
  /** RDP: lưu mật khẩu trong vault (tài khoản có mật khẩu). */
  savePassword: boolean
}

export function customFromAccount(account: AccountSummary): CustomCredentials {
  return {
    username: account.username,
    // Như khi kết nối: key trước, rồi mật khẩu; không có gì = Automatic.
    auth: account.keyId ? 'key' : account.hasPassword ? 'password' : 'auto',
    keyId: account.keyId,
    domain: account.domain,
    savePassword: account.hasPassword
  }
}

/** Tên gợi ý cho tài khoản tạo nhanh từ form host (không trùng tên đã có). */
export function suggestAccountName(
  accounts: readonly AccountSummary[],
  username: string,
  hostname: string
): string {
  const base = username && hostname ? `${username}@${hostname}` : username || hostname || ''
  if (!base) return ''
  const taken = new Set(accounts.map((a) => a.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const name = `${base} (${n})`
    if (!taken.has(name.toLowerCase())) return name
  }
}
