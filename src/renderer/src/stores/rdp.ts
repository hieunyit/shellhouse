import { create } from 'zustand'
import { t } from '@shared/i18n'
import type { RdpStatusEvent } from '@shared/rdp'
import type { ActivePrompt } from '../terminal/controller'
import { RdpTunnel } from '../lib/rdp-tunnel'
import { useHosts } from './hosts'
import { setHostOpener } from './tabs'
import { toast } from './toasts'

/**
 * Phiên Remote Desktop đang mở. Client RDP chạy ngoài app (cửa sổ riêng của hệ điều hành) nên
 * không có tab — thẻ trạng thái nhỏ ở góc (RdpConnections) cho biết đang kết nối thế nào và có nút
 * Disconnect.
 *
 * - checking: kiểm tra client / cấu hình
 * - password: chờ người dùng gõ mật khẩu (FreeRDP, host không lưu mật khẩu)
 * - tunnel: đang mở tunnel SSH
 * - launching: đang chạy client
 * - running: client đang chạy (Shellhouse giữ tiến trình)
 * - detached: đã giao cho ứng dụng khác (macOS Windows App, Remmina đang chạy sẵn) — không biết khi
 *   nào nó đóng; tunnel giữ tới khi bấm Disconnect
 * - failed: lỗi (giữ thẻ để đọc, có Retry)
 */
export type RdpPhase =
  'checking' | 'password' | 'tunnel' | 'launching' | 'running' | 'detached' | 'failed'

export interface RdpConnection {
  id: string
  hostId: string
  label: string
  fullScreen: boolean | undefined
  phase: RdpPhase
  /** "mstsc", "xfreerdp3", "Windows App"… */
  client: string | null
  /** Tên đăng nhập hiển thị trong hộp hỏi mật khẩu. */
  username: string
  /** SSH host trung gian (nếu có). */
  via: string | null
  /** Cổng local của tunnel khi đã mở. */
  tunnelPort: number | null
  /** Tiến trình kết nối SSH của tunnel. */
  detail: string | null
  error: string | null
  hint: string | null
  /** Prompt SSH của tunnel (host key, mật khẩu…). */
  prompt: ActivePrompt | null
  launchId: string | null
}

interface RdpState {
  connections: RdpConnection[]
}

export const useRdp = create<RdpState>(() => ({ connections: [] }))

const tunnels = new Map<string, RdpTunnel>()
/** Hộp hỏi mật khẩu đang chờ: id phiên → trả lời (null = huỷ). */
const passwordWaiters = new Map<string, (password: string | null) => void>()

function patch(id: string, change: Partial<RdpConnection>): void {
  useRdp.setState((s) => ({
    connections: s.connections.map((c) => (c.id === id ? { ...c, ...change } : c))
  }))
}

const find = (id: string): RdpConnection | undefined =>
  useRdp.getState().connections.find((c) => c.id === id)

function remove(id: string): void {
  useRdp.setState((s) => ({ connections: s.connections.filter((c) => c.id !== id) }))
}

function fail(id: string, error: string, hint: string | null = null): void {
  tunnels.get(id)?.close()
  tunnels.delete(id)
  if (find(id)) patch(id, { phase: 'failed', error, hint, prompt: null, detail: null })
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
}

function askPassword(id: string): Promise<string | null> {
  patch(id, { phase: 'password' })
  return new Promise((resolve) => {
    passwordWaiters.set(id, resolve)
  })
}

/** Trả lời hộp hỏi mật khẩu (null = huỷ kết nối). */
export function answerRdpPassword(id: string, password: string | null): void {
  const resolve = passwordWaiters.get(id)
  passwordWaiters.delete(id)
  resolve?.(password)
}

/** Trả lời prompt SSH của tunnel. */
export function answerRdpPrompt(
  id: string,
  promptId: number,
  ok: boolean,
  answers: string[]
): void {
  tunnels.get(id)?.answer(promptId, ok, answers)
}

/**
 * Kết nối một host RDP: kiểm tra client → (hỏi mật khẩu) → (mở tunnel SSH) → chạy client.
 * `fullScreen` ghi đè cài đặt của host (menu "Connect full screen").
 */
