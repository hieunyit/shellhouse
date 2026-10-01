import { describe, expect, it } from 'vitest'
import {
  layoutMap,
  podGrid,
  regionOf,
  selectorMatches,
  type MapData,
  type MapNode
} from '../../shared/map'

function data(): MapData {
  const pods = (ns: string, owner: string, n: number, kind = 'Deployment') =>
    Array.from({ length: n }, (_, i) => ({
      ns,
      name: `${owner}-${i}`,
      owner: { kind, name: owner },
      status: i === 0 && owner === 'api' ? 'CrashLoopBackOff' : 'Running',
      tone: i === 0 && owner === 'api' ? ('bad' as const) : ('ok' as const),
      restarts: 0,
      node: 'n1'
    }))
  return {
    namespaces: ['shop', 'kube-system', 'monitoring', 'ingress-nginx'].map((name) => ({
      name,
      active: true
    })),
    workloads: [
      {
        kind: 'deployments.apps',
        ns: 'shop',
        name: 'api',
        labels: { app: 'api' },
        ready: 2,
        desired: 3,
        status: '2/3 ready',
        tone: 'warn',
        pvcs: []
      },
      {
        kind: 'statefulsets.apps',
        ns: 'shop',
        name: 'db',
        labels: { app: 'db', tier: 'data' },
        ready: 1,
        desired: 1,
        status: '1/1 ready',
        tone: 'ok',
        pvcs: ['data-db-0']
      },
      {
        kind: 'deployments.apps',
        ns: 'kube-system',
        name: 'coredns',
        labels: { k8s: 'dns' },
        ready: 2,
        desired: 2,
        status: '2/2 ready',
        tone: 'ok',
        pvcs: []
      },
      {
        kind: 'deployments.apps',
        ns: 'monitoring',
        name: 'grafana',
        labels: { app: 'grafana' },
        ready: 1,
        desired: 1,
        status: '1/1 ready',
        tone: 'ok',
        pvcs: []
      }
    ],
    pods: [
      ...pods('shop', 'api', 3),
      ...pods('shop', 'db', 1, 'StatefulSet'),
      ...pods('kube-system', 'coredns', 2),
      ...pods('monitoring', 'grafana', 1),
      {
        ns: 'shop',
        name: 'debug',
        owner: null,
        status: 'Running',
        tone: 'ok',
        restarts: 0,
        node: 'n1'
      }
    ],
    services: [
      { ns: 'shop', name: 'api', type: 'ClusterIP', selector: { app: 'api' }, ports: '80/TCP' },
      { ns: 'shop', name: 'db', type: 'ClusterIP', selector: { app: 'db' }, ports: '5432/TCP' },
      { ns: 'shop', name: 'orphan', type: 'ClusterIP', selector: {}, ports: '' }
    ],
    routes: [
      {
        kind: 'ingresses.networking.k8s.io',
        ns: 'shop',
        name: 'web',
        hosts: ['shop.example.com'],
        backends: ['api']
      }
    ],
    pvcs: [{ ns: 'shop', name: 'data-db-0', status: 'Bound', capacity: '10Gi', tone: 'ok' }],
    hpas: [
      {
        ns: 'shop',
        name: 'api',
        target: { kind: 'Deployment', name: 'api' },
        min: 2,
        max: 6,
        current: 3
      }
    ],
    policies: [{ ns: 'shop', name: 'deny-db', selector: { matchLabels: { tier: 'data' } } }],
    nodes: { total: 2, ready: 2 },
    truncated: false
  }
}

const inside = (c: MapNode, p: MapNode): boolean =>
  c.x >= p.x && c.y >= p.y && c.x + c.w <= p.x + p.w && c.y + c.h <= p.y + p.h
