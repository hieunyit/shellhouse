import { describe, expect, it } from 'vitest'
import { detectTech, impactOf, layoutMap, type MapData } from '../../shared/map'
import type { TopologyResult } from '../../shared/ops'
import { rbacRisk, securityFindings } from '../../shared/security'
import {
  dependentsOf,
  filterTopology,
  layoutTopology,
  mergeTopology,
  TOPO_NODE_H,
  TOPO_NODE_W
} from '../../shared/topology'

const n = (kind: string, name: string, extra: object = {}) => ({
  id: `${kind}|shop|${name}`,
  kind,
  kindLabel: kind,
  name,
  namespace: 'shop',
  summary: '',
  tone: 'ok' as const,
  ...extra
})
const id = (kind: string, name: string): string => `${kind}|shop|${name}`

/** Ingress → Service → Deployment → RS → 2 pod → node; Deployment → ConfigMap, SA → binding → role. */
const GRAPH: TopologyResult = {
  root: id('deployments.apps', 'web'),
  nodes: [
    n('ingresses.networking.k8s.io', 'web'),
    n('services', 'web'),
    n('deployments.apps', 'web'),
    n('replicasets.apps', 'web-1'),
    n('pods', 'web-1-a'),
    n('pods', 'web-1-b'),
    n('nodes', 'node-1'),
    n('configmaps', 'cfg'),
    n('serviceaccounts', 'sa'),
    n('rolebindings.rbac.authorization.k8s.io', 'rb'),
    n('roles.rbac.authorization.k8s.io', 'role'),
    n('horizontalpodautoscalers.autoscaling', 'web')
  ],
  edges: [
    { from: id('ingresses.networking.k8s.io', 'web'), to: id('services', 'web'), type: 'routes' },
    { from: id('services', 'web'), to: id('deployments.apps', 'web'), type: 'selects' },
    { from: id('deployments.apps', 'web'), to: id('replicasets.apps', 'web-1'), type: 'owns' },
    { from: id('replicasets.apps', 'web-1'), to: id('pods', 'web-1-a'), type: 'owns' },
    { from: id('replicasets.apps', 'web-1'), to: id('pods', 'web-1-b'), type: 'owns' },
    { from: id('pods', 'web-1-a'), to: id('nodes', 'node-1'), type: 'runs-on' },
    { from: id('pods', 'web-1-b'), to: id('nodes', 'node-1'), type: 'runs-on' },
    { from: id('deployments.apps', 'web'), to: id('configmaps', 'cfg'), type: 'uses' },
    { from: id('deployments.apps', 'web'), to: id('serviceaccounts', 'sa'), type: 'identity' },
    {
      from: id('serviceaccounts', 'sa'),
      to: id('rolebindings.rbac.authorization.k8s.io', 'rb'),
      type: 'subject'
    },
    {
      from: id('rolebindings.rbac.authorization.k8s.io', 'rb'),
      to: id('roles.rbac.authorization.k8s.io', 'role'),
      type: 'grants'
    },
    {
      from: id('horizontalpodautoscalers.autoscaling', 'web'),
      to: id('deployments.apps', 'web'),
      type: 'scales'
    }
  ],
  notes: []
}

