import type { ReactNode } from 'react'
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
}>((set, get) => ({
  el: null,
  set: (el) => {
    if (get().el !== el) set({ el })
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
  if (slot) return active ? createPortal(children('explorer'), slot) : null
  return children('inline')
}

/** Cột điều hướng của module đang nằm ở Explorer hay trong view. */
export function useNavPlacement(): NavPlacement {
  return useExplorerSlot((s) => (s.el ? 'explorer' : 'inline'))
}
