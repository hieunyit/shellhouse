import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '@shared/i18n'
import {
  buildTopology,
  layoutTopology,
  planBlocks,
  pathThrough,
  routeChannels,
  topoStructureKey,
  MAX_ROWS_PER_NS,
  type TopoGraph,
  type TopoNode,
  type TopoOptions
} from '../../shared/appTopology'
import { buildConnections } from '../../shared/connections'
import { egressRows, type EgressItem } from '../../shared/egress'
import type { TrafficPeer, TrafficRate } from '../../shared/traffic'
import type { MapData, MapPod, MapWorkload } from '../../shared/map'

afterEach(() => {
  setLanguage('en')
})

const pod = (name: string, owner: MapPod['owner'], over: Partial<MapPod> = {}): MapPod => ({
  ns: 'shop',
  name,
  owner,
  status: 'Running',
  tone: 'ok',
  restarts: 0,
  node: 'n1',
  ...over
})

const workload = (over: Partial<MapWorkload> & { name: string }): MapWorkload => ({
  kind: 'deployments.apps',
  ns: 'shop',
  labels: { app: over.name },
  ready: 1,
  desired: 1,
  status: '1/1 ready',
  tone: 'ok',
  pvcs: [],
  ...over
})

function data(): MapData {
  return {
    namespaces: [
      { name: 'shop', active: true },
      { name: 'kube-system', active: true }
    ],
    workloads: [
      workload({
        name: 'web',
        ready: 1,
        desired: 2,
        tone: 'warn',
        ports: [{ name: 'http', port: 8080 }],
        configMaps: ['web-config'],
        secrets: ['db-password']
      }),
      workload({ name: 'api', ready: 2, desired: 2, ports: [{ name: 'grpc', port: 8080 }] }),
      workload({
        kind: 'statefulsets.apps',
        name: 'db',
        pvcs: ['data-db-0'],
        ports: [{ name: 'pg', port: 5432 }]
      }),
      workload({ name: 'worker' }),
      workload({ kind: 'deployments.apps', ns: 'kube-system', name: 'coredns' })
    ],
    pods: [
      pod('web-1', { kind: 'Deployment', name: 'web' }),
      pod(
        'web-2',
        { kind: 'Deployment', name: 'web' },
        { status: 'CrashLoopBackOff', tone: 'bad', restarts: 7 }
      ),
      pod('api-1', { kind: 'Deployment', name: 'api' }),
      pod('api-2', { kind: 'Deployment', name: 'api' }, { tone: 'warn', notReady: true }),
      pod('db-0', { kind: 'StatefulSet', name: 'db' }, { status: 'Pending', tone: 'warn' }),
      pod('worker-1', { kind: 'Deployment', name: 'worker' }),
      // Pod lẻ và pod của ReplicaSet không có Deployment: vào nhóm "Standalone pods".
      pod('debug', null, { labels: { app: 'debug' } }),
      pod('lonely-x', { kind: 'ReplicaSet', name: 'lonely' }, { labels: { app: 'lonely' } }),
      pod('coredns-1', { kind: 'Deployment', name: 'coredns' }, { ns: 'kube-system' })
    ],
    services: [
      {
        ns: 'shop',
        name: 'web',
        type: 'ClusterIP',
        selector: { app: 'web' },
        ports: '80/TCP',
        portList: [{ port: 80, targetPort: 'http' }],
        endpoints: { ready: 1, notReady: 1 }
      },
      {
        ns: 'shop',
        name: 'api',
        type: 'ClusterIP',
        selector: { app: 'api' },
        ports: '80/TCP',
        portList: [
          { port: 80, targetPort: '9090' },
          { port: 81, targetPort: 'metrics' }
        ]
      },
      {
        ns: 'shop',
        name: 'db',
        type: 'ClusterIP',
        clusterIP: 'None',
        selector: { app: 'db' },
        ports: '5432/TCP',
        portList: [{ port: 5432, targetPort: '5432' }],
        endpoints: { ready: 0, notReady: 1 }
      },
      {
        ns: 'shop',
        name: 'orphan',
        type: 'ClusterIP',
        selector: { app: 'nothing' },
        ports: '80/TCP',
        portList: [{ port: 80, targetPort: '80' }]
      },
      {
        ns: 'shop',
        name: 'payments',
        type: 'ExternalName',
        externalName: 'pay.example.com',
        selector: {},
        ports: ''
      },
      {
        ns: 'shop',
        name: 'edge',
        type: 'LoadBalancer',
        selector: { app: 'web' },
        ports: '443/TCP',
        portList: [{ port: 443, targetPort: 'http', nodePort: 30443 }]
      },
      {
        ns: 'shop',
        name: 'debug',
        type: 'ClusterIP',
        selector: { app: 'debug' },
        ports: '80/TCP',
        portList: [{ port: 80, targetPort: '80' }]
      }
    ],
    routes: [
      {
        kind: 'ingresses.networking.k8s.io',
        ns: 'shop',
        name: 'shop',
        hosts: ['shop.example.com'],
        backends: ['web', 'api', 'legacy'],
        className: 'nginx',
        rules: [
          { host: 'shop.example.com', path: '/', service: 'web', port: '80' },
          { host: 'shop.example.com', path: '/api', service: 'api', port: '8443' },
          { host: 'shop.example.com', path: '/old', service: 'legacy', port: '80' },
          { host: '', path: '', service: 'web', default: true }
        ],
        tls: [
          { hosts: ['shop.example.com'], secret: 'shop-tls' },
          { hosts: ['admin.example.com'], secret: 'admin-tls' }
        ]
      },
      {
        kind: 'httproutes.gateway.networking.k8s.io',
        ns: 'shop',
        name: 'api',
        hosts: ['api.example.com'],
        backends: ['api'],
        parents: [
          { ns: 'shop', name: 'public' },
          { ns: 'shop', name: 'gone' }
        ],
        rules: [{ host: 'api.example.com', path: '/v1', service: 'api' }]
      }
    ],
    gateways: [{ ns: 'shop', name: 'public', className: 'nginx', listeners: 'HTTP:80, HTTPS:443' }],
    pvcs: [{ ns: 'shop', name: 'data-db-0', status: 'Pending', capacity: '', tone: 'warn' }],
    hpas: [
      {
        ns: 'shop',
        name: 'api',
        target: { kind: 'Deployment', name: 'api' },
        min: 1,
        max: 2,
        current: 2
      }
    ],
    policies: [
      {
        ns: 'shop',
        name: 'db-deny',
        selector: { matchLabels: { app: 'db' } },
        types: ['Ingress'],
        ingressRules: 0,
        egressRules: 0
      },
      {
        ns: 'shop',
        name: 'web-allow',
        selector: { matchLabels: { app: 'web' } },
        types: ['Ingress'],
        ingressRules: 1,
        egressRules: 0
      }
    ],
    nodes: { total: 1, ready: 1 },
    truncated: false,
    configMaps: ['shop/web-config'],
    secrets: ['shop/shop-tls']
  }
}

