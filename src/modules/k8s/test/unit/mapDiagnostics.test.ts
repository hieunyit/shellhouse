import { describe, expect, it } from 'vitest'
import { buildTopology } from '../../shared/appTopology'
import { diagnoseMap, ingressHostMatches } from '../../shared/mapDiagnostics'
import { mapKnown, type MapData } from '../../shared/map'
import {
  captureTopology,
  compareTopology,
  readSnapshots,
  writeSnapshots,
  SNAPSHOTS_KEY
} from '../../shared/topologySnapshots'

function data(): MapData {
  return {
    namespaces: [{ name: 'shop', active: true }],
    scope: ['shop'],
    coverage: [],
    nodes: { total: 0, ready: 0 },
    truncated: false,
    workloads: [
      {
        kind: 'deployments.apps',
        ns: 'shop',
        name: 'web',
        labels: { app: 'web' },
        images: ['nginx:1'],
        ready: 1,
        desired: 1,
        tone: 'ok',
        status: '1/1',
        pvcs: [],
        secrets: ['db']
      }
    ],
    pods: [
      {
        ns: 'shop',
        name: 'web-1',
        owner: { kind: 'Deployment', name: 'web' },
        status: 'Running',
        tone: 'ok',
        restarts: 0,
        node: 'node',
        labels: { app: 'web' },
        ports: [{ name: 'http', port: 8080 }],
        ready: true
      }
    ],
    services: [
      {
        ns: 'shop',
        name: 'web',
        type: 'ClusterIP',
        selector: { app: 'web' },
        ports: '80/TCP',
        portList: [{ port: 80, targetPort: 'http' }],
        endpoints: { ready: 1, notReady: 0 }
      }
    ],
    routes: [
      {
        kind: 'ingresses.networking.k8s.io',
        ns: 'shop',
        name: 'web',
        hosts: ['shop.example.com'],
        backends: ['web'],
        className: 'nginx',
        rules: [
          { host: 'shop.example.com', path: '/', pathType: 'Prefix', service: 'web', port: '80' }
        ],
        tls: [{ hosts: ['shop.example.com'], secret: 'tls' }]
      }
    ],
    ingressClasses: [{ name: 'nginx', default: true }],
    secrets: ['shop/tls'],
    tlsExpiry: { 'shop/tls': '2030-01-01T00:00:00Z' },
    pvcs: [],
    hpas: [],
    policies: [
      {
        ns: 'shop',
        name: 'web',
        selector: {},
        types: ['Ingress'],
        rules: { ingress: [{ from: [] }] }
      }
    ]
  }
}

