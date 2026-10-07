import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { LimitedSpawn } from '../../../registry/host-types'
import { buildTopology, layoutTopology, type TopoNode } from '../../shared/appTopology'
import type { MapData } from '../../shared/map'
import { K8sService, type ResolvedClusterConfig } from '../../session-host/service'
import { startApiTestServer, TEST_CA, TOKEN, type ApiTestServer } from '../api-test-server'

/**
 * Topology tĩnh đi trọn đường: API server giả (cluster mẫu) → Session Host (op "map") → đồ thị +
 * vấn đề + bố cục. Kiểm dữ liệu mới (cổng, EndpointSlice, luật Ingress, TLS, tham chiếu config) và
 * các lỗi cấu hình được chỉ ra bằng lời.
 */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const noSpawn: LimitedSpawn = {
  exec: () => Promise.reject(new Error('no')),
  spawn: () => Promise.reject(new Error('no')),
  openPty: () => Promise.reject(new Error('no')),
  available: () => false
}

async function setup(): Promise<{
  server: ApiTestServer
  run: <T>(op: unknown) => Promise<T>
}> {
  const server = await startApiTestServer()
  cleanups.push(() => server.close())
  const config: ResolvedClusterConfig = {
    name: 't',
    server: server.url,
    ca: TEST_CA,
    insecure: false,
    namespace: 'shop',
    auth: { token: TOKEN }
  }
  const s = new K8sService({
    resolve: () => Promise.resolve(config),
    rawConnect: (host, port) =>
      new Promise((resolve, reject) => {
        const socket: Socket = connect({ host, port })
        socket.once('connect', () => {
          resolve(socket)
        })
        socket.once('error', reject)
      }),
    spawn: noSpawn,
    emit: () => undefined,
    log: () => undefined
  })
  cleanups.push(() => {
    s.dispose()
  })
  const run = <T>(op: unknown): Promise<T> => s.run(op, new AbortController().signal) as Promise<T>
  await run({ op: 'connect', ref: { source: 'file:/x', context: 't' }, readOnly: false })
  return { server, run }
}

const OPTS = {
  hideSystem: true,
  showDeps: true,
  expanded: new Set<string>(),
  collapsed: () => false,
  showAll: new Set<string>()
}