const OPTS: TopoOptions = {
  hideSystem: true,
  showDeps: true,
  expanded: new Set(),
  collapsed: () => false,
  showAll: new Set()
}

const byId = (g: TopoGraph): Map<string, TopoNode> => new Map(g.nodes.map((n) => [n.id, n]))
const codes = (n: TopoNode | undefined): string[] => (n?.problems ?? []).map((p) => p.code)

describe('Topology tĩnh (Entry → Routes → Services → Workloads → Pods → Config)', () => {
  it('dựng làn và cạnh: luật Ingress từng dòng, LoadBalancer là lối vào, pod gộp theo workload', () => {
    const g = buildTopology(data(), OPTS)
    const n = byId(g)
    expect(n.get('ing:shop/shop')?.lane).toBe('entry')
    expect(n.get('rt:httproutes.gateway.networking.k8s.io:shop/api')?.lane).toBe('route')
    expect(n.get('gw:shop/public')?.lane).toBe('entry')
    expect(n.get('lb:shop/edge')).toMatchObject({ lane: 'entry', title: 'LoadBalancer' })
    // Namespace hệ thống ẩn.
    expect([...n.keys()].some((id) => id.includes('kube-system'))).toBe(false)
    const ids = g.edges.map((e) => e.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'ing:shop/shop#0>svc:shop/web',
        'ing:shop/shop#1>svc:shop/api',
        'ing:shop/shop#2>svc:shop/legacy',
        'ing:shop/shop#3>svc:shop/web',
        'gw:shop/public>rt:httproutes.gateway.networking.k8s.io:shop/api',
        'lb:shop/edge>svc:shop/edge',
        'svc:shop/edge>wl:deployments.apps:shop/web',
        'svc:shop/web>wl:deployments.apps:shop/web',
        'wl:deployments.apps:shop/web>pods:wl:deployments.apps:shop/web',
        'pods:wl:deployments.apps:shop/web>cm:shop/web-config',
        'pods:wl:deployments.apps:shop/web>sec:shop/db-password',
        'pods:wl:statefulsets.apps:shop/db>pvc:shop/data-db-0',
        'svc:shop/debug>wl:pods:shop/standalone'
      ])
    )
    // Dòng luật: host + path, mặc định ghi rõ.
    expect(n.get('ing:shop/shop')?.rows?.map((r) => r.text)).toEqual([
      'shop.example.com/',
      'shop.example.com/api',
      'shop.example.com/old',
      'default backend'
    ])
    // Pod lẻ + pod của ReplicaSet không có Deployment: không mất.
    const loose = n.get('pods:wl:pods:shop/standalone')
    expect(loose?.pods?.map((p) => p.name).sort()).toEqual(['debug', 'lonely-x'])
    // Pod lỗi đứng đầu nhóm.
    expect(n.get('pods:wl:deployments.apps:shop/web')?.pods?.[0]?.name).toBe('web-2')
  })

  it('IngressClass thiếu, host trùng, chứng chỉ sắp / đã hết hạn, PDB chặn drain; có gợi ý sửa', () => {
    const d = data()
    const now = Date.parse('2026-10-06T00:00:00Z')
    d.ingressClasses = [{ name: 'traefik', default: true }]
    d.routes.push({
      kind: 'ingresses.networking.k8s.io',
      ns: 'shop',
      name: 'shop-copy',
      hosts: ['shop.example.com'],
      backends: ['web'],
      // Không ghi lớp → lớp mặc định (traefik), không trùng với Ingress "shop" (nginx).
      rules: [{ host: 'shop.example.com', path: '/', service: 'web', port: '80' }]
    })
    d.routes.push({
      kind: 'ingresses.networking.k8s.io',
      ns: 'shop',
      name: 'shop-dup',
      hosts: ['shop.example.com'],
      backends: ['web'],
      className: 'traefik',
      rules: [{ host: 'shop.example.com', path: '/', service: 'web', port: '80' }]
    })
    d.tlsExpiry = {
      'shop/shop-tls': '2026-10-10T00:00:00Z',
      'shop/admin-tls': '2026-09-01T00:00:00Z'
    }
    d.pdbs = [
      {
        ns: 'shop',
        name: 'api-pdb',
        selector: { matchLabels: { app: 'api' } },
        allowed: 0,
        expected: 2,
        rule: 'minAvailable 2'
      },
      {
        ns: 'shop',
        name: 'db-pdb',
        selector: { matchLabels: { app: 'db' } },
        allowed: 1,
        expected: 1,
        rule: 'maxUnavailable 1'
      }
    ]
    const n = byId(buildTopology(d, { ...OPTS, now }))
    const ing = n.get('ing:shop/shop')
    expect(codes(ing)).toEqual(
      expect.arrayContaining(['ing-class-missing', 'ing-tls-expiring', 'ing-tls-expired'])
    )
    expect(ing?.problems.find((p) => p.code === 'ing-class-missing')?.fix).toContain('traefik')
    expect(ing?.problems.find((p) => p.code === 'ing-tls-expiring')?.text).toContain('4 days')
    expect(codes(n.get('ing:shop/shop-copy'))).toEqual(['ing-host-conflict'])
    expect(n.get('ing:shop/shop-copy')?.problems[0]?.text).toContain('shop-dup')
    expect(codes(n.get('ing:shop/shop-dup'))).toEqual(['ing-host-conflict'])
    expect(codes(n.get('wl:deployments.apps:shop/api'))).toContain('pdb-blocking')
    expect(codes(n.get('wl:statefulsets.apps:shop/db'))).not.toContain('pdb-blocking')
    // Mã chung có gợi ý sửa.
    expect(n.get('svc:shop/orphan')?.problems[0]?.fix).toContain('selector')
    // Không có IngressClass mặc định + Ingress không ghi lớp → cảnh báo.
    d.ingressClasses = [{ name: 'traefik', default: false }]
    const m = byId(buildTopology(d, { ...OPTS, now }))
    expect(codes(m.get('ing:shop/shop-copy'))).toContain('ing-no-class')
    // Không list được IngressClass / PDB / chứng chỉ → không kết luận gì.
    const plain = byId(buildTopology(data(), OPTS))
    expect(codes(plain.get('ing:shop/shop'))).not.toContain('ing-class-missing')
  })

  it('lưới tổng quan: namespace gập thành ô gom theo nhóm (đứng đầu), namespace mở xếp làn bên dưới', () => {
    const d = data()
    d.namespaces.push({ name: 'monitoring', active: true }, { name: 'payments', active: true })
    d.workloads.push(workload({ ns: 'monitoring', name: 'grafana' }))
    const groupOf = (ns: string): string =>
      ns === 'monitoring' ? 'Monitoring' : ns === 'kube-system' ? 'System' : 'Applications'
    const g = buildTopology(d, {
      ...OPTS,
      hideSystem: false,
      collapsed: (ns) => ns !== 'shop',
      groupOf
    })
    const l = layoutTopology(g, ['Applications', 'Monitoring', 'System'])
    const groups = l.bands.filter((b) => b.group !== undefined)
    expect(groups.map((b) => [b.group, b.count])).toEqual([
      ['Applications', 1],
      ['Monitoring', 1],
      ['System', 1]
    ])
    // Namespace mở (shop) nằm dưới mọi nhóm của lưới tổng quan.
    const shop = l.bands.find((b) => b.ns === 'shop')
    expect(shop?.collapsed).toBe(false)
    expect(Math.min(...groups.map((b) => b.y))).toBeLessThan(shop?.y ?? 0)
    expect(Math.max(...groups.map((b) => b.y + b.h))).toBeLessThan(shop?.y ?? 0)
    // Ô namespace: trong dải nhóm của nó, không đè nhau; số pod lỗi của shop đếm đúng.
    const tiles = l.nodes.filter((n) => n.kind === 'namespace')
    expect(tiles.map((n) => n.name).sort()).toEqual(['kube-system', 'monitoring', 'payments'])
    for (const tile of tiles) {
      const band = groups.find((b) => b.group === groupOf(tile.name))
      expect(band && tile.y >= band.y && tile.y + tile.h <= band.y + band.h).toBe(true)
    }
    expect(g.namespaces.find((n) => n.name === 'shop')?.stats.failingPods).toBe(1)
    // Gập hết: không làn nào, vẫn đủ rộng cho 4 ô một hàng.
    const all = layoutTopology(
      buildTopology(d, { ...OPTS, hideSystem: false, collapsed: () => true, groupOf }),
      ['Applications', 'Monitoring', 'System']
    )
    expect(all.columns).toEqual([])
    expect(all.width).toBeGreaterThanOrEqual(4 * 236)
  })

  it('chỉ ra lỗi cấu hình bằng lời', () => {
    const g = buildTopology(data(), OPTS)
    const n = byId(g)
    const ing = n.get('ing:shop/shop')
    expect(codes(ing)).toEqual(
      expect.arrayContaining(['ing-missing-svc', 'ing-missing-tls', 'ing-bad-port'])
    )
    expect(ing?.problems.find((p) => p.code === 'ing-missing-svc')?.text).toContain('legacy')
    expect(ing?.problems.find((p) => p.code === 'ing-missing-tls')?.text).toContain('admin-tls')
    expect(ing?.badges?.find((b) => b.text === 'TLS')?.tone).toBe('bad')
    // Service đích không tồn tại → thẻ "missing", cạnh đứt.
    expect(n.get('svc:shop/legacy')).toMatchObject({ missing: true, tone: 'bad' })
    expect(g.edges.find((e) => e.id === 'ing:shop/shop#2>svc:shop/legacy')?.broken).toBe(true)
    expect(codes(n.get('svc:shop/orphan'))).toEqual(['svc-no-match'])
    expect(n.get('svc:shop/orphan')?.problems[0]?.text).toContain('app=nothing')
    // targetPort tên không có trong workload → đỏ; số không khai báo → vàng.
    const api = n.get('svc:shop/api')
    expect(api?.problems.map((p) => [p.code, p.severity])).toEqual([
      ['svc-target-port', 'warn'],
      ['svc-target-port', 'bad']
    ])
    expect(api?.rows?.map((r) => r.tone)).toEqual(['warn', 'bad'])
    // Tên cổng → số thật.
    expect(n.get('svc:shop/web')?.rows?.[0]?.hint).toBe('→ http · 8080')
    expect(codes(n.get('svc:shop/web'))).toEqual([])
    // Có pod nhưng không endpoint nào sẵn sàng → đỏ.
    expect(codes(n.get('svc:shop/db'))).toEqual(['svc-no-ready'])
    expect(n.get('svc:shop/db')?.sub).toBe('Headless')
    expect(codes(n.get('svc:shop/payments'))).toEqual([])
    expect(codes(n.get('svc:shop/edge'))).toEqual(['svc-lb-pending'])
    // Workload: pod CrashLoop, chưa đủ ready, thiếu Secret; HPA ở mức tối đa; PVC Pending; bị cô lập.
    const web = n.get('wl:deployments.apps:shop/web')
    expect(codes(web)).toEqual(
      expect.arrayContaining(['wl-degraded', 'pod-crash', 'secret-missing'])
    )
    expect(web?.status).toBe('Only 1 of 2 pods ready')
    expect(web?.badges?.map((b) => b.text)).toContain('1 policy')
    expect(codes(n.get('wl:deployments.apps:shop/api'))).toEqual(
      expect.arrayContaining(['hpa-max', 'pod-not-ready'])
    )
    const db = n.get('wl:statefulsets.apps:shop/db')
    expect(codes(db)).toEqual(expect.arrayContaining(['pvc-unbound', 'pod-pending', 'np-isolated']))
    expect(db?.problems.find((p) => p.code === 'np-isolated')?.severity).toBe('warn')
    expect(db?.badges?.map((b) => b.text)).toContain('Isolated')
    // Route gắn vào Gateway không có.
    expect(codes(n.get('rt:httproutes.gateway.networking.k8s.io:shop/api'))).toEqual([
      'route-missing-gw'
    ])
    // Danh sách vấn đề: xấu trước.
    expect(g.problems[0]?.problem.severity).toBe('bad')
    expect(g.problems.some((p) => p.problem.code === 'secret-missing')).toBe(true)
  })

  it('không đủ quyền đọc Secret / ConfigMap → không kết luận "thiếu"', () => {
    const d = data()
    delete d.secrets
    delete d.configMaps
    const n = byId(buildTopology(d, OPTS))
    expect(codes(n.get('wl:deployments.apps:shop/web'))).not.toContain('secret-missing')
    expect(codes(n.get('ing:shop/shop'))).not.toContain('ing-missing-tls')
    expect(n.get('sec:shop/db-password')?.missing).toBeUndefined()
  })

  it('tiếng Việt: câu giải thích được dịch', () => {
    setLanguage('vi')
    const n = byId(buildTopology(data(), OPTS))
    expect(n.get('svc:shop/legacy')?.problems[0]?.text).not.toBe('This Service does not exist')
  })

  it('hàng: workload có lối vào trước, chạy nền sau; cùng dữ liệu → cùng bố cục, không chồng nhau', () => {
    const g = buildTopology(data(), OPTS)
    const n = byId(g)
    const row = (id: string): number => n.get(id)?.row ?? -1
    expect(row('wl:deployments.apps:shop/web')).toBeLessThan(row('wl:deployments.apps:shop/worker'))
    expect(row('wl:deployments.apps:shop/api')).toBeLessThan(row('wl:deployments.apps:shop/worker'))
    const a = layoutTopology(g)
    const b = layoutTopology(buildTopology(data(), OPTS))
    expect(b.nodes.map((x) => [x.id, x.x, x.y])).toEqual(a.nodes.map((x) => [x.id, x.x, x.y]))
    // Cột theo thứ tự làn — Route không có cột riêng (xếp dưới Gateway trong làn Entry).
    expect(a.columns.map((c) => c.lane)).toEqual(['entry', 'service', 'workload', 'pods', 'deps'])
    for (let i = 1; i < a.columns.length; i++)
      expect(a.columns[i]?.x ?? 0).toBeGreaterThan(
        (a.columns[i - 1]?.x ?? 0) + (a.columns[i - 1]?.w ?? 0)
      )
    // Không thẻ nào đè thẻ nào.
    for (const p of a.nodes)
      for (const q of a.nodes) {
        if (p === q) continue
        const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h
        expect(overlap, `${p.id} ∩ ${q.id}`).toBe(false)
      }
    // Mỗi thẻ nằm trong dải namespace của nó.
    for (const p of a.nodes) {
      const band = a.bands.find((x) => x.ns === p.ns)
      expect(band && p.y >= band.y && p.y + p.h <= band.y + band.h).toBe(true)
    }
    // Ingress một luật → Service → Deployment cùng hàng: đường thẳng (điểm nối cùng độ cao).
    const simple = data()
    simple.routes = [
      {
        kind: 'ingresses.networking.k8s.io',
        ns: 'shop',
        name: 'solo',
        hosts: ['a.example.com'],
        backends: ['web'],
        rules: [{ host: 'a.example.com', path: '/', service: 'web' }]
      }
    ]
    simple.services = simple.services.filter((x) => x.name === 'web')
    const sl = layoutTopology(buildTopology(simple, { ...OPTS, showDeps: false }))
    const at = (id: string) => {
      const x = sl.nodes.find((q) => q.id === id)
      if (!x) throw new Error(id)
      return x
    }
    const y = (id: string, off: number): number => at(id).y + at(id).h / 2 + off
    const e1 = sl.edges.find((x) => x.id === 'ing:shop/solo#0>svc:shop/web')
    const e2 = sl.edges.find((x) => x.id === 'svc:shop/web>wl:deployments.apps:shop/web')
    if (!e1 || !e2) throw new Error('edges')
    expect(Math.abs(y('ing:shop/solo', e1.sOff) - y('svc:shop/web', e1.tOff))).toBeLessThan(1)
    expect(
      Math.abs(y('svc:shop/web', e2.sOff) - y('wl:deployments.apps:shop/web', e2.tOff))
    ).toBeLessThan(1)
    // Khoá cấu trúc: đổi trạng thái pod (không đổi cấu trúc) → cùng khoá.
    const d = data()
    const p0 = d.pods[0]
    if (p0) p0.restarts = 99
    expect(topoStructureKey(buildTopology(d, OPTS))).toBe(topoStructureKey(g))
  })

  it('Route nằm ngay dưới Gateway của nó, thụt vào, nối kiểu cây; Entry → Pods gọn bề ngang', () => {
    const l = layoutTopology(buildTopology(data(), { ...OPTS, showDeps: false }))
    const at = (id: string) => {
      const x = l.nodes.find((q) => q.id === id)
      if (!x) throw new Error(id)
      return x
    }
    const gw = at('gw:shop/public')
    const rt = at('rt:httproutes.gateway.networking.k8s.io:shop/api')
    const entry = l.columns.find((c) => c.lane === 'entry')
    expect(gw.x).toBe(entry?.x)
    expect(rt.x).toBeGreaterThan(gw.x)
    expect(rt.x + rt.w).toBe(gw.x + gw.w)
    // Ngay dưới Gateway (không thẻ nào chen giữa).
    const between = l.nodes.filter(
      (q) => q.x <= gw.x + gw.w && q.x + q.w >= gw.x && q.y > gw.y && q.y < rt.y
    )
    expect(between).toEqual([])
    const attach = l.edges.find((e) => e.kind === 'attach' && e.to === rt.id)
    expect(attach?.tree).toEqual({ sw: gw.w, sh: gw.h, th: rt.h })
    // Cạnh sang làn khác không phải kiểu cây.
    expect(l.edges.filter((e) => e.kind !== 'attach').every((e) => !e.tree)).toBe(true)
    // Entry → Pods (không làn Config): lọt ~1150 px — zoom 0,8 trên khung ~950 px thấy trọn chuỗi.
    expect(l.width).toBeLessThanOrEqual(1160)
  })

  it('mở danh sách pod / ẩn làn Config & storage đổi cấu trúc', () => {
    const open = buildTopology(data(), {
      ...OPTS,
      showDeps: false,
      expanded: new Set(['wl:deployments.apps:shop/web'])
    })
    expect(open.nodes.some((x) => x.lane === 'deps')).toBe(false)
    const pods = open.nodes.find((x) => x.id === 'pods:wl:deployments.apps:shop/web')
    expect(pods?.expanded).toBe(true)
    const l = layoutTopology(open)
    expect(l.columns.map((c) => c.lane)).not.toContain('deps')
    expect(l.nodes.find((x) => x.id === pods?.id)?.h).toBeGreaterThan(86)
  })

  it('tập trung: chỉ đường đi qua mục chọn (lên tới lối vào, xuống tới pod / config)', () => {
    const g = buildTopology(data(), { ...OPTS, focus: 'svc:shop/web' })
    const ids = new Set(g.nodes.map((x) => x.id))
    expect(ids).toEqual(
      new Set([
        'svc:shop/web',
        'ing:shop/shop',
        'wl:deployments.apps:shop/web',
        'pods:wl:deployments.apps:shop/web',
        'cm:shop/web-config',
        'sec:shop/db-password'
      ])
    )
    // Không quay đầu: Ingress không kéo theo Service khác của nó.
    expect(
      pathThrough(
        [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'c' }
        ],
        'b'
      )
    ).toEqual(new Set(['a', 'b']))
  })

  it('namespace gập → một thẻ tóm tắt; namespace quá nhiều workload → cắt + "+N"', () => {
    const folded = buildTopology(data(), { ...OPTS, collapsed: () => true })
    expect(folded.nodes.map((x) => x.id)).toEqual(['ns:shop'])
    expect(folded.nodes[0]?.stats).toMatchObject({ workloads: 4, entries: 3 })
    expect(folded.namespaces[0]?.collapsed).toBe(true)
    expect(layoutTopology(folded).nodes[0]?.h).toBeGreaterThan(0)

    const d = data()
    for (let i = 0; i < 50; i++)
      d.workloads.push(workload({ name: `w${String(i).padStart(2, '0')}` }))
    const g = buildTopology(d, OPTS)
    const wl = g.nodes.filter((x) => x.kind === 'workload')
    expect(wl.length).toBe(MAX_ROWS_PER_NS)
    expect(g.nodes.find((x) => x.kind === 'more')?.more).toBe(55 - MAX_ROWS_PER_NS)
    // Workload công khai (có Ingress) không bị cắt.
    expect(wl.some((x) => x.name === 'web')).toBe(true)
    const all = buildTopology(d, { ...OPTS, showAll: new Set(['shop']) })
    expect(all.nodes.filter((x) => x.kind === 'workload').length).toBe(55)
    expect(all.nodes.some((x) => x.kind === 'more')).toBe(false)
  })

  it('cluster lớn: 3000 workload / 15000 pod dựng + xếp nhanh', () => {
    const d: MapData = {
      namespaces: [],
      workloads: [],
      pods: [],
      services: [],
      routes: [],
      pvcs: [],
      hpas: [],
      policies: [],
      nodes: { total: 0, ready: 0 },
      truncated: false
    }
    for (let n = 0; n < 60; n++) {
      const ns = `team-${String(n)}`
      d.namespaces.push({ name: ns, active: true })
      for (let i = 0; i < 50; i++) {
        const name = `svc-${String(i)}`
        d.workloads.push(workload({ ns, name, ready: 5, desired: 5 }))
        d.services.push({
          ns,
          name,
          type: 'ClusterIP',
          selector: { app: name },
          ports: '80/TCP',
          portList: [{ port: 80, targetPort: '8080' }]
        })
        for (let k = 0; k < 5; k++)
          d.pods.push(pod(`${name}-${String(k)}`, { kind: 'Deployment', name }, { ns }))
      }
      d.routes.push({
        kind: 'ingresses.networking.k8s.io',
        ns,
        name: 'edge',
        hosts: ['x.example.com'],
        backends: ['svc-0', 'svc-1'],
        rules: [
          { host: 'x.example.com', path: '/', service: 'svc-0' },
          { host: 'x.example.com', path: '/b', service: 'svc-1' }
        ]
      })
    }
    const t0 = performance.now()
    const g = buildTopology(d, OPTS)
    const l = layoutTopology(g)
    const ms = performance.now() - t0
    expect(l.nodes.length).toBeGreaterThan(1000)
    // Mỗi namespace cắt còn MAX_ROWS_PER_NS workload.
    expect(g.nodes.filter((x) => x.kind === 'workload').length).toBe(60 * MAX_ROWS_PER_NS)
    expect(ms).toBeLessThan(4000)
    // Gập hết: vài chục thẻ tóm tắt.
    const folded = buildTopology(d, { ...OPTS, collapsed: () => true })
    expect(layoutTopology(folded).nodes.length).toBe(60)
  })
})

