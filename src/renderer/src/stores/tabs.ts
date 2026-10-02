import { create } from 'zustand'
import type { WorkspaceItem } from '@shared/workspaces'
import { shellName } from './shells'

/**
 * Terminal của module (shell vào container / pod — ADR-014 mục 3.7). `hostId` = chạy trên kết nối
 * SSH tới host đã lưu; không có = trên máy này.
 */
export interface ModuleTerminalTarget {
  kind: 'module-terminal'
  module: string
  params: unknown
  hostId?: string | undefined
}

/** Tab có terminal (local / SSH / host đã lưu / terminal của module). */
export type TerminalTarget =
  | { kind: 'local'; shellId?: string }
  | { kind: 'ssh'; host: string; port: number; username: string }
  | { kind: 'host'; hostId: string }
  | ModuleTerminalTarget

/**
 * Tab của module (trình quản lý S3, Docker…). `params` do module định nghĩa (vị trí đang xem…) —
 * nhân bản tab / workspace mở lại đúng chỗ này.
 */
export interface ModuleTabTarget {
  kind: 'module'
  module: string
  tab: string
  params: unknown
}

/** Trang chủ: kết nối gần đây, yêu thích, thao tác nhanh (một tab duy nhất). */
export interface HomeTarget {
  kind: 'home'
}

export type TabTarget = TerminalTarget | ModuleTabTarget | HomeTarget

export interface Tab {
  id: string
  title: string
  target: TabTarget
  /** Tab sinh ra từ lệnh chia màn hình: đặt cạnh tab nguồn theo hướng này ('within' = cùng nhóm). */
  splitFrom?: { tabId: string; direction: 'right' | 'below' | 'within' }
  /** Panel mở sẵn khi tab vừa tạo. */
  initialPanel?: 'sftp'
  /** 'files' = trình quản lý file hai cột (Local | Remote) thay cho terminal ("Open SFTP"). */
  view?: 'files'
}

export interface OpenHostOptions {
  /** Mở cạnh tab đang active thay vì thành tab mới. */
  split?: 'right' | 'below'
  panel?: 'sftp'
  /** Mở thành trình quản lý file hai cột. */
  view?: 'files'
}

/** Tab đã đóng (mở lại được, như trình duyệt) — mới nhất ở cuối. */
export interface ClosedTab {
  title: string
  target: TabTarget
  view?: 'files'
}

const MAX_CLOSED = 10

interface TabsState {
  tabs: Tab[]
  activeId: string | null
  closed: ClosedTab[]
  /** Mở lại tab đã đóng (mặc định: gần nhất; `index` trong `closed`) — null = không còn. */
  reopenClosed: (index?: number) => string | null
  /** Tab terminal local; `shellId` = shell cụ thể (không có = shell mặc định). */
  addLocal: (shellId?: string) => string
  /** Mở (hoặc chuyển tới) tab Home. */
  openHome: () => string
  addSsh: (target: { host: string; port: number; username: string }) => string
  addHost: (host: { id: string; label: string }, options?: OpenHostOptions) => string
  /** Mở tab của module (dùng `openModuleTab` của registry — nó kiểm tham số, đặt tiêu đề). */
  addTarget: (title: string, target: TabTarget) => string
  /** Tab module đổi tham số (vị trí đang xem…): cập nhật đích và tiêu đề. */
  setModuleParams: (id: string, params: unknown, title: string) => void
  /** Mở nhiều host: thành các tab, hoặc xếp lưới (chia màn hình) trong một khung. */
  openHosts: (hosts: readonly { id: string; label: string }[], layout: 'tabs' | 'grid') => string[]
  /** Mở lại một workspace đã lưu (thêm vào các tab đang mở). */
  openWorkspace: (items: readonly WorkspaceItem[]) => string[]
  /** Mở một phiên mới cùng đích với tab hiện tại, đặt cạnh nó. */
  split: (direction: 'right' | 'below') => string | null
  /** Mở thêm một phiên cùng đích, thành tab cạnh tab này. */
  duplicate: (id: string) => string | null
  /** Đóng mọi tab trừ tab này. */
  closeOthers: (id: string) => void
  close: (id: string) => void
  activate: (id: string) => void
  cycle: (delta: 1 | -1) => void
  setTitle: (id: string, title: string) => void
  /** Tab chuyển giữa terminal và trình quản lý file hai cột. */
  setView: (id: string, view: 'files' | undefined) => void
}

let localCounter = 0

/** Nhớ tab vừa đóng (bỏ Home và terminal của module — mở lại không có nghĩa). */
function remember(closed: ClosedTab[], tabs: Tab[]): ClosedTab[] {
  const add = tabs
    .filter((t) => t.target.kind !== 'home' && t.target.kind !== 'module-terminal')
    .map((t) => ({ title: t.title, target: t.target, ...(t.view ? { view: t.view } : {}) }))
  return [...closed, ...add].slice(-MAX_CLOSED)
}

