import { create } from 'zustand'

export type TabTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; host: string; port: number; username: string }
  | { kind: 'host'; hostId: string }

export interface Tab {
  id: string
  title: string
  target: TabTarget
  /** Tab sinh ra từ lệnh chia màn hình: đặt cạnh tab nguồn theo hướng này. */
  splitFrom?: { tabId: string; direction: 'right' | 'below' }
  /** Panel mở sẵn khi tab vừa tạo (ví dụ "Open SFTP" từ menu chuột phải). */
  initialPanel?: 'sftp'
}

export interface OpenHostOptions {
  /** Mở cạnh tab đang active thay vì thành tab mới. */
  split?: 'right' | 'below'
  panel?: 'sftp'
}

interface TabsState {
  tabs: Tab[]
  activeId: string | null
  addLocal: () => string
  addSsh: (target: { host: string; port: number; username: string }) => string
  addHost: (host: { id: string; label: string }, options?: OpenHostOptions) => string
  /** Mở nhiều host: thành các tab, hoặc xếp lưới (chia màn hình) trong một khung. */
  openHosts: (hosts: readonly { id: string; label: string }[], layout: 'tabs' | 'grid') => string[]
  /** Mở một phiên mới cùng đích với tab hiện tại, đặt cạnh nó. */
  split: (direction: 'right' | 'below') => string | null
  close: (id: string) => void
  activate: (id: string) => void
  cycle: (delta: 1 | -1) => void
  setTitle: (id: string, title: string) => void
}

let localCounter = 0

export const useTabs = create<TabsState>((set, get) => {
  const add = (
    title: string,
    target: TabTarget,
    splitFrom?: Tab['splitFrom'],
    initialPanel?: Tab['initialPanel']
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
          ...(initialPanel ? { initialPanel } : {})
        }
      ],
      activeId: id
    }))
    return id
  }
  return {
    tabs: [],
    activeId: null,
    addLocal: () => add(`Local ${++localCounter}`, { kind: 'local' }),
    addSsh: (t) =>
      add(`${t.username}@${t.host}${t.port === 22 ? '' : `:${t.port}`}`, { kind: 'ssh', ...t }),
    addHost: (host, options) => {
      const active = get().activeId
      const splitFrom =
        options?.split && active ? { tabId: active, direction: options.split } : undefined
      return add(host.label, { kind: 'host', hostId: host.id }, splitFrom, options?.panel)
    },
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
    split: (direction) => {
      const { tabs, activeId } = get()
      const source = tabs.find((t) => t.id === activeId)
      if (!source) return null
      const title = source.target.kind === 'local' ? `Local ${++localCounter}` : source.title
      return add(title, source.target, { tabId: source.id, direction })
    },
    close: (id) => {
      set((s) => {
        const index = s.tabs.findIndex((t) => t.id === id)
        if (index === -1) return s
        const tabs = s.tabs.filter((t) => t.id !== id)
        let activeId = s.activeId
        if (activeId === id) activeId = (tabs[index] ?? tabs[index - 1] ?? null)?.id ?? null
        return { tabs, activeId }
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
    setTitle: (id, title) => {
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }))
    }
  }
})