describe('Định tuyến cạnh trực giao (mỗi cạnh một làn dọc)', () => {
  /** Giống cluster thật: 2 Ingress × 2 luật, luật của frontend trỏ chéo sang backend. */
  function crossData(): MapData {
    const ns = 'console-stg'
    const svc = (name: string, app: string): MapData['services'][number] => ({
      ns,
      name,
      type: 'ClusterIP',
      selector: { app },
      ports: '80/TCP',
      portList: [{ port: 80, targetPort: '8080' }]
    })
    return {
      namespaces: [{ name: ns, active: true }],
      workloads: [
        workload({ ns, name: 'console-backend' }),
        workload({ ns, name: 'console-frontend' })
      ],
      pods: [
        pod('console-backend-1', { kind: 'Deployment', name: 'console-backend' }, { ns }),
        pod('console-frontend-1', { kind: 'Deployment', name: 'console-frontend' }, { ns })
      ],
      services: [
        svc('console-backend-service', 'console-backend'),
        svc('console-frontend-service', 'console-frontend')
      ],
      routes: [
        {
          kind: 'ingresses.networking.k8s.io',
          ns,
          name: 'console-backend-ingress',
          hosts: ['api.stg.example.com', 'api2.stg.example.com'],
          backends: ['console-backend-service'],
          rules: [
            { host: 'api.stg.example.com', path: '/', service: 'console-backend-service' },
            { host: 'api2.stg.example.com', path: '/', service: 'console-backend-service' }
          ]
        },
        {
          kind: 'ingresses.networking.k8s.io',
          ns,
          name: 'console-frontend-ingress',
          hosts: ['console.stg.example.com'],
          backends: ['console-frontend-service', 'console-backend-service'],
          rules: [
            { host: 'console.stg.example.com', path: '/', service: 'console-frontend-service' },
            { host: 'console.stg.example.com', path: '/api', service: 'console-backend-service' }
          ]
        }
      ],
      gateways: [],
      pvcs: [],
      hpas: [],
      policies: [],
      nodes: { total: 1, ready: 1 },
      truncated: false,
      configMaps: [],
      secrets: []
    }
  }

  interface Seg {
    id: string
    to: string
    x: number
    lo: number
    hi: number
    sy: number
    ty: number
    tx: number
    sx: number
  }
  function verticals(l: ReturnType<typeof layoutTopology>): Seg[] {
    const at = new Map(l.nodes.map((n) => [n.id, n]))
    const out: Seg[] = []
    for (const e of l.edges) {
      const s = at.get(e.from)
      const t = at.get(e.to)
      if (!s || !t || e.tree) continue
      const sy = s.y + s.h / 2 + e.sOff
      const ty = t.y + t.h / 2 + e.tOff
      const sx = s.x + s.w
      out.push({
        id: e.id,
        to: e.to,
        x: sx + e.bend,
        lo: Math.min(sy, ty),
        hi: Math.max(sy, ty),
        sy,
        ty,
        sx,
        tx: t.x
      })
    }
    return out
  }

  it('2 Ingress × 2 luật chéo nhau: không hai cạnh khác đích chung một đoạn dọc, ít chỗ cắt', () => {
    const g = buildTopology(crossData(), { ...OPTS, showDeps: false })
    const l = layoutTopology(g)
    const segs = verticals(l).filter((v) => v.id.startsWith('ing:'))
    expect(segs.length).toBe(4)
    for (const a of segs)
      for (const b of segs) {
        if (a === b || a.to === b.to) continue
        const sameX = Math.abs(a.x - b.x) < 1
        const overlap = a.lo < b.hi && b.lo < a.hi && a.hi - a.lo > 0.5 && b.hi - b.lo > 0.5
        expect(sameX && overlap, `${a.id} | ${b.id}`).toBe(false)
      }
    // Mỗi cổng nguồn một điểm vào riêng ở đích (các đường chỉ gặp nhau ở thẻ).
    const into = new Map<string, Set<number>>()
    for (const v of segs) into.set(v.to, (into.get(v.to) ?? new Set()).add(Math.round(v.ty)))
    for (const v of segs.filter((x) => x.to === 'svc:console-stg/console-backend-service'))
      expect(v).toBeDefined()
    expect(into.get('svc:console-stg/console-backend-service')?.size).toBe(3)
    // Đoạn dọc nằm trong khe giữa hai cột (không đè lên thẻ).
    for (const v of segs) {
      expect(v.x).toBeGreaterThan(v.sx + 4)
      expect(v.x).toBeLessThan(v.tx - 4)
    }
    // Chỗ cắt: đoạn ngang của cạnh này đi qua đoạn dọc của cạnh kia. Với bố cục này tối đa 1.
    let crossings = 0
    for (const a of segs)
      for (const b of segs) {
        if (a === b) continue
        // Ngang đầu của a (sx → a.x, y = a.sy) cắt dọc của b?
        if (b.x < a.x && b.lo < a.sy && a.sy < b.hi) crossings++
        // Ngang cuối của a (a.x → tx, y = a.ty) cắt dọc của b?
        if (b.x > a.x && b.lo < a.ty && a.ty < b.hi) crossings++
      }
    expect(crossings).toBeLessThanOrEqual(1)
    // Tất định.
    expect(layoutTopology(buildTopology(crossData(), { ...OPTS, showDeps: false })).edges).toEqual(
      l.edges
    )
  })

  it('routeChannels: cạnh chung cổng nguồn đi ngược chiều được chung làn; cùng chiều thì tách', () => {
    const gaps = new Map([['entry' as const, { from: 0, to: 64 }]])
    const w = (id: string, sy: number, ty: number, sPort = id, tPort = id) => ({
      id,
      gap: 'entry' as const,
      sy,
      ty,
      sPort,
      tPort
    })
    const fork = routeChannels([w('up', 100, 40, 'p'), w('down', 100, 160, 'p')], gaps)
    expect(fork.get('up')).toBe(fork.get('down'))
    const same = routeChannels([w('a', 100, 140, 'p'), w('b', 100, 180, 'p')], gaps)
    expect(same.get('a')).not.toBe(same.get('b'))
    // Cạnh đi xa hơn nằm bên trái (rẽ trước) → đoạn ngang của cạnh gần không cắt nó.
    expect(same.get('b') ?? 0).toBeLessThan(same.get('a') ?? 0)
    // Hai cạnh không chồng (hàng khác) dùng lại làn — không bị đẩy lệch.
    const apart = routeChannels([w('a', 0, 40), w('b', 200, 240)], gaps)
    expect(apart.get('a')).toBe(apart.get('b'))
    for (const x of [...fork.values(), ...same.values()]) {
      expect(x).toBeGreaterThanOrEqual(12)
      expect(x).toBeLessThanOrEqual(50)
    }
  })
})