describe('Object Topology — bố cục, lọc, mở rộng, blast radius', () => {
  it('cột theo vai trò: traffic trái → workload → pod → node / phụ thuộc → RBAC; không chồng nhau', () => {
    const l = layoutTopology(GRAPH.nodes, GRAPH.edges)
    const x = (kind: string, name: string): number =>
      l.nodes.find((p) => p.id === id(kind, name))?.x ?? -1
    expect(x('ingresses.networking.k8s.io', 'web')).toBeLessThan(x('services', 'web'))
    expect(x('services', 'web')).toBeLessThan(x('deployments.apps', 'web'))
    expect(x('deployments.apps', 'web')).toBeLessThan(x('replicasets.apps', 'web-1'))
    expect(x('replicasets.apps', 'web-1')).toBeLessThan(x('pods', 'web-1-a'))
    expect(x('pods', 'web-1-a')).toBeLessThan(x('nodes', 'node-1'))
    expect(x('serviceaccounts', 'sa')).toBeLessThan(
      x('rolebindings.rbac.authorization.k8s.io', 'rb')
    )
    expect(x('rolebindings.rbac.authorization.k8s.io', 'rb')).toBeLessThan(
      x('roles.rbac.authorization.k8s.io', 'role')
    )
    // Không ô nào đè ô nào.
    for (const a of l.nodes)
      for (const b of l.nodes)
        if (a !== b)
          expect(
            a.x + TOPO_NODE_W <= b.x ||
              b.x + TOPO_NODE_W <= a.x ||
              a.y + TOPO_NODE_H <= b.y ||
              b.y + TOPO_NODE_H <= a.y
          ).toBe(true)
    // Cùng dữ liệu → cùng toạ độ.
    expect(layoutTopology(GRAPH.nodes, GRAPH.edges)).toEqual(l)
  })

  it('hướng trên → dưới (khung hẹp): cấp thành hàng, mỗi cấp sâu hơn nằm thấp hơn', () => {
    const l = layoutTopology(GRAPH.nodes, GRAPH.edges, 'tb')
    expect(l.direction).toBe('tb')
    const y = (kind: string, name: string): number =>
      l.nodes.find((p) => p.id === id(kind, name))?.y ?? -1
    expect(y('services', 'web')).toBeLessThan(y('deployments.apps', 'web'))
    expect(y('deployments.apps', 'web')).toBeLessThan(y('pods', 'web-1-a'))
    expect(y('pods', 'web-1-a')).toBe(y('pods', 'web-1-b'))
    // Đồ thị sâu → bố cục dọc hẹp hơn, cao hơn bố cục ngang.
    const lr = layoutTopology(GRAPH.nodes, GRAPH.edges, 'lr')
    expect(l.width).toBeLessThan(lr.width)
    expect(l.height).toBeGreaterThan(lr.height)
  })

  it('lọc nhóm quan hệ: tắt RBAC → bỏ cả nhánh SA / binding / role; mở rộng gộp không trùng', () => {
    const f = filterTopology(GRAPH, new Set(['rbac']))
    expect(f.nodes.map((x) => x.name)).not.toContain('role')
    expect(f.nodes.map((x) => x.name)).not.toContain('sa')
    expect(f.edges.some((e) => e.type === 'identity')).toBe(false)
    const extra: TopologyResult = {
      root: id('configmaps', 'cfg'),
      nodes: [n('configmaps', 'cfg'), n('deployments.apps', 'other')],
      edges: [
        { from: id('deployments.apps', 'other'), to: id('configmaps', 'cfg'), type: 'uses' },
        { from: id('deployments.apps', 'web'), to: id('configmaps', 'cfg'), type: 'uses' }
      ],
      notes: ['x']
    }
    const m = mergeTopology(GRAPH, extra)
    expect(m.root).toBe(GRAPH.root)
    expect(m.nodes).toHaveLength(GRAPH.nodes.length + 1)
    expect(m.edges).toHaveLength(GRAPH.edges.length + 1)
    expect(m.notes).toEqual(['x'])
  })

  it('blast radius: ConfigMap → workload + pod + service + ingress; Role → binding → SA → workload…', () => {
    const names = (s: Set<string>): string[] => [...s].map((x) => x.split('|')[2] ?? '').sort()
    expect(names(dependentsOf(GRAPH, id('configmaps', 'cfg')))).toEqual(
      ['web', 'web', 'web', 'web-1', 'web-1-a', 'web-1-b'].sort()
    )
    // Node hỏng → pod trên nó (và service chọn pod — không có ở đây).
    expect(names(dependentsOf(GRAPH, id('nodes', 'node-1')))).toEqual(['web-1-a', 'web-1-b'])
    // Role đổi → binding → SA → deployment → pod / service / ingress.
    const role = dependentsOf(GRAPH, id('roles.rbac.authorization.k8s.io', 'role'))
    expect(role.has(id('serviceaccounts', 'sa'))).toBe(true)
    expect(role.has(id('pods', 'web-1-a'))).toBe(true)
    expect(role.has(id('ingresses.networking.k8s.io', 'web'))).toBe(true)
    // HPA điều khiển deployment; deployment đổi không làm HPA đổi.
    expect(
      dependentsOf(GRAPH, id('deployments.apps', 'web')).has(
        id('horizontalpodautoscalers.autoscaling', 'web')
      )
    ).toBe(false)
    expect(
      dependentsOf(GRAPH, id('horizontalpodautoscalers.autoscaling', 'web')).has(
        id('pods', 'web-1-a')
      )
    ).toBe(true)
  })
})

describe('Bảo mật — pod template và RBAC', () => {
  it('phát hiện privileged, host network / path, root, :latest, thiếu limit; sắp theo mức độ', () => {
    const f = securityFindings({
      hostNetwork: true,
      volumes: [{ name: 'sock', hostPath: { path: '/var/run/docker.sock' } }],
      containers: [
        {
          name: 'app',
          image: 'registry.example.com/team/app:latest',
          securityContext: { privileged: true, runAsUser: 0, capabilities: { add: ['NET_ADMIN'] } }
        }
      ]
    })
    const ids = f.map((x) => `${x.severity}:${x.id}`)
    expect(ids).toEqual(
      expect.arrayContaining([
        'high:host-network',
        'high:host-path',
        'high:privileged',
        'high:capabilities',
        'medium:root',
        'medium:latest-tag',
        'medium:no-memory-limit',
        'low:sa-token'
      ])
    )
    const rank = { high: 0, medium: 1, low: 2 }
    expect(f.map((x) => rank[x.severity])).toEqual([...f.map((x) => rank[x.severity])].sort())

    // Pod cứng cáp: chỉ còn gợi ý nhẹ (không có).
    const hardened = securityFindings({
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true },
      containers: [
        {
          name: 'app',
          image: 'app@sha256:abc',
          readinessProbe: {},
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true },
          resources: { requests: { cpu: '100m' }, limits: { memory: '128Mi' } }
        }
      ]
    })
    expect(hardened).toEqual([])
  })

  it('mức rủi ro RBAC', () => {
    expect(rbacRisk('*', ['*']).risk).toBe('high')
    expect(rbacRisk('secrets', ['get']).risk).toBe('high')
    expect(rbacRisk('pods/exec', ['create']).risk).toBe('high')
    expect(rbacRisk('rolebindings.rbac.authorization.k8s.io', ['bind']).risk).toBe('high')
    expect(rbacRisk('deployments.apps', ['patch']).risk).toBe('medium')
    expect(rbacRisk('configmaps', ['update']).risk).toBe('medium')
    expect(rbacRisk('pods', ['get', 'list', 'watch']).risk).toBe('low')
  })
})