const overlap = (a: MapNode, b: MapNode): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('bản đồ cluster (Map)', () => {
  it('vùng theo mục đích', () => {
    expect(regionOf('shop')).toBe('Applications')
    expect(regionOf('kube-system')).toBe('System')
    expect(regionOf('calico-system')).toBe('System')
    expect(regionOf('cattle-system')).toBe('Platform')
    expect(regionOf('ingress-nginx')).toBe('Ingress & networking')
    expect(regionOf('monitoring')).toBe('Monitoring')
    expect(regionOf('argocd')).toBe('Platform')
  })

  it('selector: map phẳng (Service), matchLabels + matchExpressions; rỗng tuỳ ngữ cảnh', () => {
    expect(selectorMatches({ app: 'api' }, { app: 'api', v: '1' })).toBe(true)
    expect(selectorMatches({}, { app: 'api' })).toBe(false)
    expect(selectorMatches({}, { app: 'api' }, true)).toBe(true)
    expect(
      selectorMatches(
        { matchExpressions: [{ key: 'tier', operator: 'In', values: ['data'] }] },
        { tier: 'data' }
      )
    ).toBe(true)
    expect(
      selectorMatches(
        { matchExpressions: [{ key: 'x', operator: 'DoesNotExist' }] },
        { tier: 'data' }
      )
    ).toBe(true)
  })

  it('con nằm trong cha, anh em không đè nhau, cùng dữ liệu → cùng toạ độ', () => {
    const layout = layoutMap(data(), { hideSystem: false })
    const byId = new Map(layout.nodes.map((n) => [n.id, n]))
    for (const n of layout.nodes) {
      if (!n.parent) continue
      const p = byId.get(n.parent)
      expect(p, n.id).toBeDefined()
      if (p) expect(inside(n, p), `${n.id} in ${p.id}`).toBe(true)
    }
    const groups = new Map<string, MapNode[]>()
    for (const n of layout.nodes)
      groups.set(n.parent ?? '', [...(groups.get(n.parent ?? '') ?? []), n])
    for (const [, siblings] of groups)
      for (let i = 0; i < siblings.length; i++)
        for (let j = i + 1; j < siblings.length; j++) {
          const a = siblings[i]
          const b = siblings[j]
          if (a && b) expect(overlap(a, b), `${a.id} × ${b.id}`).toBe(false)
        }
    expect(layoutMap(data(), { hideSystem: false })).toEqual(layout)
  })

  it('quan hệ: ingress → service → workload → PVC; HPA / policy thành nhãn; pod theo workload gốc', () => {
    const layout = layoutMap(data(), { hideSystem: false })
    expect(layout.edges).toEqual(
      expect.arrayContaining([
        { from: 'r:ingresses.networking.k8s.io:shop/web', to: 's:shop/api', kind: 'route' },
        { from: 's:shop/api', to: 'w:deployments.apps:shop/api', kind: 'select' },
        { from: 's:shop/db', to: 'w:statefulsets.apps:shop/db', kind: 'select' },
        { from: 'w:statefulsets.apps:shop/db', to: 'v:shop/data-db-0', kind: 'storage' }
      ])
    )
    // Service không selector → không nối.
    expect(layout.edges.some((e) => e.from === 's:shop/orphan')).toBe(false)
    const api = layout.nodes.find((n) => n.id === 'w:deployments.apps:shop/api')
    expect(api?.badges).toEqual(['HPA 2–6'])
    expect(layout.policies['w:statefulsets.apps:shop/db']).toEqual(['deny-db'])
    expect(
      layout.nodes.filter((n) => n.parent === 'w:deployments.apps:shop/api').map((n) => n.label)
    ).toEqual(['api-0', 'api-1', 'api-2'])
    expect(layout.nodes.find((n) => n.id === 'w:pods:shop/standalone')?.label).toBe(
      'Standalone pods'
    )
    // Namespace: tổng hợp cho nhìn xa (tệ nhất trong namespace).
    expect(layout.nodes.find((n) => n.id === 'n:shop')).toMatchObject({
      tone: 'warn',
      stats: { workloads: 3, pods: 5 }
    })
  })

  it('ẩn vùng System; lưới pod gọn', () => {
    const layout = layoutMap(data(), { hideSystem: true })
    expect(layout.nodes.some((n) => n.ns === 'kube-system')).toBe(false)
    expect(layout.nodes.filter((n) => n.kind === 'region').map((n) => n.label)).toEqual([
      'Applications',
      'Ingress & networking',
      'Monitoring'
    ])
    expect(podGrid(0)).toEqual({ cols: 0, rows: 0 })
    expect(podGrid(100)).toEqual({ cols: 15, rows: 7 })
  })

  it('cluster lớn: 3000 workload / 15000 pod xếp dưới 1 giây', () => {
    const big: MapData = {
      ...data(),
      workloads: [],
      pods: [],
      services: [],
      routes: [],
      pvcs: [],
      hpas: [],
      policies: []
    }
    for (let n = 0; n < 60; n++)
      for (let w = 0; w < 50; w++) {
        big.workloads.push({
          kind: 'deployments.apps',
          ns: `ns-${n}`,
          name: `w${w}`,
          labels: { app: `w${w}` },
          ready: 5,
          desired: 5,
          status: '5/5 ready',
          tone: 'ok',
          pvcs: []
        })
        for (let p = 0; p < 5; p++)
          big.pods.push({
            ns: `ns-${n}`,
            name: `w${w}-${p}`,
            owner: { kind: 'Deployment', name: `w${w}` },
            status: 'Running',
            tone: 'ok',
            restarts: 0,
            node: 'n'
          })
        big.services.push({
          ns: `ns-${n}`,
          name: `w${w}`,
          type: 'ClusterIP',
          selector: { app: `w${w}` },
          ports: '80/TCP'
        })
      }
    const t = Date.now()
    const layout = layoutMap(big, { hideSystem: false })
    expect(Date.now() - t).toBeLessThan(1000)
    expect(layout.nodes.filter((n) => n.kind === 'pod')).toHaveLength(15000)
    expect(layout.edges).toHaveLength(3000)
  })
})