describe('request path diagnosis', () => {
  it('follows URL through Ingress, Service, EndpointSlice and actual Pod declarations', () => {
    const result = diagnoseMap(
      data(),
      { kind: 'url', url: 'https://shop.example.com/api' },
      Date.parse('2026-10-27')
    )
    expect(result.some((s) => s.status === 'bad')).toBe(false)
    expect(result.find((s) => s.title === 'EndpointSlice')?.status).toBe('ok')
    expect(result.find((s) => s.title === 'Target port')?.refs[0]?.name).toBe('web-1')
    expect(result.at(-1)?.status).toBe('unknown')
    expect(result.find((s) => s.title === 'TLS')?.detail).toContain('handshake')
  })
  it('uses longest Prefix with segment boundaries and Exact precedence', () => {
    const d = data()
    const r = d.routes[0]
    if (!r) throw new Error('fixture')
    r.rules?.push({
      host: 'shop.example.com',
      path: '/api',
      pathType: 'Prefix',
      service: 'missing',
      port: '80'
    })
    expect(
      diagnoseMap(d, { kind: 'url', url: 'http://shop.example.com/apix' }).some(
        (s) => s.status === 'bad'
      )
    ).toBe(false)
    expect(
      diagnoseMap(d, { kind: 'url', url: 'http://shop.example.com/api/v1' }).find(
        (s) => s.title === 'Service'
      )?.status
    ).toBe('bad')
    r.rules?.push({
      host: 'shop.example.com',
      path: '/api',
      pathType: 'Exact',
      service: 'web',
      port: '80'
    })
    expect(
      diagnoseMap(d, { kind: 'url', url: 'http://shop.example.com/api' }).find(
        (s) => s.title === 'Service'
      )?.status
    ).toBe('ok')
  })
  it('handles wildcard hosts, ambiguous routes and implementation specific paths conservatively', () => {
    expect(ingressHostMatches('*.example.com', 'a.example.com')).toBe(true)
    expect(ingressHostMatches('*.example.com', 'a.b.example.com')).toBe(false)
    expect(ingressHostMatches('*.example.com', 'example.com')).toBe(false)
    const d = data()
    const r = d.routes[0]
    if (!r) throw new Error('fixture')
    d.routes.push({ ...r, name: 'other' })
    expect(
      diagnoseMap(d, { kind: 'url', url: 'http://shop.example.com' }).find(
        (s) => s.title === 'Route selection'
      )?.status
    ).toBe('unknown')
    r.rules = [
      { host: 'shop.example.com', path: '/', service: 'web', pathType: 'ImplementationSpecific' }
    ]
    expect(
      diagnoseMap(d, { kind: 'url', url: 'http://shop.example.com' }).find(
        (s) => s.title === 'Path matching'
      )?.status
    ).toBe('unknown')
  })
  it('does not turn denied, truncated or outside-scope lists into missing objects', () => {
    const d = data()
    d.services = []
    d.coverage = [{ kind: 'services', namespace: 'shop', reason: 'forbidden' }]
    expect(diagnoseMap(d, { kind: 'service', ns: 'shop', name: 'web' })[0]?.status).toBe('unknown')
    expect(mapKnown(d, 'services', 'other')).toBe(false)
    d.coverage = [{ kind: 'services', namespace: 'shop', reason: 'truncated' }]
    expect(diagnoseMap(d, { kind: 'service', ns: 'shop', name: 'web' })[0]?.status).toBe('unknown')
    d.coverage = []
    expect(diagnoseMap(d, { kind: 'service', ns: 'shop', name: 'web' })[0]?.status).toBe('bad')
  })
  it('distinguishes named port errors from undeclared numeric ports and checks readiness / expiry', () => {
    const d = data()
    const p = d.pods[0]
    const svc = d.services[0]
    if (!p || !svc) throw new Error('fixture')
    p.ports = []
    p.ready = false
    p.terminating = true
    expect(
      diagnoseMap(d, { kind: 'service', ns: 'shop', name: 'web' }).find(
        (s) => s.title === 'Target port'
      )?.status
    ).toBe('bad')
    svc.portList = [{ port: 80, targetPort: '8080' }]
    const result = diagnoseMap(d, { kind: 'service', ns: 'shop', name: 'web' })
    expect(result.find((s) => s.title === 'Target port')?.status).toBe('unknown')
    expect(result.find((s) => s.title === 'Pod readiness')?.status).toBe('bad')
    d.tlsExpiry = { 'shop/tls': '2020-01-01T00:00:00Z' }
    expect(
      diagnoseMap(d, { kind: 'url', url: 'https://shop.example.com' }).find(
        (s) => s.title === 'TLS'
      )?.status
    ).toBe('bad')
  })
  it('rejects invalid URLs and does not claim unmatched host is broken cluster-wide', () => {
    expect(diagnoseMap(data(), { kind: 'url', url: 'javascript:alert(1)' })[0]?.status).toBe('bad')
    expect(
      diagnoseMap(data(), { kind: 'url', url: 'https://elsewhere.example.com' })[0]?.status
    ).toBe('unknown')
  })
})