export const useTabs = create<TabsState>((set, get) => {
  const add = (
    title: string,
    target: TabTarget,
    splitFrom?: Tab['splitFrom'],
    initialPanel?: Tab['initialPanel'],
    view?: Tab['view']
  ): string => {
    const id = crypto.randomUUID()
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          title,
          target,
          ...(splitFrom ? { splitFrom } : {}),
          ...(initialPanel ? { initialPanel } : {}),
          ...(view ? { view } : {})
        }
      ],
      activeId: id
    }))
    return id
  }
  return {
    tabs: [],
    activeId: null,
    closed: [],
    reopenClosed: (index) => {
      const closed = get().closed
      const at = index ?? closed.length - 1
      const last = closed[at]
      if (!last) return null
      set((s) => ({ closed: s.closed.filter((_, i) => i !== at) }))
      const title =
        last.target.kind === 'local'
          ? (shellName(last.target.shellId) ?? `Local ${++localCounter}`)
          : last.title
      return add(title, last.target, undefined, undefined, last.view)
    },
    addLocal: (shellId) => {
      const title = shellName(shellId) ?? `Local ${++localCounter}`
      return add(title, shellId ? { kind: 'local', shellId } : { kind: 'local' })
    },
    openHome: () => {
      const existing = get().tabs.find((t) => t.target.kind === 'home')
      if (existing) {
        set({ activeId: existing.id })
        return existing.id
      }
      return add('Home', { kind: 'home' })
    },
    addSsh: (t) =>
      add(`${t.username}@${t.host}${t.port === 22 ? '' : `:${t.port}`}`, { kind: 'ssh', ...t }),
    addHost: (host, options) => {
      const active = get().activeId
      const splitFrom =
        options?.split && active ? { tabId: active, direction: options.split } : undefined
      return add(
        options?.view === 'files' ? `${host.label} (SFTP)` : host.label,
        { kind: 'host', hostId: host.id },
        splitFrom,
        options?.panel,
        options?.view
      )
    },
    addTarget: (title, target) => add(title, target),
    openHosts: (hosts, layout) => {
      const ids: string[] = []
      // Lưới gần vuông: 4 host → 2×2, 6 → 3×2. Hàng đầu chia phải, các hàng sau chia xuống từ ô phía trên.
      const cols = Math.ceil(Math.sqrt(hosts.length))
      const active = get().activeId
      hosts.forEach((host, i) => {
        let splitFrom: Tab['splitFrom']
        // Ô đầu tiên của lưới mở trong khung mới bên phải (không lẫn vào các tab đang mở).
        if (layout === 'grid' && i === 0 && active)
          splitFrom = { tabId: active, direction: 'right' }
        if (layout === 'grid' && i > 0) {
          splitFrom =
            i < cols
              ? { tabId: ids[i - 1] ?? '', direction: 'right' }
              : { tabId: ids[i - cols] ?? '', direction: 'below' }
        }
        ids.push(add(host.label, { kind: 'host', hostId: host.id }, splitFrom))
      })
      return ids
    },
    openWorkspace: (items) => {
      const ids: string[] = []
      for (const item of items) {
        const anchor = item.after === null ? undefined : ids[item.after]
        const splitFrom = anchor ? { tabId: anchor, direction: item.direction } : undefined
        const title =
          item.target.kind === 'local'
            ? (shellName(item.target.shellId) ?? `Local ${++localCounter}`)
            : item.title
        ids.push(add(title, item.target, splitFrom, undefined, item.view))
      }
      return ids
    },
    split: (direction) => {
      const { tabs, activeId } = get()
      const source = tabs.find((t) => t.id === activeId)
      if (!source || source.target.kind === 'home') return null
      const title =
        source.target.kind === 'local'
          ? (shellName(source.target.shellId) ?? `Local ${++localCounter}`)
          : source.title
      return add(title, source.target, { tabId: source.id, direction })
    },
    duplicate: (id) => {
      const source = get().tabs.find((t) => t.id === id)
      if (!source || source.target.kind === 'home') return null
      const title =
        source.target.kind === 'local'
          ? (shellName(source.target.shellId) ?? `Local ${++localCounter}`)
          : source.title
      return add(
        title,
        source.target,
        { tabId: source.id, direction: 'within' },
        undefined,
        source.view
      )
    },
    closeOthers: (id) => {
      set((s) => ({
        tabs: s.tabs.filter((t) => t.id === id),
        activeId: id,
        closed: remember(
          s.closed,
          s.tabs.filter((t) => t.id !== id)
        )
      }))
    },
    close: (id) => {
      set((s) => {
        const index = s.tabs.findIndex((t) => t.id === id)
        if (index === -1) return s
        const tabs = s.tabs.filter((t) => t.id !== id)
        let activeId = s.activeId
        if (activeId === id) activeId = (tabs[index] ?? tabs[index - 1] ?? null)?.id ?? null
        const gone = s.tabs[index]
        return { tabs, activeId, closed: gone ? remember(s.closed, [gone]) : s.closed }
      })
    },
    activate: (id) => {
      set({ activeId: id })
    },
    cycle: (delta) => {
      const { tabs, activeId } = get()
      if (tabs.length === 0) return
      const index = tabs.findIndex((t) => t.id === activeId)
      const next = tabs[(index + delta + tabs.length) % tabs.length]
      if (next) set({ activeId: next.id })
    },
    setView: (id, view) => {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id) return t
          const next = { ...t }
          if (view) next.view = view
          else delete next.view
          return next
        })
      }))
    },
    setTitle: (id, title) => {
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }))
    },
    setModuleParams: (id, params, title) => {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id && t.target.kind === 'module'
            ? { ...t, target: { ...t.target, params }, title }
            : t
        )
      }))
    }
  }
})
