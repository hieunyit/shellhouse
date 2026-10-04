import { create } from 'zustand'
import type { SettingsSectionId } from '../components/settings/settings-sections'
import { useSettings } from '../stores/settings'
import { useTabs, type Tab } from '../stores/tabs'
import { controllers } from '../terminal/registry'
import { sharesDockview, tabArea, type Area } from './areas'

export { inDockview, sharesDockview, tabArea, type Area } from './areas'

/**
 * Khung app mới (thiết kế v0.5): activity bar chọn "khu vực" — Home, Hosts, Files, từng module
 * (Kubernetes, Docker, S3…), Transfers, Settings. Explorer và vùng chính đổi theo khu vực.
 *
 * - Tab vẫn do `useTabs` quản lý (một danh sách chung). Mỗi tab thuộc một khu vực (`tabArea`):
 *   terminal / RDP / editor → Hosts (Files khi đang ở trình quản lý file hai cột), tab module →
 *   khu vực của module, Home → Home.
 * - Chọn tab → khu vực đi theo tab. Đóng tab cuối của một khu vực → vẫn ở lại khu vực đó (trạng
 *   thái rỗng), không nhảy sang tab của khu vực khác.
 * - Chọn khu vực trên activity bar → mở lại tab dùng gần nhất của khu vực đó (nếu có).
 */
const EXPLORER_KEY = 'shellhouse.explorer'
export const EXPLORER_WIDTH = { min: 200, default: 260, max: 420 }

function loadExplorerWidth(): number {
  try {
    const v = Number(localStorage.getItem(EXPLORER_KEY))
    if (v >= EXPLORER_WIDTH.min && v <= EXPLORER_WIDTH.max) return v
  } catch {
    // Hỏng → mặc định.
  }
  return EXPLORER_WIDTH.default
}

interface ShellState {
  area: Area
  /** Tab dùng gần nhất của từng khu vực. */
  lastTab: Partial<Record<Area, string>>
  settingsSection: SettingsSectionId
  explorerWidth: number
  /** Lịch sử khu vực cho nút ← / → trên title bar. */
  history: Area[]
  historyAt: number
  /** Chuyển khu vực (mở lại tab gần nhất của khu vực nếu có). */
  go: (area: Area) => void
  openSettings: (section?: SettingsSectionId) => void
  back: () => void
  forward: () => void
  /** Môi trường mà tab module báo (cluster / endpoint / tài khoản đang xem) — nhãn + vạch trên cùng. */
  envByTab: Readonly<Record<string, string | null>>
  reportEnvironment: (tabId: string, env: string | null) => void
  setExplorerWidth: (width: number) => void
  /** Ẩn / hiện Explorer (cài đặt appearance.sidebarHidden — nhớ qua lần mở app sau). */
  toggleExplorer: (hidden?: boolean) => void
}

const MAX_HISTORY = 50

function persistExplorerWidth(width: number): void {
  try {
    localStorage.setItem(EXPLORER_KEY, String(width))
  } catch {
    // Chỉ mất lựa chọn giao diện.
  }
}

/** Ghi khu vực mới vào lịch sử (cắt phần "forward" như trình duyệt). */
function pushHistory(
  s: Pick<ShellState, 'history' | 'historyAt'>,
  area: Area
): Partial<ShellState> {
  if (s.history[s.historyAt] === area) return {}
  const history = [...s.history.slice(0, s.historyAt + 1), area].slice(-MAX_HISTORY)
  return { history, historyAt: history.length - 1 }
}

/** Tab nên mở khi vào khu vực: tab gần nhất còn sống, không thì tab đầu tiên của khu vực. */
function tabFor(area: Area, lastTab: ShellState['lastTab']): Tab | undefined {
  const { tabs } = useTabs.getState()
  const remembered = lastTab[area]
  const match = (t: Tab): boolean =>
    tabArea(t) === area || (sharesDockview(area) && sharesDockview(tabArea(t)))
  return (
    tabs.find((t) => t.id === remembered && match(t)) ??
    tabs.find((t) => tabArea(t) === area) ??
    (sharesDockview(area) ? tabs.find(match) : undefined)
  )
}

