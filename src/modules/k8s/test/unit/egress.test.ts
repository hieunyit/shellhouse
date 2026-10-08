import { describe, expect, it } from 'vitest'
import {
  argEntries,
  classifyEndpoint,
  egressRows,
  endpointsIn,
  endpointsInEntries,
  indexEgress,
  type EgressItem
} from '../../shared/egress'
import type { MapService } from '../../shared/map'

const hp = (v: string, key = ''): string[] =>
  endpointsIn(v, key).map((e) => `${e.host}${e.port !== undefined ? `:${String(e.port)}` : ''}`)

describe('endpointsIn — điểm đến trong chuỗi', () => {
  it('URL: bỏ thông tin đăng nhập, lấy host / cổng / scheme', () => {
    const [e] = endpointsIn('postgres://app:S3cr3t!@db.prod.internal:5432/shop?sslmode=require')
    expect(e).toMatchObject({ host: 'db.prod.internal', port: 5432, scheme: 'postgres' })
    expect(JSON.stringify(endpointsIn('postgres://app:S3cr3t!@db:5432/x'))).not.toContain('S3cr3t')
  })

  it('không ghi cổng → cổng mặc định của scheme (đánh dấu suy ra)', () => {
    expect(endpointsIn('https://api.stripe.com/v1')[0]).toMatchObject({
      host: 'api.stripe.com',
      port: 443,
      portImplied: true
    })
    expect(endpointsIn('redis://cache')[0]).toMatchObject({ port: 6379, portImplied: true })
    expect(endpointsIn('foo://x.example.com')[0]).toEqual({ host: 'x.example.com', scheme: 'foo' })
  })

  it('JDBC, nhiều host (mongo / kafka), IPv6', () => {
    expect(hp('jdbc:mysql://db1.corp:3306/app')).toEqual(['db1.corp:3306'])
    expect(hp('mongodb://u:p@m1:27017,m2:27017,m3:27017/db?replicaSet=rs0')).toEqual([
      'm1:27017',
      'm2:27017',
      'm3:27017'
    ])
    expect(hp('http://[2001:db8::1]:8080/x')).toEqual(['2001:db8::1:8080'])
  })

  it('host:port nằm trong văn bản; IP; bỏ localhost / 127.0.0.1', () => {
    expect(hp('connect to 10.20.30.40:9042 and kafka-1.example.com:9092 please')).toEqual([
      '10.20.30.40:9042',
      'kafka-1.example.com:9092'
    ])
    expect(hp('http://localhost:8080 127.0.0.1:5432 0.0.0.0:80')).toEqual([])
  })

  it('giá trị chỉ có host: cần tên khoá gợi ý địa chỉ', () => {
    expect(hp('db.internal.corp', 'DB_HOST')).toEqual(['db.internal.corp'])
    expect(hp('redis', 'REDIS_HOST')).toEqual(['redis'])
    expect(hp('redis:6379', 'cache.addr')).toEqual(['redis:6379'])
    // không gợi ý + không dấu chấm → không phải địa chỉ
    expect(hp('production', 'ENVIRONMENT')).toEqual([])
    expect(hp('web:8080', 'APP_LABEL')).toEqual([])
    // có dấu chấm + cổng thì nhận dù khoá không gợi ý
    expect(hp('db.example.com:5432', 'FOO')).toEqual(['db.example.com:5432'])
  })

  it('không nhận số phiên bản, tên file, placeholder', () => {
    expect(hp('1.2.3', 'VERSION')).toEqual([])
    expect(hp('v1.2.3.4', 'VERSION')).toEqual([])
    expect(hp('config.yaml:80')).toEqual([])
    expect(hp('http://$(DB_HOST):5432')).toEqual([])
    expect(hp('${HOST}:8080')).toEqual([])
  })
})

