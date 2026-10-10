import { createElement, lazy, Suspense, useEffect, useMemo, type ComponentType } from 'react'
import { useHostStatus } from '../../renderer/src/stores/host-status'
import { create } from 'zustand'
import {
  Boxes,
  Cloud,
  Container,
  Database,
  Network,
  Puzzle,
  Server,
  Ship,
  type LucideIcon
} from 'lucide-react'
import type { ZodType } from 'zod'
import type { ConnectionPhase, ExitReason, PromptRequest } from '@shared/stream-protocol'
import type { TransferStatus } from '@shared/sftp'
import { openSession } from '../../renderer/src/lib/sessions'
import { useTabs, type ModuleTerminalTarget } from '../../renderer/src/stores/tabs'
import { useTabStatus } from '../../renderer/src/stores/tab-status'
import { useSettings } from '../../renderer/src/stores/settings'
import { useHosts } from '../../renderer/src/stores/hosts'
import { useAttention, type AttentionItem } from '../../renderer/src/stores/attention'
import {
  isMonitored as isMonitoredSource,
  useFleet,
  type FleetItem
} from '../../renderer/src/stores/fleet'
import { Activity, Check } from 'lucide-react'
import { PromptDialog } from '../../renderer/src/terminal/PromptDialog'
import { ErrorBoundary } from '../../renderer/src/components/ErrorBoundary'
import { toast } from '../../renderer/src/stores/toasts'
import { t } from '@shared/i18n'
import { SessionClient } from '../../renderer/src/terminal/session-client'
import type { TerminalState } from '../../renderer/src/terminal/controller'
import type { HostContext, ModuleMenuEntry, ModuleTabDef, RendererModule } from './renderer-types'
import type { ModuleState } from './types'
import { BackgroundSession, type BackgroundSessionHandlers } from './renderer-background'

/**
 * Bộ công cụ renderer cho module (ADR-014 mục 3.8): trạng thái bật / tắt, mở tab, gọi IPC, phiên
 * tới Session Host. Module chỉ dùng những hàm ở đây (và thành phần UI dùng chung), không đụng thẳng
 * store của lõi.
 *
 * File này KHÔNG import module nào (tránh vòng import): danh sách module được đăng ký lúc khởi
 * động bằng `registerRendererModules` (xem all-renderer.ts).
 */

let registered: readonly RendererModule[] = []

/**
 * Đợi Session Host chạy lại (sau khi khởi động lại) — mở phiên mới lúc nó chưa sẵn sàng sẽ hỏng.
 * Hết thời hạn vẫn trả về (để phiên tự báo lỗi rõ ràng).
 */
export function whenHostRunning(timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve) => {
    const ok = (): boolean => useHostStatus.getState().status?.state === 'running'
    if (ok()) {
      resolve()
      return
    }
    const timer = setTimeout(done, timeoutMs)
    const unsub = useHostStatus.subscribe(() => {
      if (ok()) done()
    })
    function done(): void {
      clearTimeout(timer)
      unsub()
      resolve()
    }
  })
}

