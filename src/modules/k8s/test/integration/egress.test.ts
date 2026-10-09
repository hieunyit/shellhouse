import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { LimitedSpawn } from '../../../registry/host-types'
import { egressRows, withExtraServices, type EgressResult } from '../../shared/egress'
import type { MapData } from '../../shared/map'
import { K8sService, type ResolvedClusterConfig } from '../../session-host/service'
import { startApiTestServer, TEST_CA, TOKEN, type ApiTestServer } from '../api-test-server'

/**
 * Điểm đến khai báo (op "egress") đi trọn đường: API server giả → Session Host → danh sách host:port
 * từ env, args, ConfigMap, Secret. Secret chỉ đọc đúng cái được tham chiếu, kết quả không chứa giá trị.
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

const b64 = (v: string): string => Buffer.from(v).toString('base64')

function seed(server: ApiTestServer): void {
  server.upsert('configmaps', {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'app-config', namespace: 'shop' },
    data: {
      REDIS_URL: 'redis://cache.corp:6380/0',
      LOG_LEVEL: 'debug',
      AUTH_HOST: 'auth.example.com'
    }
  })
  server.upsert('secrets', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'db', namespace: 'shop' },
    data: {
      dsn: b64('postgres://app:TopSecret!@pg.prod.corp:5432/shop'),
      password: b64('TopSecret!')
    }
  })
  // Có Secret chứa địa chỉ nhưng không workload nào tham chiếu → không được đọc.
  server.upsert('secrets', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'unrelated', namespace: 'shop' },
    data: { url: b64('https://never-read.example.com') }
  })
  server.upsert('deployments', {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'egress-web', namespace: 'shop' },
    spec: {
      selector: { matchLabels: { app: 'egress-web' } },
      template: {
        metadata: { labels: { app: 'egress-web' } },
        spec: {
          containers: [
            {
              name: 'app',
              image: 'nginx',
              args: ['--upstream=billing.partner.io:8443'],
              env: [
                { name: 'DB_HOST', value: 'mysql.prod.corp' },
                { name: 'DB_PORT', value: '3307' },
                { name: 'API_BASE', value: 'https://api.stripe.com/v1' },
                { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'db', key: 'dsn' } } },
                {
                  name: 'SECRET_PASSWORD',
                  valueFrom: { secretKeyRef: { name: 'db', key: 'password' } }
                }
              ],
              envFrom: [{ configMapRef: { name: 'app-config' } }]
            }
          ]
        }
      }
    }
  })
}

describe('Điểm đến khai báo (egress)', () => {
  it('env, args, ConfigMap, Secret → host:port; không lộ mật khẩu; không đọc Secret thừa', async () => {
    const { server, run } = await setup()
    seed(server)
    const r = await run<EgressResult>({ op: 'egress', namespaces: ['shop'], secrets: true })
    const mine = r.items.filter((i) => i.workload.name === 'egress-web')
    const label = (i: (typeof mine)[number]): string =>
      `${i.source}:${i.via || '-'}:${i.key}=${i.host}:${String(i.port)}`
    expect(mine.map(label).sort()).toEqual(
      [
        'args:-:upstream=billing.partner.io:8443',
        'configmap:app-config:AUTH_HOST=auth.example.com:undefined',
        'configmap:app-config:REDIS_URL=cache.corp:6380',
        'env:-:API_BASE=api.stripe.com:443',
        'env:-:DB_HOST=mysql.prod.corp:3307',
        'secret:db:dsn=pg.prod.corp:5432'
      ].sort()
    )
    // Kết quả không chứa mật khẩu / chuỗi kết nối gốc.
    const json = JSON.stringify(r)
    expect(json).not.toContain('TopSecret')
    expect(json).not.toContain('app:')
    // Chỉ GET đúng Secret được tham chiếu; không list Secret, không đụng "unrelated".
    const secretReqs = server.requests.filter((q) => /\/secrets(\/|\?|$)/.test(q))
    expect(secretReqs.length).toBeGreaterThan(0)
    expect(secretReqs.every((q) => /\/secrets\/db$/.test(q))).toBe(true)
    expect(r.items.some((i) => i.host === 'never-read.example.com')).toBe(false)
    expect(r.skipped).toEqual({ configMaps: 0, secrets: 0, denied: 0 })
  })

  it('tắt đọc Secret → không có yêu cầu nào tới Secret; đếm số bị bỏ', async () => {
    const { server, run } = await setup()
    seed(server)
    const before = server.requests.length
    const r = await run<EgressResult>({ op: 'egress', namespaces: ['shop'], secrets: false })
    expect(server.requests.slice(before).some((q) => /\/secrets/.test(q))).toBe(false)
    expect(r.items.some((i) => i.source === 'secret')).toBe(false)
    expect(r.skipped.secrets).toBe(1)
    expect(r.readSecrets).toBe(false)
  })

  it('thiếu quyền đọc Secret → bỏ qua, đếm denied, phần còn lại vẫn có', async () => {
    const { server, run } = await setup()
    seed(server)
    server.forbid(/\/secrets\//)
    const r = await run<EgressResult>({ op: 'egress', namespaces: ['shop'], secrets: true })
    expect(r.skipped.denied).toBe(1)
    expect(r.items.some((i) => i.source === 'secret')).toBe(false)
    expect(r.items.some((i) => i.host === 'mysql.prod.corp')).toBe(true)
  })

  it('phân loại theo dữ liệu Map: Service trong cluster và ngoài cluster', async () => {
    const { server, run } = await setup()
    server.seedDemo()
    seed(server)
    const [map, r] = await Promise.all([
      run<MapData>({ op: 'map', namespaces: ['shop'] }),
      run<EgressResult>({ op: 'egress', namespaces: ['shop'], secrets: true })
    ])
    const rows = egressRows(r.items, map).filter((x) => x.workload.name === 'egress-web')
    const kinds = Object.fromEntries(rows.map((x) => [x.dest.host, x.dest.kind]))
    expect(kinds['api.stripe.com']).toBe('external')
    expect(kinds['mysql.prod.corp']).toBe('external')
  })

  it('Map: Service ở namespace ngoài phạm vi mà cấu hình nhắc tới vẫn được nhận ra', async () => {
    const { server, run } = await setup()
    server.upsert('services', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'pg', namespace: 'data' },
      spec: { selector: { app: 'pg' }, ports: [{ port: 5432 }], clusterIP: '10.0.0.9' }
    })
    server.upsert('deployments', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'cross', namespace: 'shop' },
      spec: {
        selector: { matchLabels: { app: 'cross' } },
        template: {
          metadata: { labels: { app: 'cross' } },
          spec: {
            containers: [
              {
                name: 'app',
                image: 'nginx',
                env: [{ name: 'DB', value: 'pg.data.svc.cluster.local:5432' }]
              }
            ]
          }
        }
      }
    })
    const [map, r] = await Promise.all([
      run<MapData>({ op: 'map', namespaces: ['shop'] }),
      run<EgressResult>({ op: 'egress', namespaces: ['shop'], secrets: false })
    ])
    expect(r.services?.map((x) => `${x.ns}/${x.name}`)).toEqual(['data/pg'])
    const rows = egressRows(r.items, withExtraServices(map, r.services)).filter(
      (x) => x.workload.name === 'cross'
    )
    expect(rows.map((x) => x.dest.kind)).toEqual(['service'])
    // Không có phần bổ sung thì đúng là chưa nhận ra — test này giữ cho lỗi cũ không quay lại.
    expect(egressRows(r.items, map).find((x) => x.workload.name === 'cross')?.dest.kind).not.toBe(
      'service'
    )
  })

  it('chế độ một workload: chỉ GET workload đó, kèm Service để phân loại', async () => {
    const { server, run } = await setup()
    seed(server)
    server.upsert('deployments', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'other', namespace: 'shop' },
      spec: {
        selector: { matchLabels: { app: 'other' } },
        template: {
          metadata: { labels: { app: 'other' } },
          spec: {
            containers: [
              { name: 'a', image: 'x', env: [{ name: 'H', value: 'https://other.example.com' }] }
            ]
          }
        }
      }
    })
    const before = server.requests.length
    const r = await run<EgressResult>({
      op: 'egress',
      namespaces: ['shop'],
      secrets: true,
      workload: { kind: 'deployments.apps', name: 'egress-web' }
    })
    const reqs = server.requests.slice(before)
    // Không list workload; chỉ một GET deployment theo tên.
    expect(reqs.some((q) => /\/deployments$|\/deployments\?/.test(q))).toBe(false)
    expect(reqs.some((q) => /\/deployments\/egress-web$/.test(q))).toBe(true)
    expect(new Set(r.items.map((i) => i.workload.name))).toEqual(new Set(['egress-web']))
    expect(r.items.some((i) => i.host === 'other.example.com')).toBe(false)
    expect(r.services?.length).toBeGreaterThan(0)
    expect(r.scanned).toBe(1)
  })

  it('mật khẩu trong Secret giống host:port không lộ ra; chuỗi kết nối rõ ràng vẫn nhận', async () => {
    const { server, run } = await setup()
    server.upsert('secrets', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'creds', namespace: 'shop' },
      data: {
        password: b64('abc.def:1234'),
        token: b64('10.9.8.7'),
        url: b64('https://vault.corp:8200')
      }
    })
    server.upsert('deployments', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'cred-user', namespace: 'shop' },
      spec: {
        selector: { matchLabels: { app: 'cred-user' } },
        template: {
          metadata: { labels: { app: 'cred-user' } },
          spec: {
            containers: [{ name: 'a', image: 'x', envFrom: [{ secretRef: { name: 'creds' } }] }]
          }
        }
      }
    })
    const r = await run<EgressResult>({ op: 'egress', namespaces: ['shop'], secrets: true })
    const mine = r.items.filter((i) => i.workload.name === 'cred-user')
    expect(mine.map((i) => `${i.host}:${String(i.port)}`)).toEqual(['vault.corp:8200'])
    expect(JSON.stringify(r)).not.toMatch(/abc\.def|10\.9\.8\.7/)
  })

  it('một ConfigMap lỗi (API 500 / hết quyền) không làm hỏng cả lượt quét', async () => {
    const { server, run } = await setup()
    seed(server)
    server.forbid(/\/configmaps\/app-config$/)
    const r = await run<EgressResult>({ op: 'egress', namespaces: ['shop'], secrets: true })
    expect(r.skipped.denied).toBeGreaterThanOrEqual(1)
    expect(r.items.some((i) => i.host === 'mysql.prod.corp')).toBe(true)
    expect(r.items.some((i) => i.host === 'cache.corp')).toBe(false)
  })

  it('không list được workload (403) → báo listDenied, không giả vờ là "không có gì"', async () => {
    const { server, run } = await setup()
    seed(server)
    server.forbid(/\/deployments/)
    const r = await run<EgressResult>({ op: 'egress', namespaces: ['shop'], secrets: true })
    expect(r.listDenied).toBeGreaterThanOrEqual(1)
    expect(r.items).toEqual([])
    const one = await run<EgressResult>({
      op: 'egress',
      namespaces: ['shop'],
      secrets: true,
      workload: { kind: 'deployments.apps', name: 'egress-web' }
    })
    expect(one.listDenied).toBe(1)
  })
})