export const useShell = create<ShellState>((set, get) => {
  /** Đổi khu vực, không động tới tab. */
  const enter = (area: Area): void => {
    set((s) => ({ area, ...pushHistory(s, area) }))
  }
  /** Đi tới mục `at` của lịch sử (← / →, Esc trên Settings). */
  const travel = (at: number): void => {
    const s = get()
    const area = s.history[at]
    if (!area) return
    set({ historyAt: at, area })
    const tab = tabFor(area, s.lastTab)
    if (!tab) return
    const tabs = useTabs.getState()
    if (tabs.activeId !== tab.id) tabs.activate(tab.id)
    if (sharesDockview(area))
      requestAnimationFrame(() => {
        controllers.get(tab.id)?.activate()
      })
  }
  const go = (area: Area): void => {
    const s = get()
    const tab = tabFor(area, s.lastTab)
    if (area === 'home' && !tab) {
      enter('home')
      useTabs.getState().openHome()
      return
    }
    enter(area)
    if (!tab) return
    const tabs = useTabs.getState()
    if (tabs.activeId !== tab.id) tabs.activate(tab.id)
    // Quay lại khu vực phiên: đưa focus về terminal đang chọn.
    else if (sharesDockview(area))
      requestAnimationFrame(() => {
        controllers.get(tab.id)?.activate()
      })
  }
  return {
    area: 'home',
    lastTab: {},
    settingsSection: 'appearance',
    explorerWidth: loadExplorerWidth(),
    envByTab: {},
    reportEnvironment: (tabId, env) => {
      if (get().envByTab[tabId] === env) return
      set((s) => ({ envByTab: { ...s.envByTab, [tabId]: env } }))
    },
    history: ['home'],
    historyAt: 0,
    go,
    openSettings: (section) => {
      set((s) => ({
        area: 'settings',
        ...pushHistory(s, 'settings'),
        ...(section ? { settingsSection: section } : {})
      }))
    },
    back: () => {
      const s = get()
      if (s.historyAt === 0) return
      travel(s.historyAt - 1)
    },
    forward: () => {
      const s = get()
      if (s.historyAt >= s.history.length - 1) return
      travel(s.historyAt + 1)
    },
    setExplorerWidth: (width) => {
      const w = Math.round(Math.min(EXPLORER_WIDTH.max, Math.max(EXPLORER_WIDTH.min, width)))
      set({ explorerWidth: w })
      persistExplorerWidth(w)
    },
    toggleExplorer: (hidden) => {
      const { settings, update } = useSettings.getState()
      const next = hidden ?? !settings.appearance.sidebarHidden
      if (next !== settings.appearance.sidebarHidden)
        void update({ appearance: { sidebarHidden: next } })
    }
  }
})

// Tab → khu vực. Chọn / mở tab nào thì khu vực đi theo tab đó; tab đang chọn bị đóng thì giữ khu vực.
/**
 * Tab mở ra từ khu vực khác (editor mở từ S3 / SFTP, shell vào pod…) → nhớ khu vực gốc: đóng tab đó
 * ngay (chưa chuyển sang tab nào khác) thì quay về đúng chỗ người dùng đang làm.
 */
const openedFrom = new Map<string, Area>()

function sameKind(a: Area, b: Area): boolean {
  return a === b || (sharesDockview(a) && sharesDockview(b))
}

useTabs.subscribe((state, prev) => {
  const shell = useShell.getState()
  const closedPrev = prev.activeId !== null && !state.tabs.some((t) => t.id === prev.activeId)
  const origin = closedPrev && prev.activeId !== null ? openedFrom.get(prev.activeId) : undefined
  for (const id of [...openedFrom.keys()])
    if (!state.tabs.some((t) => t.id === id)) openedFrom.delete(id)
  // Đã rời tab đó sang tab khác → không còn là "vừa mở từ đâu" nữa.
  if (prev.activeId !== null && state.activeId !== prev.activeId && !closedPrev)
    openedFrom.delete(prev.activeId)
  if (origin && origin !== shell.area) {
    shell.go(origin)
    return
  }
  const active = state.tabs.find((t) => t.id === state.activeId)
  if (!active) return
  const area = tabArea(active)
  const lastTab = shell.lastTab[area] === active.id ? null : { ...shell.lastTab, [area]: active.id }
  const changed = state.activeId !== prev.activeId
  if (!prev.tabs.some((t) => t.id === active.id) && !sameKind(area, shell.area))
    openedFrom.set(active.id, shell.area)
  // Tab trình quản lý file ↔ terminal (cùng tab) → khu vực Files ↔ Hosts theo.
  const viewChanged =
    !changed &&
    prev.tabs.find((t) => t.id === active.id)?.view !== active.view &&
    shell.area !== area
  if (closedPrev && changed) {
    // Đóng tab: chỉ đi theo tab mới nếu cùng khu vực đang xem.
    if (lastTab && sameKind(area, shell.area)) useShell.setState({ lastTab })
    return
  }
  if (changed || viewChanged) {
    useShell.setState((s) => ({
      ...(s.area === area ? {} : { area, ...pushHistory(s, area) }),
      ...(lastTab ? { lastTab } : {})
    }))
  } else if (lastTab) useShell.setState({ lastTab })
})