/** Thông báo nổi (toast) của app — module dùng để báo kết quả thao tác. */
export { toast, type ToastAction } from '../../renderer/src/stores/toasts'
export { usePublishTransfers } from '../../renderer/src/stores/transfers'
export { usePublishAttention, type AttentionItem } from '../../renderer/src/stores/attention'
export {
  isMonitored,
  type FleetItem,
  type FleetNote,
  type FleetStat,
  type FleetState
} from '../../renderer/src/stores/fleet'
export {
  hostEnvironmentId,
  setSourceEnvironment,
  useEnvironments,
  useHostEnvironmentId,
  useSourceEnvironment,
  useSourceEnvironmentMap
} from '../../renderer/src/stores/environments'
export {
  EnvironmentPicker,
  environmentMenu,
  environmentRules
} from '../../renderer/src/components/EnvironmentPicker'
export { useReportEnvironment } from '../../renderer/src/shell/report-env'
export {
  showCommands,
  shellQuote,
  type CommandLine
} from '../../renderer/src/components/CommandSheet'
export { environmentFromColor, type EnvironmentDef } from '@shared/environments'
export {
  ExplorerNav,
  NavTreeRow,
  useNavPlacement,
  useNavRow,
  type NavPlacement
} from '../../renderer/src/shell/ExplorerNav'
/** Đa ngôn ngữ + định dạng ngày / số / dung lượng theo locale — xem src/shared/i18n. */
export { t, tn, language, locale } from '@shared/i18n'
export {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDateTimeSeconds,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRate,
  formatRelative,
  formatTime,
  nameCollator
} from '@shared/i18n/format'
/** Cột điều hướng thu gọn thành dải icon (nhường chỗ ngang cho bảng + chi tiết). */
export {
  CollapsibleNav,
  NavCollapseToggle,
  NavItem,
  NAV_COLLAPSED_WIDTH,
  useCollapsedNav
} from '../../renderer/src/components/CollapsibleNav'
/** Ô mật khẩu có nút hiện / ẩn và cảnh báo Caps Lock. */
export { PasswordInput } from '../../renderer/src/components/PasswordInput'
/** Lựa chọn host cho ô tìm (host gắn tag ưu tiên lên đầu) — dùng với SearchList / SearchPicker. */
export { hostOptions } from '../../renderer/src/lib/host-pick'
/** Hộp thoại xác nhận của app (thay window.confirm) — xem stores/confirm. */
export {
  confirmAction,
  choose,
  type Choice,
  type ChooseOptions,
  type ConfirmOptions
} from '../../renderer/src/stores/confirm'
/** Editor trong app (tab riêng): module cung cấp cách đọc / ghi file. */
export {
  openEditorDoc,
  isBinaryName,
  fromBase64,
  toBase64,
  type EditorDoc,
  type EditorVersion
} from '../../renderer/src/editor/docs'
/**
 * Editor mã CodeMirror của app (theme, tìm kiếm, gập, Ctrl+S) — nạp lười: CodeMirror không vào
 * bundle khởi động. Đặt trong `<Suspense>`; `language` là Extension bất kỳ (ngôn ngữ + lint…).
 */
export const LazyCodeEditor = lazy(() =>
  import('../../renderer/src/editor/CodeEditor').then((m) => ({ default: m.CodeEditor }))
)
export type { CodeEditorHandle, CursorInfo } from '../../renderer/src/editor/CodeEditor'
/** Người dùng muốn sửa file văn bản bằng editor trong app (Cài đặt → Files). */
export function useEditInApp(): boolean {
  return useSettings((s) => s.settings.files.inApp)
}
export function registerRendererModules(modules: readonly RendererModule[]): void {
  registered = modules
}

export function rendererModule(id: string): RendererModule | undefined {
  return registered.find((m) => m.manifest.id === id)
}

// ——— Trạng thái bật / tắt (main là nguồn sự thật) ———

interface ModulesStore {
  states: Record<string, ModuleState>
  loaded: boolean
  reload: () => Promise<void>
  apply: (states: readonly ModuleState[]) => void
}

export const useModules = create<ModulesStore>((set) => ({
  states: {},
  loaded: false,
  reload: async () => {
    const states = await window.shellhouse.modules()
    set({ states: Object.fromEntries(states.map((s) => [s.id, s])), loaded: true })
  },
  apply: (states) => {
    set({ states: Object.fromEntries(states.map((s) => [s.id, s])), loaded: true })
  }
}))

let started = false
/** Nạp trạng thái module và theo dõi thay đổi (gọi một lần lúc khởi động). */
export function startModules(): void {
  if (started) return
  started = true
  void useModules.getState().reload()
  window.shellhouse.onModulesChanged((states) => {
    useModules.getState().apply(states)
  })
  window.shellhouse.onModuleEvent((event) => {
    for (const l of eventListeners.get(`${event.module}:${event.name}`) ?? []) l(event.data)
  })
}

/** Việc nền đang chạy theo module (id → hàm dừng). */
const backgrounds = new Map<string, () => void>()

/**
 * Chạy `background` của module đang bật (gọi trong App — chỉ khi vault đã mở); tắt module → dừng
 * việc của nó; App unmount (khoá vault) → dừng hết.
 */
export function useModuleBackgrounds(): void {
  const enabled = useModules((s) =>
    Object.values(s.states)
      .filter((m) => m.enabled)
      .map((m) => m.id)
      .sort()
      .join(',')
  )
  useEffect(() => {
    const want = new Set(enabled.split(',').filter(Boolean))
    for (const [id, stop] of backgrounds)
      if (!want.has(id)) {
        stop()
        backgrounds.delete(id)
      }
    for (const id of want) {
      if (backgrounds.has(id)) continue
      const start = rendererModule(id)?.background
      if (start) backgrounds.set(id, start())
    }
  }, [enabled])
  useEffect(
    () => () => {
      for (const stop of backgrounds.values()) stop()
      backgrounds.clear()
    },
    []
  )
}