describe('Bản đồ: NodePort, PVC mồ côi, namespace lớn chia khối', () => {
  it('NodePort không vẽ thêm nút lối vào — thẻ Service ghi cổng node; LoadBalancer vẫn có', () => {
    const d = data()
    d.services.push({
      ns: 'shop',
      name: 'np',
      selector: { app: 'web' },
      type: 'NodePort',
      ports: '8000:31001/TCP',
      clusterIP: '10.0.0.9',
      portList: [{ port: 8000, targetPort: '8000', nodePort: 31001 }]
    })
    const n = byId(buildTopology(d, OPTS))
    expect(n.has('lb:shop/np')).toBe(false)
    expect(n.get('svc:shop/np')?.sub).toBe('NodePort :31001')
    expect(n.get('lb:shop/edge')).toMatchObject({ title: 'LoadBalancer' })
  })

  it('PVC Pending không workload nào dùng vẫn hiện (nút + vấn đề); PVC đang được dùng thì không nhân đôi', () => {
    const d = data()
    d.pvcs.push({ ns: 'shop', name: 'stuck', status: 'Pending', capacity: '', tone: 'warn' })
    const g = buildTopology(d, OPTS)
    const n = byId(g)
    expect(n.get('pvc:shop/stuck')).toMatchObject({ kind: 'pvc', tone: 'warn' })
    expect(codes(n.get('pvc:shop/stuck'))).toEqual(['pvc-unused'])
    expect(g.problems.some((p) => p.node === 'pvc:shop/stuck')).toBe(true)
    // `data-db-0` do StatefulSet db dùng → là phụ thuộc bình thường, không bị coi là mồ côi.
    expect(g.nodes.filter((x) => x.id === 'pvc:shop/data-db-0')).toHaveLength(1)
    expect(codes(n.get('pvc:shop/data-db-0'))).not.toContain('pvc-unused')
    // PVC Bound không workload dùng: không phải vấn đề.
    d.pvcs.push({ ns: 'shop', name: 'spare', status: 'Bound', capacity: '1Gi', tone: 'ok' })
    expect(byId(buildTopology(d, OPTS)).has('pvc:shop/spare')).toBe(false)
  })

  it('namespace nhiều workload chia khối cạnh nhau: không chồng thẻ, đủ làn, nằm trong bề rộng', () => {
    const d = data()
    for (let i = 0; i < 28; i++)
      d.workloads.push(workload({ name: `w${String(i).padStart(2, '0')}`, ports: [] }))
    const g = buildTopology(d, { ...OPTS, showAll: new Set(['shop']) })
    const l = layoutTopology(g)
    const lanes = new Set(l.columns.map((c) => c.lane)).size
    // Có ≥ 2 khối: tiêu đề làn lặp lại cho khối thứ hai.
    expect(l.columns.length).toBeGreaterThan(lanes)
    expect(Math.max(...l.nodes.map((x) => x.x + x.w))).toBeLessThanOrEqual(l.width)
    for (let i = 0; i < l.nodes.length; i++)
      for (let j = i + 1; j < l.nodes.length; j++) {
        const a = l.nodes[i]
        const b = l.nodes[j]
        if (!a || !b) continue
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
        expect(apart, `${a.id} ↔ ${b.id}`).toBe(true)
      }
    // Cạnh không bao giờ đi ngược từ khối này sang khối khác: mọi cạnh cùng khối.
    const at = new Map(l.nodes.map((x) => [x.id, x]))
    for (const e of l.edges) {
      const s = at.get(e.from)
      const t = at.get(e.to)
      if (s && t) expect(t.x + t.w).toBeGreaterThan(s.x)
    }
  })

  it('planBlocks: hàng nối nhau bằng cạnh luôn cùng khối; ít hàng thì một khối', () => {
    const mk = (id: string, row: number): TopoNode => ({
      id,
      kind: 'workload',
      lane: 'workload',
      ns: 'x',
      name: id,
      title: 'Deployment',
      sub: '',
      tone: 'ok',
      problems: [],
      row
    })
    const few = [mk('a', 0), mk('b', 1)]
    expect([...planBlocks(few, []).values()]).toEqual([0, 0])
    const many = Array.from({ length: 60 }, (_, i) => mk(`n${String(i)}`, i))
    const plan = planBlocks(many, [{ from: 'n0', to: 'n59' }])
    expect(new Set(plan.values()).size).toBeGreaterThan(1)
    expect(plan.get(0)).toBe(plan.get(59))
  })
})

