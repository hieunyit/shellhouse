import { describe, expect, it } from 'vitest'
import type { MapData, MapNodeInfo, MapPod } from '../../shared/map'
import { summarizeNodes } from '../../shared/nodes'

const GiB = 1024 ** 3

function node(name: string, patch: Partial<MapNodeInfo> = {}): MapNodeInfo {
  return {
    name,
    ready: true,
    unschedulable: false,
    roles: [],
    zone: '',
    instance: '',
    kubelet: 'v1.31.0',
    allocatable: { cpu: 4000, memory: 8 * GiB, pods: 110 },
    usage: null,
    taints: [],
    pressure: [],
    ...patch
  }
}

function pod(name: string, nodeName: string, patch: Partial<MapPod> = {}): MapPod {
  return {
    ns: 'shop',
    name,
    owner: { kind: 'Deployment', name: 'api' },
    status: 'Running',
    tone: 'ok',
    restarts: 0,
    node: nodeName,
    cpu: 500,
    memory: GiB,
    ...patch
  }
}

function data(nodeList: MapNodeInfo[], pods: MapPod[]): MapData {
  return {
    namespaces: [],
    workloads: [],
    pods,
    services: [],
    routes: [],
    pvcs: [],
    hpas: [],
    policies: [],
    nodes: { total: nodeList.length, ready: nodeList.filter((n) => n.ready).length },
    nodeList,
    truncated: false
  }
}

describe('bản đồ theo node', () => {
  it('cộng requests của pod còn chạy; pod đã xong không tính', () => {
    const s = summarizeNodes(
      data(
        [node('a'), node('b')],
        [
          pod('api-1', 'a'),
          pod('api-2', 'b'),
          pod('job-1', 'a', {
            owner: { kind: 'Job', name: 'j' },
            status: 'Completed',
            tone: 'muted'
          }),
          pod('pending', '', { status: 'Pending', tone: 'warn' })
        ]
      )
    )
    const a = s.nodes.find((n) => n.info.name === 'a')
    expect(a?.requested).toEqual({ cpu: 500, memory: GiB })
    expect(a?.pods.map((p) => p.name)).toEqual(['api-1', 'job-1'])
    expect(a?.active).toBe(1)
    expect(a?.tone).toBe('ok')
    expect(s.unscheduled.map((p) => p.name)).toEqual(['pending'])
    // api có replica ở cả a và b → không rủi ro.
    expect(s.risks).toEqual([])
  })

  it('báo node không sẵn sàng, áp lực, cordon, cấp phát gần đầy, RAM dùng cao', () => {
    const s = summarizeNodes(
      data(
        [
          node('down', { ready: false }),
          node('mem', { pressure: ['MemoryPressure'] }),
          node('cordoned', { unschedulable: true }),
          node('full', { allocatable: { cpu: 1000, memory: 8 * GiB, pods: 110 } }),
          node('hot', { usage: { cpu: 100, memory: 7.9 * GiB } })
        ],
        [pod('x', 'full', { cpu: 900 })]
      )
    )
    const by = (n: string) => s.nodes.find((x) => x.info.name === n)
    expect(by('down')).toMatchObject({ tone: 'bad', issues: [{ text: 'Not ready', tone: 'bad' }] })
    expect(by('mem')?.tone).toBe('bad')
    expect(by('cordoned')).toMatchObject({ tone: 'warn', issues: [{ text: 'Cordoned' }] })
    expect(by('full')).toMatchObject({
      tone: 'warn',
      issues: [{ text: 'CPU 90% requested', tone: 'warn' }]
    })
    expect(by('hot')).toMatchObject({ tone: 'bad', issues: [{ text: 'Memory 99% used' }] })
  })

  it('workload dồn hết replica vào một node → rủi ro (chỉ khi có ≥ 2 node nhận pod)', () => {
    const pods = [
      pod('api-1', 'a'),
      pod('api-2', 'a'),
      pod('api-3', 'a'),
      pod('db-0', 'a', { owner: { kind: 'StatefulSet', name: 'db' } }),
      pod('agent-1', 'a', { owner: { kind: 'DaemonSet', name: 'agent' } }),
      pod('agent-2', 'a', { owner: { kind: 'DaemonSet', name: 'agent' } })
    ]
    expect(summarizeNodes(data([node('a'), node('b')], pods)).risks).toEqual([
      { ns: 'shop', kind: 'Deployment', name: 'api', node: 'a', replicas: 3 }
    ])
    // Chỉ một node (node kia cordon) → không có chỗ để rải, không báo.
    expect(
      summarizeNodes(data([node('a'), node('b', { unschedulable: true })], pods)).risks
    ).toEqual([])
  })
})
