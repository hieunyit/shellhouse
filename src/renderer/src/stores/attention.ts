import { useEffect, useRef } from 'react'
import { create } from 'zustand'

/**
 * Trung tâm "Needs attention" (Home, thiết kế v0.5): mỗi nguồn (tab Kubernetes, tab Docker…) báo
 * các vấn đề nó thấy; Home gộp lại theo mức độ. Nguồn tự gỡ khi đóng tab.
 */
export type AttentionSeverity = 'danger' | 'warning' | 'info'

export interface AttentionItem {
  /** Khoá ổn định trong nguồn (vd. "pods/shop/web-2"). */
  id: string
  severity: AttentionSeverity
  title: string
  /** Chip lý do: CrashLoopBackOff, Unhealthy… */
  badge?: string
  description?: string
  /** Nơi xảy ra: "prod-cluster / shop", "build-server". */
  source: string
  /** Mở đúng chỗ (tab của nguồn, chi tiết đối tượng). */
  open?: () => void
}

interface AttentionState {
  sources: Record<string, AttentionItem[]>
  publish: (sourceId: string, items: AttentionItem[]) => void
  remove: (sourceId: string) => void
}

export const useAttention = create<AttentionState>((set, get) => ({
  sources: {},
  publish: (sourceId, items) => {
    const prev = get().sources[sourceId]
    if (!items.length && !prev) return
    set((s) => ({ sources: { ...s.sources, [sourceId]: items } }))
  },
  remove: (sourceId) => {
    if (!(sourceId in get().sources)) return
    set((s) => ({
      sources: Object.fromEntries(Object.entries(s.sources).filter(([k]) => k !== sourceId))
    }))
  }
}))

const RANK: Record<AttentionSeverity, number> = { danger: 0, warning: 1, info: 2 }

/** Mọi mục, nặng trước. */
export function attentionItems(sources: Record<string, AttentionItem[]>): AttentionItem[] {
  return Object.values(sources)
    .flat()
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.title.localeCompare(b.title))
}

/** Báo vấn đề của một nguồn (gọi trong component sở hữu nguồn); gỡ khi component gỡ. */
export function usePublishAttention(sourceId: string, items: AttentionItem[] | null): void {
  const key = useRef(sourceId)
  useEffect(() => {
    if (key.current !== sourceId) useAttention.getState().remove(key.current)
    key.current = sourceId
    if (items) useAttention.getState().publish(sourceId, items)
  }, [sourceId, items])
  useEffect(
    () => () => {
      useAttention.getState().remove(key.current)
    },
    []
  )
}
