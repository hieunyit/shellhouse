import { useCallback, useLayoutEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import { create } from 'zustand'

/**
 * Chỗ trong Explorer (khu vực module) để tab module đang mở đặt cột điều hướng của nó — Overview ·
 * Pods · Deployments… của cluster, Containers · Images… của Docker endpoint — như cây trong
 * prototype v0.5. Mỗi cluster / endpoint có chỗ riêng NGAY DƯỚI dòng của nó (ExplorerNavSlot), nên
 * nhiều cụm cùng mở vẫn đọc được cụm nào đang xem. Explorer đang ẩn → module tự vẽ cột điều hướng
 * trong view như trước.
 */
export const useExplorerSlot = create<{
  /** owner (khoá cluster / endpoint) → phần tử chứa cây điều hướng của nó. */
  slots: Readonly<Record<string, HTMLElement>>
  register: (owner: string, el: HTMLElement | null) => void
  /** owner của tab module đang hiện (cây của nó được mở ra dưới dòng của owner). */
  activeOwner: string | null
  setActiveOwner: (owner: string | null) => void
  /** Cây điều hướng của owner đang gập. */
  collapsed: ReadonlySet<string>
  toggleCollapsed: (owner: string) => void
}>((set, get) => ({
  slots: {},
  register: (owner, el) => {
    const slots = get().slots
    if (el) {
      if (slots[owner] === el) return
      set({ slots: { ...slots, [owner]: el } })
    } else {
      if (!(owner in slots)) return
      set({ slots: Object.fromEntries(Object.entries(slots).filter(([k]) => k !== owner)) })
    }
  },
  activeOwner: null,
  setActiveOwner: (activeOwner) => {
    if (get().activeOwner !== activeOwner) set({ activeOwner })
  },
  collapsed: new Set(),
  toggleCollapsed: (owner) => {
    const next = new Set(get().collapsed)
    if (next.has(owner)) next.delete(owner)
    else next.add(owner)
    set({ collapsed: next })
  }
}))

export type NavPlacement = 'explorer' | 'inline'

export function ExplorerNav({
  active,
  owner,
  children
}: {
  /** Tab đang hiện — tab ẩn không chiếm chỗ của Explorer. */
  active: boolean
  /** Khoá cluster / endpoint của tab: cây điều hướng nằm dưới dòng cùng khoá trong Explorer. */
  owner: string
  children: (placement: NavPlacement) => ReactNode
}): ReactNode {
  const slot = useExplorerSlot((s) => s.slots[owner])
  // Layout effect: dòng của owner mở chỗ chứa trước khi vẽ → cây không nháy "trong view" một khung.
  useLayoutEffect(() => {
    if (!active) return
    useExplorerSlot.getState().setActiveOwner(owner)
    return () => {
      const s = useExplorerSlot.getState()
      if (s.activeOwner === owner) s.setActiveOwner(null)
    }
  }, [active, owner])
  // Tab ẩn không dựng cột điều hướng (trong Explorer thì tab khác đang chiếm chỗ; trong view thì ẩn).
  if (!active) return null
  return slot ? createPortal(children('explorer'), slot) : children('inline')
}

/** Chỗ chứa cây điều hướng của `owner`, vẽ ngay dưới dòng của nó trong Explorer. */
export function ExplorerNavSlot({ owner }: { owner: string }): ReactNode {
  const collapsed = useExplorerSlot((s) => s.collapsed.has(owner))
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      useExplorerSlot.getState().register(owner, el)
    },
    [owner]
  )
  return (
    <div
      ref={ref}
      className={
        collapsed ? 'hidden' : 'mb-1 ml-3.5 border-l border-ds-border-subtle pl-1 empty:hidden'
      }
      data-testid="explorer-module-nav"
      data-owner={owner}
    />
  )
}

/** Dòng của `owner` trong Explorer: đang là cụm / endpoint của tab hiện tại, đang gập hay mở. */
export function useNavRow(owner: string): {
  active: boolean
  collapsed: boolean
  toggle: () => void
} {
  const active = useExplorerSlot((s) => s.activeOwner === owner)
  const collapsed = useExplorerSlot((s) => s.collapsed.has(owner))
  const toggle = useCallback(() => {
    useExplorerSlot.getState().toggleCollapsed(owner)
  }, [owner])
  return { active, collapsed, toggle }
}

/** Cột điều hướng của module đang nằm ở Explorer hay trong view. */
export function useNavPlacement(owner: string): NavPlacement {
  return useExplorerSlot((s) => (s.slots[owner] ? 'explorer' : 'inline'))
}

/**
 * Dòng cluster / endpoint trong Explorer: tô sáng khi là cụm của tab đang xem, có mũi tên gập, và
 * cây điều hướng của nó mở ngay bên dưới. `row` vẽ dòng (chevron đặt ở đầu dòng).
 */
export function NavTreeRow({
  owner,
  row
}: {
  owner: string
  row: (state: { active: boolean; chevron: ReactNode }) => ReactNode
}): ReactNode {
  const { active, collapsed, toggle } = useNavRow(owner)
  const chevron = active ? (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'Expand' : 'Collapse'}
      data-testid="explorer-nav-toggle"
      className="-ml-1 flex size-4 shrink-0 items-center justify-center rounded-ds-sm text-ds-fg-3 hover:bg-ds-hover hover:text-ds-fg"
      onClick={(e) => {
        e.stopPropagation()
        toggle()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
      }}
    >
      <ChevronRight size={13} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
    </button>
  ) : (
    <span className="-ml-1 size-4 shrink-0" aria-hidden />
  )
  return (
    <>
      {row({ active, chevron })}
      {active && <ExplorerNavSlot owner={owner} />}
    </>
  )
}