describe('endpointsInEntries / argEntries', () => {
  it('ghép X_HOST với X_PORT', () => {
    const r = endpointsInEntries([
      { key: 'DB_HOST', value: 'pg.prod.corp' },
      { key: 'DB_PORT', value: '5433' },
      { key: 'REDIS_HOST', value: 'redis' },
      { key: 'OTHER', value: 'x' }
    ])
    expect(r.map((x) => `${x.key}=${x.endpoint.host}:${String(x.endpoint.port)}`)).toEqual([
      'DB_HOST=pg.prod.corp:5433',
      'REDIS_HOST=redis:undefined'
    ])
  })

  it('cờ dòng lệnh', () => {
    const entries = argEntries(['--redis=cache.corp:6379', '--db-host', 'pg.corp', '-v', 'run'])
    expect(entries).toContainEqual({ key: 'redis', value: 'cache.corp:6379' })
    expect(entries).toContainEqual({ key: 'db-host', value: 'pg.corp' })
    expect(endpointsInEntries(entries).map((x) => x.endpoint.host)).toEqual([
      'cache.corp',
      'pg.corp'
    ])
  })
})

const svc = (ns: string, name: string, extra: Partial<MapService> = {}): MapService => ({
  ns,
  name,
  type: 'ClusterIP',
  selector: {},
  ports: '',
  ...extra
})

describe('classifyEndpoint', () => {
  const ix = indexEgress({
    services: [
      svc('shop', 'db', { clusterIP: '10.43.0.10' }),
      svc('data', 'pg', { clusterIP: '10.43.0.20' }),
      svc('shop', 'ext', { type: 'ExternalName', externalName: 'rds.amazonaws.com' })
    ],
    pods: [
      {
        ns: 'shop',
        name: 'p',
        owner: null,
        status: 'Running',
        tone: 'ok',
        restarts: 0,
        node: 'n',
        ip: '10.42.0.5'
      }
    ]
  })
  const kind = (host: string, ns = 'shop', port?: number): string =>
    classifyEndpoint({ host, ...(port ? { port } : {}) }, ns, ix).kind

  it('Service trong cluster theo tên DNS / ClusterIP', () => {
    expect(classifyEndpoint({ host: 'db' }, 'shop', ix).service).toEqual({ ns: 'shop', name: 'db' })
    expect(classifyEndpoint({ host: 'pg.data.svc.cluster.local' }, 'shop', ix).service).toEqual({
      ns: 'data',
      name: 'pg'
    })
    expect(classifyEndpoint({ host: 'pg.data' }, 'shop', ix).service).toEqual({
      ns: 'data',
      name: 'pg'
    })
    expect(classifyEndpoint({ host: '10.43.0.20' }, 'shop', ix).service).toEqual({
      ns: 'data',
      name: 'pg'
    })
  })

  it('ExternalName: đích thật là tên bên ngoài, nhớ Service đã dùng', () => {
    const d = classifyEndpoint({ host: 'ext', port: 5432 }, 'shop', ix)
    expect(d).toMatchObject({
      kind: 'external',
      host: 'rds.amazonaws.com',
      port: 5432,
      viaService: { ns: 'shop', name: 'ext' }
    })
  })

  it('ngoài cluster', () => {
    expect(kind('api.stripe.com')).toBe('external')
    expect(kind('8.8.8.8')).toBe('external')
    expect(kind('10.99.1.1')).toBe('private')
    expect(kind('192.168.1.10')).toBe('private')
    expect(kind('10.42.0.5')).toBe('pod')
    expect(kind('missing')).toBe('unresolved')
    expect(kind('db', 'other')).toBe('unresolved')
  })
})

describe('egressRows', () => {
  it('gộp cùng workload + đích từ nhiều nguồn', () => {
    const w = { kind: 'deployments.apps', ns: 'shop', name: 'web' }
    const items: EgressItem[] = [
      { workload: w, source: 'env', via: '', key: 'DB_HOST', host: 'pg.corp', port: 5432 },
      { workload: w, source: 'secret', via: 'db', key: 'url', host: 'pg.corp', port: 5432 },
      { workload: w, source: 'env', via: '', key: 'API', host: 'api.x.com', port: 443 }
    ]
    const rows = egressRows(items, { services: [], pods: [] })
    expect(rows).toHaveLength(2)
    const pg = rows.find((r) => r.dest.host === 'pg.corp')
    expect(pg?.sources.map((s) => s.source)).toEqual(['env', 'secret'])
  })
})
