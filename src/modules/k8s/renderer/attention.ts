import { useEffect, useMemo, useState } from 'react'
import { tn, usePublishAttention, type AttentionItem } from '../../registry/renderer-kit'
import type { K8sOp, OverviewResult, ProblemGroup } from '../shared/ops'

type Request = <T>(op: K8sOp) => Promise<T>
type Problems = NonNullable<OverviewResult['problems']>

/** Hỏi lại vấn đề của cluster chừng này một lần (cả khi tab đang ẩn — Home cần số liệu). */
const EVERY_MS = 60_000
/** Hàm mở đối tượng của từng tab cluster (tabId → bản mới nhất). */
const openers = new Map<string, (kind: string, ns: string | undefined, name: string) => void>()
/** Tối đa số mục mỗi cluster gửi lên Home (danh sách đầy đủ ở Overview của cluster). */
const MAX_ITEMS = 12

const SEVERITY: Record<ProblemGroup, AttentionItem['severity']> = {
  failing: 'danger',
  imagePull: 'danger',
  nodes: 'danger',
  pending: 'warning',
  pvcs: 'warning'
}
const ORDER: readonly ProblemGroup[] = ['failing', 'imagePull', 'nodes', 'pending', 'pvcs']

/** Vấn đề (cùng nguồn với Overview) → mục "Needs attention" của Home. */
export function attentionOf(
  p: Problems,
  cluster: string,
  open: (kind: string, ns: string | undefined, name: string) => void
): AttentionItem[] {
  const out: AttentionItem[] = []
  for (const group of ORDER)
    for (const it of p[group].items) {
      if (out.length >= MAX_ITEMS) return out
      const restarts =
        it.restarts && it.restarts > 0 ? tn(it.restarts, '{n} restart', '{n} restarts') : ''
      out.push({
        id: `${it.kind}/${it.namespace ?? ''}/${it.name}`,
        severity: SEVERITY[group],
        title: it.name,
        badge: it.reason,
        description: [restarts, it.message].filter(Boolean).join(' — ') || undefined,
        source: it.namespace ? `${cluster} / ${it.namespace}` : cluster,
        open: () => {
          open(it.kind, it.namespace, it.name)
        }
      })
    }
  return out
}

/**
 * Báo vấn đề của cluster lên Home › Needs attention khi tab đang mở: op `problems` (pod lỗi, node
 * NotReady, PVC chưa bound) mỗi phút. Tắt mục này trong Settings → không hỏi.
 */
export function useClusterAttention({
  tabId,
  ready,
  request,
  cluster,
  enabled,
  open
}: {
  tabId: string
  ready: boolean
  request: Request
  cluster: string
  enabled: boolean
  open: (kind: string, ns: string | undefined, name: string) => void
}): void {
  const [problems, setProblems] = useState<Problems | null>(null)
  useEffect(() => {
    if (!ready || !enabled) return
    let cancelled = false
    const load = (): void => {
      request<Problems>({ op: 'problems' }).then(
        (p) => {
          if (!cancelled) setProblems(p)
        },
        () => undefined
      )
    }
    load()
    const timer = setInterval(load, EVERY_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [ready, enabled, request])
  // Hàm mở đổi mỗi lần vẽ → giữ bản mới nhất theo tab; mục trên Home gọi qua tabId.
  useEffect(() => {
    openers.set(tabId, open)
  })
  useEffect(
    () => () => {
      openers.delete(tabId)
    },
    [tabId]
  )
  const items = useMemo(
    () =>
      !enabled
        ? []
        : problems
          ? attentionOf(problems, cluster, (kind, ns, name) => {
              openers.get(tabId)?.(kind, ns, name)
            })
          : null,
    [problems, cluster, enabled, tabId]
  )
  usePublishAttention(`k8s:${tabId}`, items)
}
