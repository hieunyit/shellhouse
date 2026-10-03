import { create } from 'zustand'
import { TEST_HOOKS_GLOBAL } from '@shared/test-hooks'
import { useTabs } from './tabs'

/**
 * Thanh bên gọn (thanh icon ~48 px) hay đầy đủ — nhớ RIÊNG theo loại tab đang mở:
 * - module (Docker / Kubernetes / S3…): mặc định gọn — module đã có cột điều hướng riêng, bảng +
 *   panel chi tiết cần chỗ ngang;
 * - còn lại (terminal, Home, editor): mặc định đầy đủ.
 * Người dùng bấm thu gọn / mở rộng → ghi đè cho đúng loại đó (lưu theo máy, localStorage).
 */
export type SidebarMode = 'module' | 'default'

const KEY = 'shellhouse.sidebar.compact'

function defaults(): Record<SidebarMode, boolean> {
  // E2E giữ thanh bên đầy đủ như trước (các kịch bản cũ bấm vào cây host khi đang ở tab module).
  // Lúc nạp module test hooks có thể chưa cài — main.tsx gọi lại `applyTestDefaults()` sau đó.
  return { module: !(TEST_HOOKS_GLOBAL in window), default: false }
}

/** Gọi sau khi cài test hooks: mặc định e2e = thanh bên đầy đủ (trừ khi test đã tự chọn). */
export function applyTestDefaults(): void {
  if (localStorage.getItem(KEY) !== null) return
  useSidebarLayout.setState({ compact: { module: false, default: false } })
}

function load(): Record<SidebarMode, boolean> {
  const base = defaults()
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return base
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Partial<Record<SidebarMode, unknown>>
      if (typeof p.module === 'boolean') base.module = p.module
      if (typeof p.default === 'boolean') base.default = p.default
    }
  } catch {
    // Hỏng → mặc định.
  }
  return base
}

interface SidebarLayout {
  compact: Record<SidebarMode, boolean>
  setCompact: (mode: SidebarMode, compact: boolean) => void
  /** Yêu cầu mở tạm (peek) thanh bên đang gọn; `focusSearch` = đưa con trỏ vào ô tìm host. */
  peek: { seq: number; focusSearch: boolean } | null
  requestPeek: (focusSearch: boolean) => void
}

export const useSidebarLayout = create<SidebarLayout>((set, get) => ({
  compact: load(),
  setCompact: (mode, compact) => {
    const next = { ...get().compact, [mode]: compact }
    set({ compact: next })
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // Không lưu được → chỉ mất lựa chọn giao diện.
    }
  },
  peek: null,
  requestPeek: (focusSearch) => {
    set({ peek: { seq: (get().peek?.seq ?? 0) + 1, focusSearch } })
  }
}))

/** Loại thanh bên theo tab đang chọn. */
export function modeForTab(kind: string | undefined): SidebarMode {
  return kind === 'module' ? 'module' : 'default'
}

export function useSidebarMode(): SidebarMode {
  return useTabs((s) => modeForTab(s.tabs.find((t) => t.id === s.activeId)?.target.kind))
}

/** Thanh bên đang ở dạng gọn (theo tab đang chọn). */
export function useSidebarCompact(): boolean {
  const mode = useSidebarMode()
  return useSidebarLayout((s) => s.compact[mode])
}
