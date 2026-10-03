import { t } from '@shared/i18n'
import type { HostSummary } from '@shared/hosts'
import type { PromptRequest } from '@shared/stream-protocol'
import type { ActivePrompt } from '../terminal/controller'
import { useHosts } from './hosts'
import { useTabStatus } from './tab-status'
import { useTabs } from './tabs'
import { toast } from './toasts'
import { useVault } from './vault'

/**
 * Ghi nhớ thông tin đăng nhập người dùng gõ ở hộp hỏi (PromptDialog):
 * - "Save password in vault": mật khẩu của host đã lưu — CHỈ ghi vào vault sau khi tab kết nối được
 *   (gõ sai thì server hỏi lại / phiên kết thúc → bỏ, không lưu mật khẩu sai).
 * - "Remember for this session": passphrase của key, giữ trong bộ nhớ tới khi thoát app hoặc khoá
 *   vault; lần sau hỏi lại cùng key thì tự trả lời.
 *
 * Chỉ áp dụng cho prompt của tab terminal (biết được tab nào để theo dõi kết nối thành công).
 */

type Kind = 'password' | 'passphrase'

interface Pending {
  kind: Kind
  tabId: string
  /** user@host (mật khẩu) hoặc đường dẫn key (passphrase). */
  key: string
  hostId: string | null
  label: string
  secret: string
  at: number
}

/** Quá lâu không kết nối xong → bỏ (không giữ mật khẩu trong bộ nhớ vô thời hạn). */
const PENDING_TTL_MS = 3 * 60_000
/** Đã tự trả lời passphrase mà vẫn bị hỏi lại trong khoảng này → passphrase nhớ sai. */
const RETRY_WINDOW_MS = 20_000

const pending = new Map<string, Pending>()
const passphrases = new Map<string, string>()
const autoAnswered = new Map<string, number>()
let watching: (() => void) | null = null

const slot = (tabId: string, kind: Kind, key: string): string => `${tabId}\n${kind}\n${key}`

/** Tab đang hiện prompt này (TerminalView đặt prompt vào tab-status); null = không phải tab terminal. */
export function promptTab(prompt: ActivePrompt): string | null {
  for (const [tabId, p] of Object.entries(useTabStatus.getState().prompts))
    if (p === prompt) return tabId
  return null
}

export function passwordKey(request: Extract<PromptRequest, { kind: 'password' }>): string {
  return `${request.username}@${request.host}`.toLowerCase()
}

/**
 * Host đã lưu ứng với prompt mật khẩu: host của tab nếu khớp user@host, không thì host (hoặc jump
 * host) khớp dùng gần nhất. Host dùng SSH key không nhận (secret của nó là passphrase).
 */
export function savedHostForPassword(
  request: Extract<PromptRequest, { kind: 'password' }>,
  tabId: string | null
): HostSummary | null {
  const { tree, effective } = useHosts.getState()
  const host = request.host.toLowerCase()
  const user = request.username
  const matches = tree.hosts.filter(
    (h) =>
      h.protocol === 'ssh' &&
      h.auth !== 'key' &&
      h.hostname.toLowerCase() === host &&
      (effective.get(h.id)?.username ?? h.username) === user
  )
  if (matches.length === 0) return null
  const tab = tabId ? useTabs.getState().tabs.find((x) => x.id === tabId) : undefined
  const tabHost = tab?.target.kind === 'host' ? tab.target.hostId : null
  return (
    matches.find((h) => h.id === tabHost) ??
    [...matches].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0] ??
    null
  )
}

export function vaultUnlocked(): boolean {
  return useVault.getState().state === 'unlocked'
}

/** Server hỏi lại cùng tài khoản trong cùng tab → lần trước gõ sai: bỏ cái đang chờ lưu. */
export function dropPending(tabId: string, kind: Kind, key: string): void {
  pending.delete(slot(tabId, kind, key))
}

export function rememberAfterLogin(entry: Omit<Pending, 'at'>): void {
  pending.set(slot(entry.tabId, entry.kind, entry.key), { ...entry, at: Date.now() })
  watch()
}

/**
 * Passphrase đã nhớ cho key này; null = chưa nhớ, hoặc vừa tự trả lời trong CÙNG tab mà bị hỏi lại
 * (passphrase sai → quên nó). Tab khác mở cùng lúc vẫn dùng được.
 */
export function takeRememberedPassphrase(keyPath: string, tabId: string | null): string | null {
  const value = passphrases.get(keyPath)
  if (value === undefined) return null
  const attempt = `${tabId ?? ''}\n${keyPath}`
  const last = autoAnswered.get(attempt)
  if (last !== undefined && Date.now() - last < RETRY_WINDOW_MS) {
    passphrases.delete(keyPath)
    autoAnswered.delete(attempt)
    return null
  }
  autoAnswered.set(attempt, Date.now())
  return value
}

export function forgetRemembered(): void {
  passphrases.clear()
  autoAnswered.clear()
  pending.clear()
}

async function commit(entry: Pending): Promise<void> {
  if (entry.kind === 'passphrase') {
    passphrases.set(entry.key, entry.secret)
    return
  }
  if (!entry.hostId) return
  const result = await window.shellhouse.setHostPassword(entry.hostId, entry.secret)
  if (result.ok) toast.success(t('Password saved for {name}', { name: entry.label }))
  else
    toast.error(t('Could not save the password for {name}', { name: entry.label }), {
      description: result.message
    })
}

function watch(): void {
  if (watching) return
  watching = useTabStatus.subscribe((s, prev) => {
    const now = Date.now()
    for (const [id, entry] of pending) {
      const state = s.byTab[entry.tabId]
      if (state === 'connected' && prev.byTab[entry.tabId] !== 'connected') {
        pending.delete(id)
        void commit(entry)
      } else if (
        state === 'disconnected' ||
        state === 'exited' ||
        (state === undefined && entry.tabId in prev.byTab) ||
        now - entry.at > PENDING_TTL_MS
      ) {
        pending.delete(id)
      }
    }
    if (pending.size === 0) {
      watching?.()
      watching = null
    }
  })
}

// Khoá vault → quên mọi passphrase / mật khẩu đang giữ trong bộ nhớ.
useVault.subscribe((s, prev) => {
  if (s.state !== prev.state && s.state !== 'unlocked') forgetRemembered()
})