describe('Topology tĩnh — từ API server tới bố cục', () => {
  it('cluster mẫu: cổng, endpoint, luật Ingress, TLS; lỗi cấu hình được chỉ ra', async () => {
    const { server, run } = await setup()
    server.seedDemo()
    const d = await run<MapData>({ op: 'map', namespaces: ['shop', 'payments', 'monitoring'] })

    // Dữ liệu mới của op "map".
    const api = d.services.find((s) => s.ns === 'shop' && s.name === 'api')
    expect(api).toMatchObject({
      portList: [{ name: 'http', port: 80, targetPort: 'http' }],
      endpoints: { ready: 3, notReady: 0 },
      clusterIP: '10.43.12.7'
    })
    expect(d.services.find((s) => s.name === 'postgres')?.clusterIP).toBe('None')
    expect(d.services.find((s) => s.name === 'web-public')?.external).toEqual(['198.51.100.20'])
    expect(d.services.find((s) => s.name === 'stripe')).toMatchObject({
      type: 'ExternalName',
      externalName: 'api.stripe.com'
    })
    expect(d.services.find((s) => s.name === 'stripe')?.endpoints).toBeUndefined()
    const store = d.routes.find((r) => r.name === 'storefront')
    expect(store).toMatchObject({
      className: 'nginx',
      address: ['203.0.113.10'],
      tls: [
        { hosts: ['shop.example.com'], secret: 'shop-tls' },
        { hosts: ['admin.example.com'], secret: 'admin-tls' }
      ]
    })
    expect(store?.rules).toEqual([
      { host: 'shop.example.com', path: '/', service: 'web', port: '80' },
      { host: 'shop.example.com', path: '/api', service: 'api', port: 'http' },
      { host: 'shop.example.com', path: '/legacy', service: 'legacy-api', port: '80' },
      { host: 'admin.example.com', path: '/', service: 'admin', port: '80' }
    ])
    // IngressClass, PDB, hạn chứng chỉ của Secret TLS (chỉ ngày — không giữ nội dung).
    expect(d.ingressClasses).toEqual([{ name: 'nginx', default: true }])
    expect(d.pdbs).toEqual([
      {
        ns: 'shop',
        name: 'api',
        selector: { matchLabels: { app: 'api' } },
        allowed: 0,
        expected: 3,
        rule: 'minAvailable 3'
      }
    ])
    expect(d.tlsExpiry).toEqual({ 'shop/shop-tls': '2126-09-06T23:08:03.000Z' })
    expect(JSON.stringify(d)).not.toContain('BEGIN CERTIFICATE')
    const apiWl = d.workloads.find((w) => w.name === 'api')
    expect(apiWl).toMatchObject({
      ports: [{ name: 'http', port: 8080 }],
      configMaps: ['api-config'],
      secrets: ['db-credentials'],
      serviceAccount: 'default'
    })
    // Chỉ tên được tham chiếu và có thật.
    expect(d.secrets).toEqual(
      expect.arrayContaining(['shop/shop-tls', 'shop/db-credentials', 'payments/pay-tls'])
    )
    expect(d.secrets).not.toContain('shop/admin-tls')
    expect(d.secrets).not.toContain('shop/db')
    expect(d.pvcs.find((v) => v.name === 'uploads')).toMatchObject({
      status: 'Pending',
      storageClass: 'fast-ssd'
    })
    expect(d.policies.find((p) => p.name === 'deny-all')).toMatchObject({
      types: ['Ingress', 'Egress'],
      ingressRules: 0
    })

    // Đồ thị: lỗi cấu hình bằng lời.
    const g = buildTopology(d, OPTS)
    const n = new Map(g.nodes.map((x) => [x.id, x]))
    const codes = (id: string): string[] => (n.get(id)?.problems ?? []).map((p) => p.code)
    expect(codes('ing:shop/storefront')).toEqual(
      expect.arrayContaining(['ing-missing-svc', 'ing-missing-tls'])
    )
    expect(n.get('svc:shop/legacy-api')?.missing).toBe(true)
    expect(codes('svc:shop/redis')).toEqual(['svc-no-match'])
    expect(codes('svc:shop/admin')).toEqual(
      expect.arrayContaining(['svc-no-ready', 'svc-target-port'])
    )
    expect(codes('wl:deployments.apps:shop/admin')).toEqual(
      expect.arrayContaining(['wl-down', 'pod-image'])
    )
    expect(codes('wl:deployments.apps:shop/api')).toContain('hpa-max')
    expect(codes('wl:deployments.apps:shop/media')).toEqual(
      expect.arrayContaining(['pvc-unbound', 'pod-pending'])
    )
    expect(codes('wl:deployments.apps:payments/fraud-worker')).toEqual(
      expect.arrayContaining(['pod-crash', 'np-isolated'])
    )
    // default-deny (không luật) + allow-same-namespace (có luật) → không bị cô lập.
    expect(codes('wl:deployments.apps:shop/api')).not.toContain('np-isolated')
    expect(codes('svc:shop/api')).toEqual([])
    expect(codes('svc:shop/postgres')).toEqual([])
    expect(n.get('lb:shop/web-public')).toMatchObject({ lane: 'entry', title: 'LoadBalancer' })
    expect(n.get('lb:payments/checkout')).toMatchObject({ lane: 'entry', title: 'NodePort' })
    expect(n.get('wl:daemonsets.apps:monitoring/node-exporter')?.replicas).toEqual({
      ready: 1,
      desired: 2
    })
    // Job hoàn thành: không phải vấn đề.
    expect(codes('wl:jobs.batch:shop/db-migrate-42')).toEqual([])

    // Bố cục: không chồng nhau.
    const l = layoutTopology(g)
    const cards = l.nodes
    for (const p of cards)
      for (const q of cards) {
        if (p === q) continue
        expect(
          p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h,
          `${p.id} ∩ ${q.id}`
        ).toBe(false)
      }
    const lanes = (id: string): TopoNode['lane'] | undefined => n.get(id)?.lane
    expect(lanes('svc:shop/stripe')).toBe('service')
    expect(lanes('pods:wl:deployments.apps:shop/api')).toBe('pods')
    expect(lanes('cm:shop/api-config')).toBe('deps')
  })
})
