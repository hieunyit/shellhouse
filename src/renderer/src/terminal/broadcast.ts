import { create } from 'zustand'
import { controllers } from './registry'

/**
 * Gõ đồng loạt (như MultiExec của MobaXterm): khi bật, phím gõ (và dán) ở một terminal thuộc nhóm
 * được gửi tới MỌI terminal trong nhóm. Tắt mặc định; luôn hiển thị rõ khi đang bật.
 */
interface BroadcastState {
  enabled: boolean
  tabIds: readonly string[]
  /** Bật cho đúng các tab này (ví dụ các host vừa mở dạng lưới). */
  start: (tabIds: readonly string[]) => void
  stop: () => void
  toggleTab: (tabId: string) => void
  /** Tab đóng → bỏ khỏi nhóm; còn dưới 2 tab thì tự tắt. */
  forget: (tabId: string) => void
}

export const useBroadcast = create<BroadcastState>((set) => ({
  enabled: false,
  tabIds: [],
  start: (tabIds) => {
    set({ enabled: tabIds.length > 0, tabIds: [...new Set(tabIds)] })
  },
  stop: () => {
    set({ enabled: false, tabIds: [] })
  },
  toggleTab: (tabId) => {
    set((s) => {
      const tabIds = s.tabIds.includes(tabId)
        ? s.tabIds.filter((id) => id !== tabId)
        : [...s.tabIds, tabId]
      return { tabIds, enabled: s.enabled && tabIds.length > 0 }
    })
  },
  forget: (tabId) => {
    set((s) => {
      if (!s.tabIds.includes(tabId)) return s
      const tabIds = s.tabIds.filter((id) => id !== tabId)
      return { tabIds, enabled: s.enabled && tabIds.length > 1 }
    })
  }
}))

/** Gửi dữ liệu gõ từ `sourceTabId`. Trả về true nếu đã phát cho cả nhóm (người gọi không gửi lại). */
export function broadcastInput(sourceTabId: string, data: string): boolean {
  const { enabled, tabIds } = useBroadcast.getState()
  if (!enabled || !tabIds.includes(sourceTabId)) return false
  for (const id of tabIds) controllers.get(id)?.sendInput(data)
  return true
}
