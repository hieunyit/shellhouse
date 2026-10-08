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

describe('endpointsIn — các ca dễ nhầm', () => {
  it('giá trị cấu hình thông thường không phải địa chỉ ("true", "default"…)', () => {
    expect(hp('true', 'ENABLE_PROXY')).toEqual([])
    expect(hp('false', 'DB_PRIMARY')).toEqual([])
    expect(hp('default', 'API_SERVER')).toEqual([])
    expect(hp('production', 'DB_HOST')).toEqual([])
    expect(hp('x', 'DB_HOST')).toEqual([])
  })

  it('kho object / tệp / ảnh: phần "host" không phải máy chủ', () => {
    expect(hp('s3://my-bucket/path/key')).toEqual([])
    expect(hp('gs://my-bucket')).toEqual([])
    expect(hp('abfss://container@acct.dfs.core.windows.net/p')).toEqual([])
    expect(hp('docker://nginx:1.27')).toEqual([])
    expect(hp('hdfs://namenode.corp:8020/data')).toEqual(['namenode.corp:8020'])
    expect(hp('git+ssh://git@github.com/org/repo.git')).toEqual(['github.com'])
  })

  it('chuỗi kết nối kiểu libpq / ADO.NET / Oracle', () => {
    expect(hp('host=db.corp port=5432 dbname=shop user=app password=x')).toEqual(['db.corp:5432'])
    expect(
      hp('Server=tcp:myserver.database.windows.net,1433;Database=x;User Id=u;Password=p')
    ).toEqual(['myserver.database.windows.net:1433'])
    expect(hp('jdbc:oracle:thin:@//ora.corp:1521/svc')).toEqual(['ora.corp:1521'])
    expect(hp('Data Source=sql.corp;Initial Catalog=x')).toEqual(['sql.corp'])
  })

  it('tệp cấu hình trong ConfigMap: ghép host với port cùng khối, không lấy nhầm khối khác', () => {
    const yaml = 'db:\n  host: pg.corp\n  port: 5433\nredis:\n  host: cache.corp\n'
    expect(hp(yaml)).toEqual(['pg.corp:5433', 'cache.corp'])
    const props = 'db.host=pg.corp\ndb.port=5433\ncache.host=cache.corp\nlog.level=debug'
    expect(hp(props)).toEqual(['pg.corp:5433', 'cache.corp'])
    const json = '{\n  "host": "api.corp",\n  "port": 8443\n}'
    expect(hp(json)).toEqual(['api.corp:8443'])
  })

  it('Secret (strict): mật khẩu giống host:port không bị lộ; địa chỉ rõ ràng vẫn nhận', () => {
    const strict = { strict: true }
    expect(endpointsIn('abc.def:1234', 'DB_PASSWORD', strict)).toEqual([])
    expect(endpointsIn('10.0.0.5', 'API_TOKEN', strict)).toEqual([])
    expect(endpointsIn('see pg.corp:5432 for details', 'NOTE', strict)).toEqual([])
    expect(endpointsIn('postgres://u:p@pg.corp:5432/x', 'DSN', strict)).toHaveLength(1)
    expect(endpointsIn('host=pg.corp port=5432', 'conn', strict)).toHaveLength(1)
    expect(endpointsIn('pg.corp', 'DB_HOST', strict)[0]?.host).toBe('pg.corp')
  })

  it('không văng lỗi và không bao giờ trả lại thông tin đăng nhập (chuỗi ngẫu nhiên)', () => {
    let seed = 1234567
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const pieces = [
      'postgres://',
      'user:',
      'S3cr3tPW',
      '@',
      'host.example.com',
      ':5432',
      '/db',
      '?x=1',
      ',',
      ';',
      'jdbc:mysql:',
      '[::1]',
      '[fd00::5]',
      '\n',
      ' ',
      'host=',
      'port=',
      '=',
      '10.0.0.1',
      '"',
      "'",
      '\\',
      '$(X)'
    ]
    for (let i = 0; i < 3000; i++) {
      const n = 1 + rnd(9)
      let v = ''
      for (let k = 0; k < n; k++) v += pieces[rnd(pieces.length)] ?? ''
      for (const strict of [false, true]) {
        const eps = endpointsIn(v, ['', 'DB_HOST', 'DSN'][rnd(3)] ?? '', { strict })
        for (const e of eps) {
          expect(e.host).not.toMatch(/S3cr3tPW|@|\s|\/|\?/)
          if (e.port !== undefined) expect(e.port).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('classifyEndpoint — tên DNS trong cluster', () => {
  const ix = indexEgress({
    services: [
      svc('shop', 'db-headless', { clusterIP: 'None' }),
      svc('data', 'pg', { clusterIP: '10.43.0.20' })
    ],
    pods: []
  })
  it('pod của StatefulSet qua Service headless → Service đó (không phải External)', () => {
    const d = classifyEndpoint(
      { host: 'db-0.db-headless.shop.svc.cluster.local', port: 5432 },
      'x',
      ix
    )
    expect(d).toMatchObject({ kind: 'service', service: { ns: 'shop', name: 'db-headless' } })
  })
  it('DNS của pod, IPv6 riêng / công khai', () => {
    expect(classifyEndpoint({ host: '10-42-0-5.shop.pod.cluster.local' }, 'x', ix).kind).toBe('pod')
    expect(classifyEndpoint({ host: 'fd00::1' }, 'x', ix).kind).toBe('private')
    expect(classifyEndpoint({ host: 'fe80::1' }, 'x', ix).kind).toBe('private')
    expect(classifyEndpoint({ host: '2001:4860:4860::8888' }, 'x', ix).kind).toBe('external')
  })
  it('tên .svc không có Service như vậy → chưa xác định (không phải External)', () => {
    expect(classifyEndpoint({ host: 'nope.shop.svc.cluster.local' }, 'x', ix).kind).toBe(
      'unresolved'
    )
  })
})

describe('tên khoá nói về bí mật (lỗi thật: EMAIL_HOST_PASSWORD bị nhận là host)', () => {
  const pw = 'bftrtt1722ai3r8vpqlme2rindsns10hk7bovpd49cxb'
  it('mật khẩu / token trong khoá có chữ HOST không phải điểm đến', () => {
    for (const strict of [true, false]) {
      expect(endpointsIn(pw, 'EMAIL_HOST_PASSWORD', { strict })).toEqual([])
      expect(endpointsIn('db.internal.corp', 'DB_HOST_PASSWORD', { strict })).toEqual([])
      expect(endpointsIn('10.1.2.3', 'SERVER_TOKEN', { strict })).toEqual([])
      expect(endpointsIn('smtp.corp:465', 'SMTP_HOST_SECRET', { strict })).toEqual([])
      expect(endpointsIn('x.example.com:443', 'API_KEY', { strict })).toEqual([])
    }
  })
  it('từ gợi ý phải đứng cuối tên khoá', () => {
    expect(endpointsIn('smtp.corp', 'EMAIL_HOST')[0]?.host).toBe('smtp.corp')
    expect(endpointsIn('smtp.corp', 'EMAIL_HOST', { strict: true })[0]?.host).toBe('smtp.corp')
    expect(endpointsIn('smtp.corp', 'HOST_TIMEOUT')).toEqual([])
    expect(endpointsIn('redis', 'HOSTNAME_PREFIX')).toEqual([])
  })
  it('chuỗi một nhãn trông như token ngẫu nhiên không phải tên máy', () => {
    expect(endpointsIn(pw, 'EMAIL_HOST')).toEqual([])
    expect(endpointsIn('a1b2c3d4e5f6g7h8i9', 'DB_HOST', { strict: true })).toEqual([])
    expect(endpointsIn('redis', 'DB_HOST', { strict: true })[0]?.host).toBe('redis')
    expect(endpointsIn('pg-primary', 'DB_HOST')[0]?.host).toBe('pg-primary')
  })
  it('URL rõ ràng trong khoá bí mật vẫn nhận (DATABASE_URL_SECRET không có trong thực tế, nhưng URL tự chứng tỏ)', () => {
    expect(endpointsIn('https://vault.corp:8200', 'VAULT_TOKEN_URL')).toHaveLength(1)
  })
})
