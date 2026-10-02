import { describe, expect, it } from 'vitest'
import {
  filterMapData,
  fitLabel,
  splitLabel,
  groupNamespaces,
  groupingKeys,
  layoutMap,
  parseLabelSelector,
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

  it('gom vùng theo tiền tố tên và theo nhãn (namespace, không có thì nhãn workload)', () => {
    const d = data()
    d.namespaces.push(
      { name: 'payment-core', active: true, labels: { team: 'pay' } },
      { name: 'payment-api', active: true, labels: { team: 'pay' } },
      {
        name: 'crm-prod',
        active: true,
        labels: { team: 'sales', 'kubernetes.io/metadata.name': 'x' }
      }
    )
    d.workloads.push({
      kind: 'deployments.apps',
      ns: 'monitoring',
      name: 'prom',
      labels: { team: 'sre' },
      ready: 1,
      desired: 1,
      status: '1/1 ready',
      tone: 'ok',
      pvcs: []
    })
    const prefix = groupNamespaces(d, 'prefix')
    expect(prefix.get('payment-core')).toBe('payment')
    expect(prefix.get('payment-api')).toBe('payment')
    expect(prefix.get('crm-prod')).toBe('Other')
    expect(prefix.get('kube-system')).toBe('System')

    const team = groupNamespaces(d, 'label:team')
    expect(team.get('payment-api')).toBe('pay')
    expect(team.get('crm-prod')).toBe('sales')
    expect(team.get('monitoring')).toBe('sre') // từ nhãn workload
    expect(team.get('shop')).toBe('Other')
    expect(team.get('kube-system')).toBe('System')
    expect(groupingKeys(d)).toEqual(['team', 'tier'])

    const layout = layoutMap(d, { hideSystem: false, grouping: 'label:team' })
    expect(layout.nodes.filter((n) => n.kind === 'region').map((n) => n.label)).toEqual([
      'pay',
      'sales',
      'sre',
      'Other',
      'System'
    ])
  })

  it('label selector kiểu kubectl', () => {
    expect(parseLabelSelector('  ')).toBeNull()
    expect(parseLabelSelector('tier=data, app!=x,env in (a, b),!canary,team')).toEqual({
      matchLabels: { tier: 'data' },
      matchExpressions: [
        { key: 'app', operator: 'NotIn', values: ['x'] },
        { key: 'env', operator: 'In', values: ['a', 'b'] },
        { key: 'canary', operator: 'DoesNotExist', values: [] },
        { key: 'team', operator: 'Exists', values: [] }
      ]
    })
    expect(parseLabelSelector('app.kubernetes.io/part-of==shop')).toEqual({
      matchLabels: { 'app.kubernetes.io/part-of': 'shop' },
      matchExpressions: []
    })
    expect(parseLabelSelector('a=b=c')).toHaveProperty('error')
  })

  it('lọc theo nhãn: giữ workload khớp cùng service / route / PVC / policy nối tới nó', () => {
    const sel = parseLabelSelector('app=db')
    if (!sel || 'error' in sel) throw new Error('selector')
    const f = filterMapData(data(), sel)
    expect(f.workloads.map((w) => w.name)).toEqual(['db'])
    expect(f.pods.map((p) => p.name)).toEqual(['db-0'])
    expect(f.services.map((s) => s.name)).toEqual(['db'])
    expect(f.routes).toEqual([])
    expect(f.pvcs.map((v) => v.name)).toEqual(['data-db-0'])
    expect(f.policies.map((p) => p.name)).toEqual(['deny-db'])
    expect(f.hpas).toEqual([])
    expect(f.namespaces.map((n) => n.name)).toEqual(['shop'])
    const layout = layoutMap(f, { hideSystem: false })
    expect(layout.nodes.filter((n) => n.kind === 'namespace').map((n) => n.label)).toEqual(['shop'])

    const api = parseLabelSelector('app=api')
    if (!api || 'error' in api) throw new Error('selector')
    expect(filterMapData(data(), api).routes.map((r) => r.name)).toEqual(['web'])
  })

  it('gập namespace: chỉ còn thẻ tóm tắt, không thẻ con, không cạnh', () => {
    const open = layoutMap(data(), { hideSystem: false })
    const folded = layoutMap(data(), { hideSystem: false, collapsed: (ns) => ns === 'shop' })
    const shop = folded.nodes.find((n) => n.id === 'n:shop')
    expect(shop).toMatchObject({ collapsed: true, stats: { workloads: 3, pods: 5 } })
    expect(folded.nodes.some((n) => n.ns === 'shop' && n.kind !== 'namespace')).toBe(false)
    expect(folded.edges).toHaveLength(0)
    expect(open.edges.length).toBeGreaterThan(0)
    // Đảo gập nhỏ hơn hẳn → bản đồ gọn hơn.
    const openShop = open.nodes.find((n) => n.id === 'n:shop')
    expect((shop?.h ?? 0) < (openShop?.h ?? 0)).toBe(true)
    // Namespace khác vẫn đầy đủ.
    expect(folded.nodes.some((n) => n.ns === 'monitoring' && n.kind === 'workload')).toBe(true)
  })

  it('làn dọc: route → service → workload → PVC thẳng một cột, không đè lên làn khác', () => {
    const layout = layoutMap(data(), { hideSystem: false })
    const at = (id: string): MapNode => {
      const n = layout.nodes.find((x) => x.id === id)
      if (!n) throw new Error(id)
      return n
    }
    const mid = (n: MapNode): number => n.x + n.w / 2
    const route = at('r:ingresses.networking.k8s.io:shop/web')
    const svc = at('s:shop/api')
    const api = at('w:deployments.apps:shop/api')
    expect(mid(route)).toBe(mid(api))
    expect(mid(svc)).toBe(mid(api))
    expect(route.y < svc.y && svc.y < api.y).toBe(true)
    const db = at('w:statefulsets.apps:shop/db')
    const pvc = at('v:shop/data-db-0')
    expect(mid(pvc)).toBe(mid(db))
    expect(pvc.y > db.y).toBe(true)
    // Làn khác cột với nhau.
    expect(mid(db)).not.toBe(mid(api))
  })

  it('nhãn nhìn xa: hiện trọn tên — một dòng nếu đủ chỗ, không thì hai dòng cân đối', () => {
    expect(splitLabel('cattle-impersonation-system', /[-.]/)).toEqual([
      'cattle-',
      'impersonation-system'
    ])
    expect(splitLabel('INGRESS & NETWORKING', /\s/)).toEqual(['INGRESS &', 'NETWORKING'])
    expect(splitLabel('default', /[-.]/)).toEqual(['default'])
    // Tên ngắn trên đảo rộng: một dòng, chạm trần.
    expect(fitLabel('shop', /[-.]/, 500, 0.6, 1.6, 40)).toEqual({ lines: ['shop'], size: 40 })
    // Tên dài trên đảo hẹp: hai dòng, chữ to hơn một dòng.
    const long = fitLabel('cattle-impersonation-system', /[-.]/, 258, 0.6, 1.6, 80)
    expect(long.lines).toHaveLength(2)
    expect(long.size).toBeGreaterThan(258 / (27 * 0.6 + 1.6))
  })
})
