import { t } from '@shared/i18n'
import type { MapData, MapNodeInfo, MapPod, MapTone } from './map'

/**
 * Góc nhìn hạ tầng (theo node): mỗi máy được cấp bao nhiêu CPU / RAM (requests so với
 * allocatable), đang dùng thật bao nhiêu, pod nào chạy trên đó, và workload nào dồn hết replica
 * vào một máy (máy chết là dịch vụ chết). Thuần — renderer và test dùng chung.
 */

export interface NodeView {
  info: MapNodeInfo
  /** Tổng requests của pod còn chạy trên node (millicore / byte). */
  requested: { cpu: number; memory: number }
  /** Pod trên node (cả pod đã xong — để thấy), theo tên. */
  pods: MapPod[]
  /** Pod còn chiếm tài nguyên (không tính Succeeded / Failed). */
  active: number
  tone: MapTone
  /** Lý do tone (dòng ngắn): "Not ready", "MemoryPressure", "CPU 96% requested"… */
  issues: { text: string; tone: MapTone }[]
}

export interface SpreadRisk {
  ns: string
  /** Deployment, StatefulSet, ReplicaSet. */
  kind: string
  name: string
  node: string
  replicas: number
}

export interface NodesSummary {
  nodes: NodeView[]
  /** Pod chưa được xếp lên node nào (Pending). */
  unscheduled: MapPod[]
  risks: SpreadRisk[]
}

const DONE = new Set(['Succeeded', 'Completed', 'Failed', 'Evicted', 'Error', 'OOMKilled'])
const isActive = (p: MapPod): boolean => !DONE.has(p.status)

/** Loại có nhiều replica tương đương — dồn hết vào một máy là rủi ro. */
const REPLICATED = new Set(['Deployment', 'StatefulSet', 'ReplicaSet'])

/** Ngưỡng cấp phát (requests / allocatable) để báo vàng / đỏ. */
export const ALLOC_WARN = 0.85
export const ALLOC_BAD = 1

export function summarizeNodes(data: MapData): NodesSummary {
  const byNode = new Map<string, MapPod[]>()
  const unscheduled: MapPod[] = []
  for (const p of data.pods) {
    if (!p.node) {
      if (isActive(p)) unscheduled.push(p)
      continue
    }
    const list = byNode.get(p.node)
    if (list) list.push(p)
    else byNode.set(p.node, [p])
  }
  const nodes = (data.nodeList ?? []).map((info): NodeView => {
    const pods = [...(byNode.get(info.name) ?? [])].sort((a, b) =>
      `${a.ns}/${a.name}`.localeCompare(`${b.ns}/${b.name}`)
    )
    const live = pods.filter(isActive)
    const requested = live.reduce(
      (acc, p) => ({ cpu: acc.cpu + (p.cpu ?? 0), memory: acc.memory + (p.memory ?? 0) }),
      { cpu: 0, memory: 0 }
    )
    const issues: NodeView['issues'] = []
    const raise = (level: MapTone, why: string): void => {
      issues.push({ text: why, tone: level })
    }
    if (!info.ready) raise('bad', t('Not ready'))
    for (const p of info.pressure) raise('bad', p)
    if (info.unschedulable) raise('warn', t('Cordoned'))
    const ratio = (used: number, cap: number): number => (cap > 0 ? used / cap : 0)
    for (const [label, r] of [
      ['CPU', ratio(requested.cpu, info.allocatable.cpu)],
      [t('Memory'), ratio(requested.memory, info.allocatable.memory)],
      ['Pods', ratio(live.length, info.allocatable.pods)]
    ] as const)
      if (r >= ALLOC_BAD)
        raise(
          'bad',
          t('{resource} {pct}% requested', { resource: label, pct: Math.round(r * 100) })
        )
      else if (r >= ALLOC_WARN)
        raise(
          'warn',
          t('{resource} {pct}% requested', { resource: label, pct: Math.round(r * 100) })
        )
    if (info.usage && info.allocatable.memory > 0) {
      const r = ratio(info.usage.memory, info.allocatable.memory)
      if (r >= 0.9)
        raise(r >= 0.97 ? 'bad' : 'warn', t('Memory {pct}% used', { pct: Math.round(r * 100) }))
    }
    const tone: MapTone = issues.some((i) => i.tone === 'bad')
      ? 'bad'
      : issues.length || live.some((p) => p.tone === 'bad')
        ? 'warn'
        : 'ok'
    return { info, requested, pods, active: live.length, tone, issues }
  })

  // Rủi ro dồn replica: chỉ có nghĩa khi có ≥ 2 node nhận pod được.
  const schedulable = (data.nodeList ?? []).filter((n) => n.ready && !n.unschedulable).length
  const risks: SpreadRisk[] = []
  if (schedulable >= 2) {
    const groups = new Map<string, MapPod[]>()
    for (const p of data.pods) {
      if (!p.owner || !REPLICATED.has(p.owner.kind) || !p.node || !isActive(p)) continue
      const key = `${p.ns}|${p.owner.kind}|${p.owner.name}`
      const list = groups.get(key)
      if (list) list.push(p)
      else groups.set(key, [p])
    }
    for (const [key, pods] of groups) {
      const where = new Set(pods.map((p) => p.node))
      const node = pods[0]?.node ?? ''
      if (pods.length < 2 || where.size !== 1) continue
      const [ns = '', kind = '', name = ''] = key.split('|')
      risks.push({ ns, kind, name, node, replicas: pods.length })
    }
    risks.sort(
      (a, b) => b.replicas - a.replicas || `${a.ns}/${a.name}`.localeCompare(`${b.ns}/${b.name}`)
    )
  }
  return { nodes, unscheduled, risks }
}