describe('Map — công nghệ, gateway, policy, blast radius', () => {
  it('nhận diện công nghệ theo image / nhãn / tên (cụ thể trước chung)', () => {
    expect(detectTech(['quay.io/prometheus/alertmanager:v0.27.0'], {}, 'x')).toBe('alertmanager')
    expect(detectTech(['docker.io/grafana/loki:2.9.1'], {}, 'loki')).toBe('loki')
    expect(detectTech(['grafana/grafana:11.0.0'], {}, 'grafana')).toBe('grafana')
    expect(detectTech(['registry.k8s.io/ingress-nginx/controller:v1.11.0'], {}, 'c')).toBe(
      'ingress-nginx'
    )
    expect(detectTech(['registry.k8s.io/coredns/coredns:v1.11.1'], {}, 'coredns')).toBe('coredns')
    expect(detectTech(['quay.io/argoproj/argocd:v2.12.0'], {}, 'argocd-server')).toBe('argocd')
    expect(detectTech(['bitnami/postgresql:16'], {}, 'db')).toBe('postgres')
    expect(detectTech(['myco/api:1.0'], { 'app.kubernetes.io/name': 'redis' }, 'cache')).toBe(
      'redis'
    )
    expect(detectTech(['myco/api:1.0'], {}, 'api')).toBeUndefined()
  })

  it('gateway → route (khác namespace), policy → workload, blast radius của PVC / gateway', () => {
    const data: MapData = {
      namespaces: [
        { name: 'shop', active: true },
        { name: 'gw', active: true }
      ],
      workloads: [
        {
          kind: 'deployments.apps',
          ns: 'shop',
          name: 'api',
          labels: { app: 'api' },
          ready: 1,
          desired: 1,
          status: '1/1 ready',
          tone: 'ok',
          pvcs: ['data'],
          tech: 'postgres',
          helm: true
        }
      ],
      pods: [
        {
          ns: 'shop',
          name: 'api-1',
          owner: { kind: 'Deployment', name: 'api' },
          status: 'Running',
          tone: 'ok',
          restarts: 0,
          node: 'n1'
        }
      ],
      services: [
        { ns: 'shop', name: 'api', type: 'ClusterIP', selector: { app: 'api' }, ports: '' }
      ],
      routes: [
        {
          kind: 'httproutes.gateway.networking.k8s.io',
          ns: 'shop',
          name: 'api',
          hosts: [],
          backends: ['api'],
          parents: [{ ns: 'gw', name: 'public' }]
        }
      ],
      pvcs: [{ ns: 'shop', name: 'data', status: 'Bound', capacity: '1Gi', tone: 'ok' }],
      hpas: [],
      policies: [{ ns: 'shop', name: 'deny', selector: {} }],
      gateways: [{ ns: 'gw', name: 'public', className: 'nginx', listeners: 'HTTP:80' }],
      nodes: { total: 1, ready: 1 },
      truncated: false
    }
    const l = layoutMap(data, { hideSystem: false })
    const e = l.edges.map((x) => `${x.kind}:${x.from}>${x.to}`)
    expect(e).toContain('attach:gw:gw/public>r:httproutes.gateway.networking.k8s.io:shop/api')
    expect(e).toContain('policy:w:deployments.apps:shop/api>np:shop/deny')
    const card = l.nodes.find((x) => x.id === 'w:deployments.apps:shop/api')
    expect(card).toMatchObject({ tech: 'postgres', badges: ['Helm', '1 policy'] })
    expect(l.nodes.find((x) => x.id === 'n:shop')?.techs).toEqual(['postgres'])
    // PVC hỏng → workload, pod, service, route (gateway không phụ thuộc route).
    expect([...impactOf(l, 'v:shop/data')].sort()).toEqual(
      [
        'w:deployments.apps:shop/api',
        'p:shop/api-1',
        's:shop/api',
        'r:httproutes.gateway.networking.k8s.io:shop/api'
      ].sort()
    )
    // Gateway đổi → route gắn vào nó.
    expect([...impactOf(l, 'gw:gw/public')]).toEqual([
      'r:httproutes.gateway.networking.k8s.io:shop/api'
    ])
  })
})
