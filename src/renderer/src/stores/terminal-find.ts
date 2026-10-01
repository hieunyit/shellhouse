import { create } from 'zustand'

/** Tab đang mở thanh tìm kiếm trong terminal (một lúc chỉ một). */
interface TerminalFind {
  tabId: string | null
  /** Tăng mỗi lần mở lại — thanh đang mở thì chọn lại chữ trong ô tìm. */
  seq: number
  open: (tabId: string) => void
  close: () => void
}

export const useTerminalFind = create<TerminalFind>((set, get) => ({
  tabId: null,
  seq: 0,
  open: (tabId) => {
    set({ tabId, seq: get().seq + 1 })
  },
  close: () => {
    set({ tabId: null })
  }
}))
