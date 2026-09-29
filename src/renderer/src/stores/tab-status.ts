import { create } from 'zustand'
import type { TerminalState } from '../terminal/controller'

/** Trạng thái kết nối của từng tab (do TerminalController báo) — cho chấm trạng thái trên tab / sidebar. */
interface TabStatusState {
  byTab: Record<string, TerminalState>
  set: (tabId: string, state: TerminalState) => void
  remove: (tabId: string) => void
}

export const useTabStatus = create<TabStatusState>((set) => ({
  byTab: {},
  set: (tabId, state) => {
    set((s) => (s.byTab[tabId] === state ? s : { byTab: { ...s.byTab, [tabId]: state } }))
  },
  remove: (tabId) => {
    set((s) => {
      if (!(tabId in s.byTab)) return s
      const byTab = { ...s.byTab }
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- khoá là id tab động
      delete byTab[tabId]
      return { byTab }
    })
  }
}))
