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
}

interface TabsState {
  tabs: Tab[]
  activeId: string | null
  addLocal: () => string
  addSsh: (target: { host: string; port: number; username: string }) => string
  addHost: (host: { id: string; label: string }) => string
  /** Mở một phiên mới cùng đích với tab hiện tại, đặt cạnh nó. */
  split: (direction: 'right' | 'below') => string | null
  close: (id: string) => void
  activate: (id: string) => void
  cycle: (delta: 1 | -1) => void
  setTitle: (id: string, title: string) => void
}

let localCounter = 0

export const useTabs = create<TabsState>((set, get) => {
  const add = (title: string, target: TabTarget, splitFrom?: Tab['splitFrom']): string => {
    const id = crypto.randomUUID()
    set((s) => ({
      tabs: [...s.tabs, { id, title, target, ...(splitFrom ? { splitFrom } : {}) }],
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
    addHost: (host) => add(host.label, { kind: 'host', hostId: host.id }),
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
