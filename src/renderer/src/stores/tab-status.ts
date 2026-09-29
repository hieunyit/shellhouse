import { create } from 'zustand'
import type { ActivePrompt, TerminalState } from '../terminal/controller'

/**
 * Trạng thái của từng tab do TerminalController báo:
 * - kết nối (chấm trạng thái trên tab / sidebar / MultiExec)
 * - prompt đang chờ (host key, mật khẩu…) — để MultiExec hiện prompt ngay trong ô lưới.
 */
interface TabStatusState {
  byTab: Record<string, TerminalState>
  prompts: Record<string, ActivePrompt>
  set: (tabId: string, state: TerminalState) => void
  setPrompt: (tabId: string, prompt: ActivePrompt | null) => void
  remove: (tabId: string) => void
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- khoá là id tab động
  delete next[key]
  return next
}

export const useTabStatus = create<TabStatusState>((set) => ({
  byTab: {},
  prompts: {},
  set: (tabId, state) => {
    set((s) => (s.byTab[tabId] === state ? s : { byTab: { ...s.byTab, [tabId]: state } }))
  },
  setPrompt: (tabId, prompt) => {
    set((s) => {
      if (prompt) return { prompts: { ...s.prompts, [tabId]: prompt } }
      return tabId in s.prompts ? { prompts: without(s.prompts, tabId) } : s
    })
  },
  remove: (tabId) => {
    set((s) =>
      tabId in s.byTab || tabId in s.prompts
        ? { byTab: without(s.byTab, tabId), prompts: without(s.prompts, tabId) }
        : s
    )
  }
}))
