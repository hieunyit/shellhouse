import { useEffect, useRef, useState } from 'react'
import { cleanError } from '../../../renderer/src/lib/format'
import { t, toast } from '../../registry/renderer-kit'
import type { DiscoveredKind, K8sOp, MetricsResult } from '../shared/ops'

type Request = <T>(op: K8sOp) => Promise<T>

const COUNT_EVERY_MS = 60_000
const METRIC_EVERY_MS = 15_000

/**
 * Danh mục của cluster: loại tài nguyên (gồm CRD) + quyền, namespace (tất cả / đang chọn), số đối
 * tượng mỗi loại cho thanh điều hướng. Đổi context ngay trong tab → bỏ dữ liệu của context cũ ngay
 * trong lần render đó (không đợi effect) để không treo "Loading…" hay hiện số của cluster cũ.
 */
export function useClusterCatalog({
  ready,
  request,
  active,
  reloadKey,
  refKey,
  initialNamespace,
  clusterNamespace
}: {
  ready: boolean
  request: Request
  active: boolean
  reloadKey: number
  refKey: string
  /** Namespace đặt sẵn cho context (tham số tab). */
  initialNamespace: string | undefined
  /** Namespace mặc định của context trong kubeconfig. */
  clusterNamespace: string | undefined
}): {
  kinds: DiscoveredKind[] | null
  allNamespaces: string[]
  /** null = chưa biết (đang hỏi); [] = mọi namespace. */
  namespaces: string[] | null
  setNamespaces: (v: string[] | null) => void
  counts: Record<string, number | null>
} {
  const [kinds, setKinds] = useState<DiscoveredKind[] | null>(null)
  const [allNamespaces, setAllNamespaces] = useState<string[]>([])
  const [namespaces, setNamespaces] = useState<string[] | null>(
    initialNamespace ? [initialNamespace] : null
  )
  const [counts, setCounts] = useState<Record<string, number | null>>({})
  /** reloadKey của lần discover gần nhất (khác → người dùng vừa bấm Reload). */
  const discoveredAt = useRef(0)

  const [shownRef, setShownRef] = useState(refKey)
  if (shownRef !== refKey) {
    setShownRef(refKey)
    setKinds(null)
    setAllNamespaces([])
    setNamespaces(initialNamespace ? [initialNamespace] : null)
    setCounts({})
  }
  const nsForAccess = namespaces?.length === 1 ? namespaces[0] : undefined

  // Loại tài nguyên (gồm CRD) + quyền; danh sách namespace.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    // Bấm Reload → hỏi lại danh mục loại + quyền (không dùng bản nhớ của Session Host).
    const refresh = reloadKey !== discoveredAt.current
    discoveredAt.current = reloadKey
    request<DiscoveredKind[]>({
      op: 'discover',
      ...(nsForAccess ? { namespace: nsForAccess } : {}),
      ...(refresh ? { refresh: true } : {})
    }).then(
      (k) => {
        if (!cancelled) setKinds(k)
      },
      (e: unknown) => {
        if (!cancelled)
          toast.error(t('Could not read the resource types of this cluster'), {
            description: cleanError(e)
          })
      }
    )
    request<{ names: string[]; canList: boolean }>({ op: 'namespaces' }).then(
      (r) => {
        if (cancelled) return
        setAllNamespaces(r.names)
        setNamespaces((cur) => cur ?? (r.canList ? [clusterNamespace ?? 'default'] : r.names))
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [ready, request, nsForAccess, clusterNamespace, reloadKey])

  // Số đối tượng mỗi loại cho thanh điều hướng (như Rancher): khi đổi namespace / tải lại và
  // 60 giây một lần khi tab đang hiện.
  const countKey = (kinds ?? [])
    .filter((k) => !k.forbidden)
    .map((k) => k.id)
    .join(',')
  const countNs = (namespaces ?? []).join(',')
  const nsKnown = namespaces !== null
  useEffect(() => {
    if (!ready || !active || !countKey || !nsKnown) return
    let cancelled = false
    const poll = (): void => {
      request<Record<string, number | null>>({
        op: 'counts',
        kinds: countKey.split(','),
        namespaces: countNs ? countNs.split(',') : []
      }).then(
        (c) => {
          if (!cancelled) setCounts(c)
        },
        () => undefined
      )
    }
    poll()
    const timer = setInterval(poll, COUNT_EVERY_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [ready, active, request, countKey, countNs, nsKnown, reloadKey])

  return { kinds, allNamespaces, namespaces, setNamespaces, counts }
}

/** CPU / RAM (metrics-server) cho pod và node, 15 giây một lần khi tab đang hiện. */
export function useClusterMetrics({
  ready,
  request,
  active,
  kindId,
  scopeNs
}: {
  ready: boolean
  request: Request
  active: boolean
  kindId: string
  scopeNs: readonly string[]
}): { metrics: MetricsResult | null; metricScope: 'pods' | 'nodes' | null } {
  // Gắn với phiên (request) đã tạo ra nó: đổi context → không hiện số của cluster cũ.
  const [state, setState] = useState<{ request: Request; metrics: MetricsResult } | null>(null)
  const metricScope = kindId === 'pods' ? 'pods' : kindId === 'nodes' ? 'nodes' : null
  const metricNs = kindId === 'pods' && scopeNs.length === 1 ? scopeNs[0] : undefined
  useEffect(() => {
    if (!ready || !metricScope || !active) return
    let cancelled = false
    const poll = (): void => {
      request<MetricsResult>({
        op: 'metrics',
        scope: metricScope,
        ...(metricNs ? { namespace: metricNs } : {})
      }).then(
        (m) => {
          if (!cancelled) setState({ request, metrics: m })
        },
        () => undefined
      )
    }
    poll()
    const timer = setInterval(poll, METRIC_EVERY_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [ready, request, metricScope, metricNs, active])
  return { metrics: state?.request === request ? state.metrics : null, metricScope }
}