export function isModuleEnabled(id: string): boolean {
  return useModules.getState().states[id]?.enabled === true
}

export function useModuleEnabled(id: string): boolean {
  return useModules((s) => s.states[id]?.enabled === true)
}

/** Module đang bật, theo thứ tự đăng ký. */
export function useEnabledModules(): RendererModule[] {
  const states = useModules((s) => s.states)
  return useMemo(() => registered.filter((m) => states[m.manifest.id]?.enabled === true), [states])
}

export async function setModuleEnabled(id: string, enabled: boolean): Promise<void> {
  useModules.getState().apply(await window.shellhouse.setModuleEnabled(id, enabled))
  // Tắt module → đóng tab của nó.
  if (!enabled) {
    const tabs = useTabs.getState()
    for (const t of tabs.tabs)
      if (
        (t.target.kind === 'module' || t.target.kind === 'module-terminal') &&
        t.target.module === id
      )
        tabs.close(t.id)
  }
}

// ——— Host SSH đã lưu (chỉ thông tin hiển thị — không có thông tin đăng nhập) ———

export interface SavedHostInfo {
  id: string
  label: string
  /** user@hostname */
  address: string
  protocol: string
  /** Tag của host (module ưu tiên host gắn tag liên quan, vd. "docker"). */
  tags: readonly string[]
}

/** Host đã lưu (để module chọn server chạy trên đó). */
export function useSavedHosts(): SavedHostInfo[] {
  const hosts = useHosts((s) => s.tree.hosts)
  return useMemo(
    () =>
      hosts.map((h) => ({
        id: h.id,
        label: h.label,
        address: `${h.username}@${h.hostname}`,
        protocol: h.protocol,
        tags: h.tags
      })),
    [hosts]
  )
}

export function savedHost(id: string): SavedHostInfo | undefined {
  const h = useHosts.getState().tree.hosts.find((x) => x.id === id)
  return h
    ? {
        id: h.id,
        label: h.label,
        address: `${h.username}@${h.hostname}`,
        protocol: h.protocol,
        tags: h.tags
      }
    : undefined
}

/**
 * Hộp hỏi mật khẩu / passphrase / host key cho phiên module chạy qua SSH (cùng hộp thoại của tab
 * terminal). Đặt trong khung `relative` của tab.
 */
export function ConnectionPrompt({
  prompt,
  onAnswer
}: {
  prompt: { id: number; request: PromptRequest }
  onAnswer: (ok: boolean, answers: string[]) => void
}): React.JSX.Element {
  return <PromptDialog prompt={prompt} onAnswer={onAnswer} />
}

// ——— Cài đặt riêng của module (`settings.modules.<id>`) ———

/** Đọc cài đặt của module bằng schema của nó (trường hỏng / thiếu → mặc định của schema). */
export function useModuleSettings<T>(id: string, schema: ZodType<T>): T {
  const entry = useSettings((s) => s.settings.modules[id])
  return useMemo(() => schema.parse(entry ?? {}), [entry, schema])
}

export function updateModuleSettings(id: string, patch: Record<string, unknown>): Promise<void> {
  return useSettings.getState().update({ modules: { [id]: patch } })
}

/** Mục của các module đang bật trong menu chuột phải của một host đã lưu (ADR-014 mục 3.8). */
export function moduleHostActions(host: HostContext): ModuleMenuEntry[] {
  return registered
    .filter((m) => isModuleEnabled(m.manifest.id))
    .flatMap((m) =>
      (m.hostActions?.(host) ?? []).map((a) => ({ ...a, id: `module:${m.manifest.id}:${a.id}` }))
    )
}

// ——— IPC và sự kiện của main ———

const eventListeners = new Map<string, Set<(data: unknown) => void>>()

/** Gọi handler `module:<id>:<name>` ở main. */
export function invokeModule<T = unknown>(
  module: string,
  name: string,
  ...args: unknown[]
): Promise<T> {
  return window.shellhouse.invokeModule(module, name, args) as Promise<T>
}

