import { create } from 'zustand'
import { useTabs } from '../stores/tabs'
import { controllers } from './registry'

/**
 * MultiExec (như MobaXterm): mọi terminal đang mở được xếp đều thành lưới trên một màn hình; phím
 * gõ (và dán) ở một terminal có bật "Send input" được gửi tới MỌI terminal đang bật. Terminal tắt
 * "Send input" vẫn gõ được riêng.
 */
interface BroadcastState {
  /** Đang ở chế độ MultiExec (lớp lưới đang hiện). */
  enabled: boolean
  /** Các tab nhận lệnh. */
  tabIds: readonly string[]
  /** Bật MultiExec; `tabIds` = các tab được chọn gửi lệnh. */
  start: (tabIds: readonly string[]) => void
  stop: () => void
  setTabs: (tabIds: readonly string[]) => void
  toggleTab: (tabId: string) => void
  /** Tab đóng → bỏ khỏi danh sách. */
  forget: (tabId: string) => void
}

export const useBroadcast = create<BroadcastState>((set) => ({
  enabled: false,
  tabIds: [],
  start: (tabIds) => {
    set({ enabled: true, tabIds: [...new Set(tabIds)] })
  },
  stop: () => {
    set({ enabled: false, tabIds: [] })
  },
  setTabs: (tabIds) => {
    set({ tabIds: [...new Set(tabIds)] })
  },
  toggleTab: (tabId) => {
    set((s) => ({
      tabIds: s.tabIds.includes(tabId)
        ? s.tabIds.filter((id) => id !== tabId)
        : [...s.tabIds, tabId]
    }))
  },
  forget: (tabId) => {
    set((s) => (s.tabIds.includes(tabId) ? { tabIds: s.tabIds.filter((id) => id !== tabId) } : s))
  }
}))

/** Bật / tắt MultiExec; khi bật, mọi terminal đang mở đều được chọn gửi lệnh. */
export function toggleMultiExec(): void {
  const b = useBroadcast.getState()
  if (b.enabled) {
    b.stop()
    return
  }
  const ids = useTabs.getState().tabs.map((t) => t.id)
  if (ids.length > 0) b.start(ids)
}

/** Gửi dữ liệu gõ từ `sourceTabId`. Trả về true nếu đã phát cho cả nhóm (người gọi không gửi lại). */
export function broadcastInput(sourceTabId: string, data: string): boolean {
  const { enabled, tabIds } = useBroadcast.getState()
  if (!enabled || !tabIds.includes(sourceTabId)) return false
  for (const id of tabIds) controllers.get(id)?.sendInput(data)
  return true
}
