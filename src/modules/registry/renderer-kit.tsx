import { createElement, lazy, Suspense, useMemo, type ComponentType } from 'react'
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
import { SessionClient } from '../../renderer/src/terminal/session-client'
import type { TerminalState } from '../../renderer/src/terminal/controller'
import type { ModuleTabDef, RendererModule } from './renderer-types'
import type { ModuleState } from './types'

/**
 * Bộ công cụ renderer cho module (ADR-014 mục 3.8): trạng thái bật / tắt, mở tab, gọi IPC, phiên
 * tới Session Host. Module chỉ dùng những hàm ở đây (và thành phần UI dùng chung), không đụng thẳng
 * store của lõi.
 *
 * File này KHÔNG import module nào (tránh vòng import): danh sách module được đăng ký lúc khởi
 * động bằng `registerRendererModules` (xem all-renderer.ts).
 */

let registered: readonly RendererModule[] = []

export function registerRendererModules(modules: readonly RendererModule[]): void {
  registered = modules
}

export function rendererModules(): readonly RendererModule[] {
  return registered
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

// ——— Cài đặt riêng của module (`settings.modules.<id>`) ———

/** Đọc cài đặt của module bằng schema của nó (trường hỏng / thiếu → mặc định của schema). */
export function useModuleSettings<T>(id: string, schema: ZodType<T>): T {
  const entry = useSettings((s) => s.settings.modules[id])
  return useMemo(() => schema.parse(entry ?? {}), [entry, schema])
}

export function updateModuleSettings(id: string, patch: Record<string, unknown>): Promise<void> {
  return useSettings.getState().update({ modules: { [id]: patch } })
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
  return () => set.delete(listener)
}

// ——— Tab ———

export function moduleTab(module: string, tab: string): ModuleTabDef | null {
  return rendererModule(module)?.tabs?.[tab] ?? null
}

/** Tiêu đề cho tab module; tham số hỏng → tên module. */
export function moduleTabTitle(module: string, tab: string, params: unknown): string {
  const def = moduleTab(module, tab)
  const parsed = def?.params.safeParse(params)
  return def && parsed?.success
    ? def.title(parsed.data)
    : (rendererModule(module)?.manifest.name ?? module)
}

/** Mở tab của module (module phải đang bật). Trả về id tab, null nếu không mở được. */
export function openModuleTab(module: string, tab: string, params: unknown): string | null {
  const def = moduleTab(module, tab)
  if (!def || !isModuleEnabled(module)) return null
  const parsed = def.params.parse(params)
  return useTabs
    .getState()
    .addTarget(def.title(parsed), { kind: 'module', module, tab, params: parsed })
}

/** Tab module đổi tham số (vị trí đang xem…) → cập nhật đích (nhân bản / workspace) và tiêu đề. */
export function setModuleTabParams(tabId: string, params: unknown): void {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId)
  if (tab?.target.kind !== 'module') return
  const def = moduleTab(tab.target.module, tab.target.tab)
  if (!def) return
  const parsed = def.params.parse(params)
  useTabs.getState().setModuleParams(tabId, parsed, def.title(parsed))
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
}

/** Chạy module ở đâu: phiên riêng của module, hoặc gắn vào kết nối SSH tới host đã lưu. */
export type ModuleSessionTarget =
  { kind: 'module'; sessionKind: string; params: unknown } | { kind: 'ssh'; hostId: string }

/** Đầu renderer của một phiên module: gửi thao tác, nhận kết quả / sự kiện / tiến độ truyền file. */
export class ModuleSessionClient {
  private readonly prompts: { id: number; request: PromptRequest }[] = []

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
    this.client?.close()
    this.client = null
  }
}

// ——— Component lazy ———

/**
 * Component nạp khi cần (chunk riêng) — module tắt không tốn gì. Có Suspense riêng: khung tab /
 * thanh bên không bị ẩn trong lúc nạp.
 */
export function lazyModuleComponent<P extends object>(
  load: () => Promise<ComponentType<P>>
): ComponentType<P> {
  const Lazy = lazy(async () => ({ default: await load() }))
  function ModuleComponent(props: P): React.JSX.Element {
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    )
  }
  return ModuleComponent
}

// ——— Icon theo tên trong manifest ———

const ICONS: Record<string, LucideIcon> = {
  cloud: Cloud,
  container: Container,
  ship: Ship,
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