export async function connectRdp(
  hostId: string,
  options: { fullScreen?: boolean } = {}
): Promise<void> {
  const host = useHosts.getState().tree.hosts.find((h) => h.id === hostId)
  const id = crypto.randomUUID()
  useRdp.setState((s) => ({
    connections: [
      ...s.connections,
      {
        id,
        hostId,
        label: host?.label ?? hostId,
        fullScreen: options.fullScreen,
        phase: 'checking',
        client: null,
        username: '',
        via: null,
        tunnelPort: null,
        detail: null,
        error: null,
        hint: null,
        prompt: null,
        launchId: null
      }
    ]
  }))
  try {
    const check = await window.shellhouse.rdpCheck(hostId)
    if (!find(id)) return
    if (!check.ok) {
      fail(id, check.message, check.hint)
      return
    }
    patch(id, {
      client: check.client.name,
      username: check.username,
      via: check.via?.label ?? null
    })
    let password: string | undefined
    if (check.askPassword) {
      const typed = await askPassword(id)
      if (typed === null || !find(id)) {
        remove(id)
        return
      }
      password = typed
    }
    let tunnelPort: number | undefined
    if (check.via) {
      patch(id, { phase: 'tunnel', detail: null })
      const tunnel = new RdpTunnel({
        status: (detail) => {
          patch(id, { detail })
        },
        prompt: (prompt) => {
          patch(id, { prompt })
        },
        lost: (reason) => {
          tunnels.delete(id)
          const c = find(id)
          if (!c) return
          // Tunnel đứt thì client RDP cũng mất kết nối — đóng nó luôn, giữ thẻ để báo lý do.
          if (c.launchId) void window.shellhouse.rdpStop(c.launchId).catch(() => undefined)
          patch(id, { launchId: null, tunnelPort: null })
          fail(
            id,
            t('The SSH tunnel through {via} closed: {reason}', { via: c.via ?? '?', reason })
          )
        }
      })
      tunnels.set(id, tunnel)
      tunnelPort = await tunnel.open(check.via.id, check.target)
      if (!find(id)) {
        tunnel.close()
        return
      }
      patch(id, { tunnelPort, detail: null, prompt: null })
    }
    patch(id, { phase: 'launching' })
    const result = await window.shellhouse.rdpLaunch({
      hostId,
      ...(options.fullScreen !== undefined ? { fullScreen: options.fullScreen } : {}),
      ...(tunnelPort !== undefined ? { tunnelPort } : {}),
      ...(password !== undefined ? { password } : {})
    })
    password = undefined
    if (!result.ok) {
      fail(id, result.message, result.hint)
      return
    }
    if (!find(id)) {
      // Bấm Disconnect trong lúc đang chạy client.
      void window.shellhouse.rdpStop(result.launchId).catch(() => undefined)
      return
    }
    patch(id, {
      launchId: result.launchId,
      client: result.client.name,
      phase: result.tracked ? 'running' : 'detached'
    })
  } catch (error) {
    if (find(id)?.phase === 'failed') return
    fail(id, errorText(error))
  }
}

/** Disconnect / Dismiss: đóng client (nếu Shellhouse giữ), đóng tunnel, bỏ thẻ. */
export function disconnectRdp(id: string): void {
  const c = find(id)
  answerRdpPassword(id, null)
  tunnels.get(id)?.close()
  tunnels.delete(id)
  remove(id)
  if (c?.launchId) void window.shellhouse.rdpStop(c.launchId).catch(() => undefined)
}

/** Thử lại phiên lỗi với cùng tuỳ chọn. */
export function retryRdp(id: string): void {
  const c = find(id)
  if (!c) return
  disconnectRdp(id)
  void connectRdp(c.hostId, c.fullScreen !== undefined ? { fullScreen: c.fullScreen } : {})
}

/** Client RDP thoát / được giao cho ứng dụng khác (sự kiện từ main). */
export function handleRdpStatus(event: RdpStatusEvent): void {
  const c = useRdp.getState().connections.find((x) => x.launchId === event.launchId)
  if (!c) return
  if (event.state === 'detached') {
    patch(c.id, { phase: 'detached' })
    return
  }
  tunnels.get(c.id)?.close()
  tunnels.delete(c.id)
  if (event.message) {
    patch(c.id, { launchId: null, tunnelPort: null })
    fail(c.id, event.message)
    return
  }
  remove(c.id)
  toast.info(t('Remote Desktop session to {name} ended', { name: c.label }), {
    group: `rdp-${c.id}`
  })
}

/** Host RDP? (thanh bên / Home / bảng lệnh mở bằng client RDP thay vì tab terminal). */
export function isRdpHost(hostId: string): boolean {
  return useHosts.getState().tree.hosts.some((h) => h.id === hostId && h.protocol === 'rdp')
}

/** Mở host RDP trong tab của app (trình xem nhúng đăng ký qua `registerRdpTabOpener`). */
export type RdpTabOpener = (
  host: { id: string; label: string },
  options: { fullScreen?: boolean }
) => void
let tabOpener: RdpTabOpener | null = null

/**
 * API dùng chung: trình xem RDP nhúng (tab kind 'rdp') đăng ký hàm mở tab. Chưa đăng ký → host
 * "Open in: App tab" cũng mở bằng client RDP của hệ điều hành.
 */
export function registerRdpTabOpener(opener: RdpTabOpener | null): void {
  tabOpener = opener
}

/**
 * Mở host RDP theo cài đặt của host: tab trong app (mặc định) hoặc client của hệ điều hành.
 * `external` = luôn dùng client của hệ điều hành (menu "Open in external client").
 */
export function openRdpHost(
  hostId: string,
  options: { fullScreen?: boolean; external?: boolean } = {}
): void {
  const host = useHosts.getState().tree.hosts.find((h) => h.id === hostId)
  const view = options.fullScreen !== undefined ? { fullScreen: options.fullScreen } : {}
  if (host && !options.external && host.rdp?.openWith !== 'native' && tabOpener) {
    tabOpener({ id: host.id, label: host.label }, view)
    return
  }
  void connectRdp(hostId, view)
}

// Thanh bên / Home / bảng lệnh / mở nhiều host: host RDP không mở thành tab terminal.
setHostOpener((hostId) => {
  if (!isRdpHost(hostId)) return false
  openRdpHost(hostId)
  return true
})

// Chỉ đăng ký khi có preload (test logic thuần của renderer không có window.shellhouse đầy đủ).
if (
  typeof window !== 'undefined' &&
  typeof (window.shellhouse as Partial<typeof window.shellhouse> | undefined)?.onRdpStatus ===
    'function'
)
  window.shellhouse.onRdpStatus(handleRdpStatus)