/** Nghe sự kiện `ctx.events.emit(name)` của module ở main. */
export function onModuleEvent(
  module: string,
  name: string,
  listener: (data: unknown) => void
): () => void {
  const key = `${module}:${name}`
  let set = eventListeners.get(key)
  if (!set) {
    set = new Set()
    eventListeners.set(key, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    // Không để lại Set rỗng cho mỗi khoá đã từng đăng ký.
    if (set.size === 0 && eventListeners.get(key) === set) eventListeners.delete(key)
  }
}

// ——— Tab ———

export function moduleTab(module: string, tab: string): ModuleTabDef | null {
  return rendererModule(module)?.tabs?.[tab] ?? null
}

/** Mở tab của module (module phải đang bật). Trả về id tab, null nếu không mở được. */
/** Tham số của tab module đang xem (null = tab đang xem không thuộc `module`). */
export function useActiveModuleParams(module: string): unknown {
  return useTabs((s) => {
    const target = s.tabs.find((x) => x.id === s.activeId)?.target
    return target?.kind === 'module' && target.module === module ? target.params : null
  })
}

export function openModuleTab(module: string, tab: string, params: unknown): string | null {
  const def = moduleTab(module, tab)
  if (!def || !isModuleEnabled(module)) return null
  const parsed = def.params.safeParse(params)
  if (!parsed.success) {
    toast.error('Could not open the tab', { details: parsed.error.message })
    return null
  }
  return useTabs
    .getState()
    .addTarget(def.title(parsed.data), { kind: 'module', module, tab, params: parsed.data })
}

/** Tab module đổi tham số (vị trí đang xem…) → cập nhật đích (nhân bản / workspace) và tiêu đề. */
/** Cài đặt "Needs attention" trên Home đang bật (module chỉ báo vấn đề khi bật). */
export function useHomeAttentionEnabled(): boolean {
  return useSettings((s) => s.settings.appearance.homeAttention)
}

// ——— Theo dõi nền (Home › Infrastructure) ———

/** Đẩy / gỡ trạng thái một nguồn đang theo dõi (ngoài React). */
export function publishFleet(item: FleetItem): void {
  useFleet.getState().put(item)
}

export function removeFleet(id: string): void {
  useFleet.getState().remove(id)
}

/**
 * Nguồn `<module>:<id>` đang được theo dõi nền VÀ đọc được (tab nhường việc báo vấn đề cho nó;
 * theo dõi nền đang lỗi / cần đăng nhập thì tab vẫn tự báo).
 */
export function useFleetMonitored(id: string): boolean {
  return useFleet((s) => {
    const state = s.items[id]?.state
    return state === 'ok' || state === 'warning'
  })
}

/** Báo vấn đề lên Home › Needs attention ngoài React; null = gỡ. */
export function publishAttention(sourceId: string, items: AttentionItem[] | null): void {
  if (items) useAttention.getState().publish(sourceId, items)
  else useAttention.getState().remove(sourceId)
}

/** Cài đặt liên quan tới theo dõi nền (đọc tại chỗ). */
export interface MonitorConfig {
  /** Đã nạp cài đặt và danh sách host (trước đó chưa biết nguồn nào thuộc Production). */
  loaded: boolean
  enabled: boolean
  attention: boolean
  overrides: Readonly<Record<string, boolean>>
  sourceEnvironments: Readonly<Record<string, string>>
}

export function monitorConfig(): MonitorConfig {
  const s = useSettings.getState()
  return {
    loaded: s.loaded && useHosts.getState().loaded,
    enabled: s.settings.appearance.homeMonitor,
    attention: s.settings.appearance.homeAttention,
    overrides: s.settings.sourceMonitor,
    sourceEnvironments: s.settings.sourceEnvironments
  }
}

/** Gọi lại khi cài đặt hoặc cây host đổi (môi trường kế thừa từ nhóm host). */
export function onMonitorConfigChange(listener: () => void): () => void {
  const a = useSettings.subscribe(listener)
  const b = useHosts.subscribe(listener)
  return () => {
    a()
    b()
  }
}

/** Bật / tắt theo dõi một nguồn; null = về mặc định (theo môi trường). */
export function setSourceMonitor(key: string, on: boolean | null): Promise<void> {
  return useSettings.getState().update({ sourceMonitor: { [key]: on } })
}

/** Lựa chọn theo dõi của người dùng (`<module>:<id>` → bật / tắt) — để vẽ menu. */
export function useSourceMonitorMap(): Readonly<Record<string, boolean>> {
  return useSettings((s) => s.settings.sourceMonitor)
}

/**
 * Mục menu "Monitor on Home" của một nguồn: đánh dấu khi đang theo dõi; bấm để đổi (trùng mặc
 * định theo môi trường thì bỏ lựa chọn riêng).
 */
export function monitorMenuItem(
  key: string,
  environment: string | null,
  overrides: Readonly<Record<string, boolean>>
): { id: string; label: string; icon: React.ReactNode; onSelect: () => void } {
  const on = isMonitoredSource(overrides, key, environment)
  return {
    id: 'monitor-home',
    label: t('Monitor on Home'),
    icon: on ? createElement(Check, { size: 14 }) : createElement(Activity, { size: 14 }),
    onSelect: () => {
      const next = !on
      void setSourceMonitor(key, next === isMonitoredSource({}, key, environment) ? null : next)
    }
  }
}

/** Chuyển tới tab (vd. từ trung tâm Transfers về đúng tab đang truyền). */
export function activateTab(tabId: string): void {
  useTabs.getState().activate(tabId)
}

export function setModuleTabParams(tabId: string, params: unknown): void {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId)
  if (tab?.target.kind !== 'module') return
  const def = moduleTab(tab.target.module, tab.target.tab)
  if (!def) return
  const parsed = def.params.safeParse(params)
  if (!parsed.success) {
    // eslint-disable-next-line no-console -- lỗi lập trình của module, không phải của người dùng
    console.error(
      `[shellhouse] invalid params for ${tab.target.module}:${tab.target.tab}`,
      parsed.error
    )
    return
  }
  useTabs.getState().setModuleParams(tabId, parsed.data, def.title(parsed.data))
}

