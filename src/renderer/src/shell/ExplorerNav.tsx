import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'

/**
 * Chỗ trong Explorer (khu vực module) để tab module đang mở đặt cột điều hướng của nó — Overview ·
 * Pods · Deployments… của cluster, Containers · Images… của Docker endpoint — như cây trong
 * prototype v0.5. Explorer đang ẩn → module tự vẽ cột điều hướng trong view như trước.
 */
export const useExplorerSlot = create<{
  el: HTMLElement | null
  set: (el: HTMLElement | null) => void
  /** Có cột điều hướng của một tab module đang đặt trong chỗ này (để Explorer vẽ nút thu gọn). */
  filled: boolean
  setFilled: (filled: boolean) => void
}>((set, get) => ({
  el: null,
  set: (el) => {
    if (get().el !== el) set({ el })
  },
  filled: false,
  setFilled: (filled) => {
    if (get().filled !== filled) set({ filled })
  }
}))

export type NavPlacement = 'explorer' | 'inline'

export function ExplorerNav({
  active,
  children
}: {
  /** Tab đang hiện — tab ẩn không chiếm chỗ của Explorer. */
  active: boolean
  children: (placement: NavPlacement) => ReactNode
}): ReactNode {
  const slot = useExplorerSlot((s) => s.el)
  const fills = Boolean(slot) && active
  useEffect(() => {
    if (!fills) return
    useExplorerSlot.getState().setFilled(true)
    return () => {
      useExplorerSlot.getState().setFilled(false)
    }
  }, [fills])
  if (slot) return active ? createPortal(children('explorer'), slot) : null
  return children('inline')
}

/** Cột điều hướng của module đang nằm ở Explorer hay trong view. */
export function useNavPlacement(): NavPlacement {
  return useExplorerSlot((s) => (s.el ? 'explorer' : 'inline'))
}