describe('Làn Outbound — điểm đến khai báo trong cấu hình', () => {
  const web = { kind: 'deployments.apps', ns: 'shop', name: 'web' }
  const items: EgressItem[] = [
    { workload: web, source: 'env', via: '', key: 'DB_HOST', host: 'pg.prod.corp', port: 5432 },
    { workload: web, source: 'secret', via: 'db', key: 'url', host: 'pg.prod.corp', port: 5432 },
    { workload: web, source: 'env', via: '', key: 'API', host: 'api.stripe.com', port: 443 },
    // Service trong cluster (cùng namespace) và Service ExternalName.
    { workload: web, source: 'args', via: '', key: 'upstream', host: 'api', port: 80 },
    { workload: web, source: 'env', via: '', key: 'PAY', host: 'payments', port: 443 }
  ]
  const d = data()
  const rows = buildConnections({ declared: egressRows(items, d), observed: null })

  it('không truyền egress → không có làn / thẻ / cạnh Outbound', () => {
    const g = buildTopology(d, OPTS)
    expect(g.nodes.some((n) => n.kind === 'external')).toBe(false)
    expect(g.edges.some((e) => e.kind === 'calls')).toBe(false)
  })

  it('mỗi đích một thẻ (gộp nhiều nguồn / nhiều workload), cạnh từ nhóm pod', () => {
    const g = buildTopology(d, { ...OPTS, egress: rows })
    const ext = g.nodes.filter((n) => n.kind === 'external')
    expect(ext.map((n) => n.name).sort()).toEqual(
      ['api.stripe.com:443', 'pay.example.com:443', 'pg.prod.corp:5432', 'shop/api:80'].sort()
    )
    expect(ext.every((n) => n.lane === 'egress')).toBe(true)
    const pg = ext.find((n) => n.name === 'pg.prod.corp:5432')
    // Một workload gọi tới → dòng trong thẻ là NƠI KHAI BÁO (khoá), không lặp tên workload.
    expect(pg?.rows?.map((r) => `${r.text}:${r.hint}`)).toEqual(['DB_HOST:env', 'url:Secret'])
    expect(pg?.declared?.map((x) => x.workload)).toEqual(['web'])
    const calls = g.edges.filter((e) => e.kind === 'calls')
    expect(calls).toHaveLength(4)
    expect(calls.every((e) => e.from === 'pods:wl:deployments.apps:shop/web')).toBe(true)
    // ExternalName: đích thật là tên bên ngoài, nhớ Service đã dùng.
    const pay = ext.find((n) => n.name === 'pay.example.com:443')
    expect(pay?.dest?.kind).toBe('external')
    expect(pay?.sub).toContain('shop/payments')
  })

  it('bố cục: làn Outbound là cột cuối, bên phải Pods', () => {
    const g = buildTopology(d, { ...OPTS, egress: rows, showDeps: true })
    const l = layoutTopology(g)
    const lanes = l.columns.map((c) => c.lane)
    expect(lanes.at(-1)).toBe('egress')
    expect(lanes.indexOf('egress')).toBeGreaterThan(lanes.indexOf('pods'))
    const placed = l.nodes.filter((n) => n.kind === 'external')
    const col = l.columns.find((c) => c.lane === 'egress')
    expect(placed.every((n) => n.x >= (col?.x ?? 0))).toBe(true)
  })

  it('quá nhiều đích trong một namespace → gộp "+N more"', () => {
    const many: EgressItem[] = Array.from({ length: 40 }, (_, i) => ({
      workload: web,
      source: 'env' as const,
      via: '',
      key: `H${String(i)}`,
      host: `h${String(i)}.example.com`,
      port: 443
    }))
    const g = buildTopology(d, {
      ...OPTS,
      egress: buildConnections({ declared: egressRows(many, d), observed: null })
    })
    expect(g.nodes.filter((n) => n.kind === 'external')).toHaveLength(24)
    const more = g.nodes.find((n) => n.id === 'more-egress:shop')
    expect(more?.more).toBe(16)
  })

  it('tên chưa xác định không vẽ lên bản đồ; nhiều workload → mỗi workload một dòng', () => {
    const api = { kind: 'deployments.apps', ns: 'shop', name: 'api' }
    const items: EgressItem[] = [
      { workload: web, source: 'env', via: '', key: 'CACHE_HOST', host: 'nosuchsvc' },
      { workload: web, source: 'env', via: '', key: 'PAY', host: 'pay.example.com', port: 443 },
      {
        workload: api,
        source: 'configmap',
        via: 'cfg',
        key: 'PAY_URL',
        host: 'pay.example.com',
        port: 443
      }
    ]
    const g = buildTopology(d, {
      ...OPTS,
      egress: buildConnections({ declared: egressRows(items, d), observed: null })
    })
    const ext = g.nodes.filter((n) => n.kind === 'external')
    expect(ext.map((n) => n.name)).toEqual(['pay.example.com:443'])
    expect(ext[0]?.rows?.map((r) => `${r.text}:${r.hint}`).sort()).toEqual([
      'api:PAY_URL',
      'web:PAY'
    ])
    expect(ext[0]?.declared).toHaveLength(2)
  })

  it('ghép với traffic quan sát: trạng thái trên thẻ + cạnh, đích chỉ-quan-sát vẫn lên bản đồ', () => {
    const client: TrafficPeer = { kind: 'Deployment', ns: 'shop', name: 'web' }
    const ext = (name: string): TrafficPeer => ({ kind: 'external', ns: '', name })
    const observed: TrafficRate[] = [
      { client, server: ext('api.stripe.com'), port: '443', rate: 5000 },
      { client, server: ext('198.51.100.7'), port: '6379', rate: 12 }
    ]
    const items: EgressItem[] = [
      { workload: web, source: 'env', via: '', key: 'PAY', host: 'api.stripe.com', port: 443 },
      { workload: web, source: 'env', via: '', key: 'OLD', host: '203.0.113.99', port: 9042 }
    ]
    const conns = buildConnections({ declared: egressRows(items, d), observed })
    const g = buildTopology(d, { ...OPTS, egress: conns })
    const node = (name: string): TopoNode | undefined => g.nodes.find((n) => n.name === name)
    expect(node('api.stripe.com:443')?.conn).toMatchObject({ status: 'active', rate: 5000 })
    expect(node('203.0.113.99:9042')?.conn?.status).toBe('declared')
    // chỉ quan sát: không khai báo ở đâu → vẫn có thẻ, huy hiệu "Undeclared"
    const und = node('198.51.100.7:6379')
    expect(und?.conn?.status).toBe('undeclared')
    expect(und?.badges?.[0]?.text).toBe('Undeclared')
    expect(und?.rows?.[0]?.text).toBe('not declared')
    const edge = (label: string) => g.edges.find((e) => e.kind === 'calls' && e.to.endsWith(label))
    const stripeEdge = g.edges.find((e) => e.kind === 'calls' && e.status === 'active')
    expect(stripeEdge?.rate).toBe(5000)
    expect(edge('obs:198.51.100.7:6379')?.status).toBe('undeclared')
    // không có nguồn traffic → "chưa đo": không huy hiệu gây nhiễu
    const quiet = buildTopology(d, {
      ...OPTS,
      egress: buildConnections({ declared: egressRows(items, d), observed: null })
    })
    expect(quiet.nodes.find((n) => n.name === 'api.stripe.com:443')?.badges).toBeUndefined()
  })
})