/** Mở tab terminal của module (shell vào container…), trên máy này hoặc qua host SSH đã lưu. */
export function openModuleTerminal(
  module: string,
  title: string,
  params: unknown,
  hostId?: string
): string {
  const target: ModuleTerminalTarget = {
    kind: 'module-terminal',
    module,
    params,
    ...(hostId ? { hostId } : {})
  }
  return useTabs.getState().addTarget(title, target)
}

/**
 * Gọi `listener` một lần khi tab `tabId` bị đóng (dọn tài nguyên tạm của module — pod debug…).
 * Trả hàm huỷ theo dõi.
 */
export function onTabClosed(tabId: string, listener: () => void): () => void {
  const unsub = useTabs.subscribe((state) => {
    if (state.tabs.some((x) => x.id === tabId)) return
    unsub()
    listener()
  })
  return unsub
}

/** Chấm trạng thái trên tab (connecting / connected / disconnected). */
export function setTabState(tabId: string, state: TerminalState | null): void {
  if (state) useTabStatus.getState().set(tabId, state)
  else useTabStatus.getState().remove(tabId)
}

// ——— Phiên module tới Session Host ———

export interface ModuleSessionEvents {
  onTransfers?(list: TransferStatus[]): void
  onEvent?(event: string, data: unknown): void
  onStatus?(phase: ConnectionPhase, detail: string): void
  /** Hỏi mật khẩu / host key… khi chạy qua SSH (null = không còn gì chờ). */
  onPrompt?(prompt: { id: number; request: PromptRequest } | null): void
  onError?(message: string): void
  onExit?(reason: ExitReason): void
  /**
   * Session Host vừa khởi động lại (tiến trình cũ chết): phiên này đã mất, mọi thao tác đang chờ
   * bị huỷ — mở phiên mới để tiếp tục.
   */
  onHostRestart?(): void
}

/** Chạy module ở đâu: phiên riêng của module, hoặc gắn vào kết nối SSH tới host đã lưu. */
export type ModuleSessionTarget =
  { kind: 'module'; sessionKind: string; params: unknown } | { kind: 'ssh'; hostId: string }

/** Đầu renderer của một phiên module: gửi thao tác, nhận kết quả / sự kiện / tiến độ truyền file. */
export class ModuleSessionClient {
  private readonly prompts: { id: number; request: PromptRequest }[] = []
  private unwatchHost: (() => void) | null = null

  private constructor(
    private readonly module: string,
    private client: SessionClient | null
  ) {}