describe('topology snapshot comparison', () => {
  it('detects images, selectors, ports, policy rules and dependencies; ignores runtime health', () => {
    const d = data()
    const before = captureTopology(d, 'cluster', 'before', 1000)
    const w = d.workloads[0]
    const svc = d.services[0]
    const policy = d.policies[0]
    if (!w || !svc || !policy) throw new Error('fixture')
    w.ready = 0
    w.status = '0/1'
    w.tone = 'bad'
    d.pods = []
    expect(compareTopology(before, captureTopology(d, 'cluster', 'status'))).toEqual([])
    w.images = ['nginx:2']
    w.secrets = ['db2']
    svc.selector = { app: 'new' }
    svc.portList = [{ port: 81, targetPort: '8081' }]
    policy.rules = { ingress: [] }
    const changes = compareTopology(before, captureTopology(d, 'cluster', 'after'))
    expect(changes.flatMap((c) => c.fields.map((f) => f.field)).sort()).toEqual([
      'dependencies',
      'images',
      'ports',
      'rules',
      'selector'
    ])
    expect(changes.every((c) => c.type === 'changed')).toBe(true)
    expect(JSON.stringify(before)).not.toContain('data:')
  })
  it('reports real adds/removals but marks incomplete reads as unknown in both directions', () => {
    const d = data()
    const before = captureTopology(d, 'cluster', 'before')
    d.services = []
    expect(
      compareTopology(before, captureTopology(d, 'cluster', 'after')).find(
        (c) => c.resource.kind === 'services'
      )?.type
    ).toBe('removed')
    d.coverage = [{ kind: 'services', namespace: 'shop', reason: 'forbidden' }]
    const partial = captureTopology(d, 'cluster', 'partial')
    expect(compareTopology(before, partial).find((c) => c.resource.kind === 'services')?.type).toBe(
      'unknown'
    )
    expect(compareTopology(partial, before).find((c) => c.resource.kind === 'services')?.type).toBe(
      'unknown'
    )
  })
  it('rejects cluster/scope mismatch and corrupted local history, propagates quota errors', () => {
    const d = data()
    const before = captureTopology(d, 'cluster', 'before')
    expect(() => compareTopology(before, captureTopology(d, 'different', 'after'))).toThrow(
      /same cluster/
    )
    d.scope = []
    expect(() => compareTopology(before, captureTopology(d, 'cluster', 'after'))).toThrow(/scope/)
    expect(() => readSnapshots({ getItem: () => '[{"version":1}]' })).toThrow(/invalid/)
    const storage = new Map<string, string>()
    writeSnapshots(
      {
        setItem: (k, v) => {
          storage.set(k, v)
        }
      },
      [before]
    )
    expect(readSnapshots({ getItem: (k) => storage.get(k) ?? null })).toEqual([before])
    expect(storage.has(SNAPSHOTS_KEY)).toBe(true)
    expect(() => {
      writeSnapshots(
        {
          setItem: () => {
            throw new Error('quota')
          }
        },
        [before]
      )
    }).toThrow('quota')
  })
})

it('snapshot comparison preserves array order and detects container image swaps', () => {
  const d = data()
  const w = d.workloads[0]
  if (!w) throw new Error('fixture')
  w.images = ['app:v1', 'app:v2']
  const before = captureTopology(d, 'cluster', 'before')
  w.images = ['app:v2', 'app:v1']
  expect(
    compareTopology(before, captureTopology(d, 'cluster', 'after')).flatMap((c) =>
      c.fields.map((f) => f.field)
    )
  ).toContain('images')
})

it('application map uses live selected Pods during a rollout instead of only the new template', () => {
  const d = data()
  const w = d.workloads[0]
  if (!w) throw new Error('fixture')
  w.labels = { app: 'web-new' }
  w.ports = []
  const graph = buildTopology(d, {
    hideSystem: false,
    showDeps: false,
    expanded: new Set(),
    collapsed: () => false,
    showAll: new Set()
  })
  expect(
    graph.problems.filter((p) =>
      ['svc-no-match', 'svc-no-ready', 'svc-target-port'].includes(p.problem.code)
    )
  ).toEqual([])
})

it('Gateway API routes keep the backend namespace instead of selecting a same-named local Service', () => {
  const d = data()
  const local = d.services[0]
  if (!local) throw new Error('fixture')
  d.scope = ['shop', 'backend']
  d.namespaces.push({ name: 'backend', active: true })
  d.services.push({ ...local, ns: 'backend' })
  d.routes = [
    {
      kind: 'httproutes.gateway.networking.k8s.io',
      ns: 'shop',
      name: 'route',
      hosts: ['shop.example.com'],
      backends: ['backend/web'],
      rules: [
        {
          host: 'shop.example.com',
          path: '/',
          service: 'web',
          namespace: 'backend',
          port: '80',
          weight: 100
        }
      ]
    }
  ]
  const options = {
    hideSystem: false,
    showDeps: false,
    expanded: new Set<string>(),
    collapsed: () => false,
    showAll: new Set<string>()
  }
  let graph = buildTopology(d, options)
  const from = 'rt:httproutes.gateway.networking.k8s.io:shop/route'
  expect(graph.edges.some((e) => e.from === from && e.to === 'svc:backend/web')).toBe(true)
  expect(graph.edges.some((e) => e.from === from && e.to === 'svc:shop/web')).toBe(false)
  d.services = [local]
  graph = buildTopology(d, options)
  expect(
    graph.problems.some(
      (p) => p.problem.code === 'route-missing-svc' && p.problem.text.includes('backend/web')
    )
  ).toBe(true)
  d.scope = ['shop']
  d.namespaces = [{ name: 'shop', active: true }]
  graph = buildTopology(d, options)
  expect(graph.problems.some((p) => p.problem.code === 'route-missing-svc')).toBe(false)
})
