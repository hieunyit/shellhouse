import type { MetricsRange, MetricsSeries } from '../shared/ops'
import { KubeError, type KubeClient } from './client'
import { listPaged } from './operations'

/**
 * Lịch sử CPU / RAM của pod từ Prometheus trong cluster (kube-prometheus-stack, Rancher Monitoring,
 * prometheus-server…), gọi qua API server proxy (`services/proxy`) — không cần mở cổng nào.
 * Không tìm thấy / không có quyền → source 'none' (renderer tự lấy mẫu từ metrics-server).
 */

export interface PromTarget {
  ns: string
  name: string
  port: number
}

interface ServiceList {
  items: {
    metadata: { name: string; namespace?: string }
    spec?: { clusterIP?: string; ports?: { port: number; name?: string }[] }
  }[]
}

const SKIP = /alertmanager|operator|node-exporter|pushgateway|adapter|blackbox|kube-state|grafana/
/** Tên quen thuộc của service Prometheus chính, ưu tiên trước. */
const PREFERRED = [
  /^prometheus-operated$/,
  /rancher-monitoring-prometheus$/,
  /kube-prometheus.*-prometheus$/,
  /^prometheus-k8s$/,
  /^prometheus-server$/,
  /^prometheus$/
]

export const promBase = (t: PromTarget): string =>
  `/api/v1/namespaces/${encodeURIComponent(t.ns)}/services/${encodeURIComponent(t.name)}:${String(t.port)}/proxy`

/** Ứng viên theo thứ tự ưu tiên (service có cổng 9090 hoặc cổng tên web / http-web). */
export function prometheusCandidates(list: ServiceList): PromTarget[] {
  const out: { t: PromTarget; rank: number }[] = []
  for (const s of list.items) {
    const name = s.metadata.name
    if (!/prometheus/.test(name) || SKIP.test(name)) continue
    const port = (s.spec?.ports ?? []).find(
      (p) => p.port === 9090 || p.name === 'web' || p.name === 'http-web'
    )
    if (!port) continue
    const pref = PREFERRED.findIndex((re) => re.test(name))
    out.push({
      t: { ns: s.metadata.namespace ?? 'default', name, port: port.port },
      rank: pref === -1 ? PREFERRED.length : pref
    })
  }
  return out.sort((a, b) => a.rank - b.rank || a.t.name.localeCompare(b.t.name)).map((x) => x.t)
}

/** Tìm Prometheus trả lời được (thử tối đa 3 ứng viên). */
export async function findPrometheus(
  client: KubeClient,
  signal?: AbortSignal
): Promise<PromTarget | null> {
  let list: ServiceList
  try {
    list = await listPaged(client, '/api/v1/services', { signal, max: 20_000 })
  } catch (error) {
    if (error instanceof KubeError) return null
    throw error
  }
  for (const t of prometheusCandidates(list).slice(0, 3)) {
    try {
      const r = await client.json<{ status?: string }>('GET', `${promBase(t)}/api/v1/query`, {
        query: { query: '1' },
        ...(signal ? { signal } : {})
      })
      if (r.status === 'success') return t
    } catch {
      // Thử ứng viên tiếp theo.
    }
  }
  return null
}

/**
 * Tên → mẫu regex trong chuỗi PromQL "…": ký tự đặc biệt của regex thoát bằng gạch chéo ngược, và
 * trong chuỗi PromQL gạch chéo đó phải viết đôi (`web-1\\.x`) — viết đơn là escape không hợp lệ,
 * Prometheus báo lỗi cú pháp.
 */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&')

interface Matrix {
  status?: string
  data?: { result?: { metric: Record<string, string>; values: [number, string][] }[] }
}

/** CPU (millicore) và RAM (byte) theo pod trong `minutes` phút gần nhất. */
export async function podRange(
  client: KubeClient,
  target: PromTarget,
  namespace: string,
  pods: readonly string[],
  minutes: number,
  signal?: AbortSignal
): Promise<MetricsRange> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - minutes * 60
  // ~120 điểm mỗi đường, bước tối thiểu 15 s.
  const step = Math.max(15, Math.round((minutes * 60) / 120))
  const sel = `namespace="${namespace}",pod=~"${pods.map(escapeRe).join('|')}",container!="",container!="POD"`
  const window = `${String(Math.max(60, step * 2))}s`
  const run = async (query: string, scale: number): Promise<MetricsSeries[]> => {
    const r = await client.json<Matrix>('GET', `${promBase(target)}/api/v1/query_range`, {
      query: { query, start, end, step },
      ...(signal ? { signal } : {})
    })
    return (r.data?.result ?? []).map((s) => ({
      pod: s.metric['pod'] ?? '',
      points: s.values.map(([t, v]) => [t * 1000, Number(v) * scale] as [number, number])
    }))
  }
  const [cpu, memory] = await Promise.all([
    run(`sum by (pod) (rate(container_cpu_usage_seconds_total{${sel}}[${window}]))`, 1000),
    run(`sum by (pod) (container_memory_working_set_bytes{${sel}})`, 1)
  ])
  return {
    source: 'prometheus',
    via: `${target.ns}/${target.name}`,
    start: start * 1000,
    end: end * 1000,
    step: step * 1000,
    cpu,
    memory
  }
}