  static async open(
    module: string,
    target: ModuleSessionTarget,
    events: ModuleSessionEvents = {}
  ): Promise<ModuleSessionClient> {
    const { sessionId, port } = await openSession(
      target.kind === 'module'
        ? {
            kind: 'module',
            module,
            sessionKind: target.sessionKind,
            cols: 80,
            rows: 24,
            params: target.params
          }
        : { kind: 'host', hostId: target.hostId, cols: 80, rows: 24, noShell: true }
    )
    const self = new ModuleSessionClient(module, null)
    const emitPrompt = (): void => {
      events.onPrompt?.(self.prompts[0] ?? null)
    }
    self.client = new SessionClient(sessionId, port, {
      write: (_data, done) => {
        done()
      },
      exit: (_code, reason) => {
        self.prompts.length = 0
        emitPrompt()
        events.onExit?.(reason)
      },
      error: (message) => events.onError?.(message),
      status: (phase, detail) => events.onStatus?.(phase, detail),
      prompt: (id, request) => {
        self.prompts.push({ id, request })
        emitPrompt()
      },
      promptCancelled: (id) => {
        const i = self.prompts.findIndex((p) => p.id === id)
        if (i >= 0) self.prompts.splice(i, 1)
        emitPrompt()
      },
      forwards: () => undefined,
      transfers: (list) => events.onTransfers?.(list),
      stats: () => undefined,
      moduleEvent: (m, event, data) => {
        if (m === module) events.onEvent?.(event, data)
      }
    })
    if (target.kind === 'ssh') self.client.attachModule(module)
    // Session Host chết / khởi động lại → port của phiên chết theo, thao tác đang chờ sẽ không bao
    // giờ có kết quả: huỷ chúng ngay và báo để mở phiên mới (như terminal).
    const epoch = useHostStatus.getState().status?.restarts ?? null
    self.unwatchHost = useHostStatus.subscribe(({ status }) => {
      if (!status) return
      const lost = status.state !== 'running' || (epoch !== null && status.restarts !== epoch)
      if (!lost || !self.client) return
      self.close()
      events.onHostRestart?.()
    })
    return self
  }

  request<T = unknown>(op: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.client) return Promise.reject(new Error('The tab is closed'))
    return this.client.module(this.module, op, signal) as Promise<T>
  }

  /** Trả lời prompt (mật khẩu, host key…). */
  answer(id: number, ok: boolean, answers: string[]): void {
    const i = this.prompts.findIndex((p) => p.id === id)
    if (i >= 0) this.prompts.splice(i, 1)
    this.client?.reply(id, ok, answers)
  }

  close(): void {
    this.unwatchHost?.()
    this.unwatchHost = null
    this.client?.close()
    this.client = null
  }
}

// ——— Phiên chạy nền ———

export {
  BACKGROUND_RETRY_MS,
  friendlyError,
  isSignInError,
  type BackgroundSession,
  type BackgroundSessionHandlers
} from './renderer-background'

/** Phiên module chạy nền (theo dõi cho Home) — xem BackgroundSession. */
export function backgroundSession(
  module: string,
  target: () => ModuleSessionTarget,
  handlers: BackgroundSessionHandlers
): BackgroundSession {
  return new BackgroundSession(module, target, handlers, {
    open: (m, t, e) => ModuleSessionClient.open(m, t, e),
    whenHostRunning
  })
}

// ——— Component lazy ———

/**
 * Component nạp khi cần (chunk riêng) — module tắt không tốn gì. Có Suspense riêng: khung tab /
 * thanh bên không bị ẩn trong lúc nạp. Có ErrorBoundary riêng: module lỗi (hoặc chunk không nạp
 * được) chỉ hỏng phần của nó, không gỡ cả app.
 */
export function lazyModuleComponent<P extends object>(
  load: () => Promise<ComponentType<P>>
): ComponentType<P> {
  // React.lazy nhớ cả lần nạp hỏng → tạo lazy mới để nút "Reload" thử nạp lại chunk.
  const make = (): ComponentType<P> =>
    lazy(async () => {
      try {
        return { default: await load() }
      } catch (error) {
        Lazy = make()
        throw error
      }
    })
  let Lazy = make()
  function ModuleComponent(props: P): React.JSX.Element {
    return (
      <ErrorBoundary label="module" compact>
        <Suspense fallback={null}>
          <Lazy {...props} />
        </Suspense>
      </ErrorBoundary>
    )
  }
  return ModuleComponent
}

// ——— Icon theo tên trong manifest ———

import { KubernetesIcon } from './renderer-icons'

const ICONS: Record<string, LucideIcon> = {
  cloud: Cloud,
  container: Container,
  ship: Ship,
  kubernetes: KubernetesIcon,
  boxes: Boxes,
  database: Database,
  network: Network,
  server: Server
}

export function moduleIcon(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || Puzzle
}

/** Icon của module theo tên trong manifest. */
export function ModuleIcon({
  name,
  size,
  className
}: {
  name: string | undefined
  size?: number
  className?: string
}): React.JSX.Element {
  return createElement(moduleIcon(name), { size, className })
}
