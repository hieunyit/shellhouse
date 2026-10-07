import { describe, expect, it } from 'vitest'
import {
  filterMapData,
  groupNamespaces,
  groupOrder,
  groupingKeys,
  parseLabelSelector,
  regionOf,
  selectorMatches,
  type MapData
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

    // Thứ tự nhóm của lưới tổng quan: theo tên, "Other" rồi "System" sau cùng.
    expect(groupOrder(team.values(), 'label:team')).toEqual([
      'pay',
      'sales',
      'sre',
      'Other',
      'System'
    ])
    expect(groupOrder(groupNamespaces(d, 'purpose').values(), 'purpose')).toEqual([
      'Applications',
      'Ingress & networking',
      'Monitoring',
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

    const api = parseLabelSelector('app=api')
    if (!api || 'error' in api) throw new Error('selector')
    expect(filterMapData(data(), api).routes.map((r) => r.name)).toEqual(['web'])
  })
})
