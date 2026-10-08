import { connect, type Socket } from 'node:net'
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from '../../../../../test/unit/helpers'
import type { LimitedSpawn } from '../../../registry/host-types'
import { KubeClient, KubeTimeoutError, keepAlive, requestTimeout } from '../../session-host/client'
import { credentialProvider, type OidcTokens } from '../../session-host/auth'
import { drainRetry } from '../../session-host/operations'
import {
  K8sService,
  linkProbe,
  watchIdle,
  type K8sServiceDeps,
  type ResolvedClusterConfig
} from '../../session-host/service'
import type { DrainResult, HelmRelease, TopologyResult } from '../../shared/ops'
import { startApiTestServer, TEST_CA, TOKEN, type ApiTestServer } from '../api-test-server'

/** Phần Session Host của Kubernetes: kết nối, xác thực, chỉ đọc, sửa trong editor, drain… */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const FIXTURES = join(__dirname, '..', 'fixtures')

const noSpawn: LimitedSpawn = {
  exec: () => Promise.reject(new Error('no')),
  spawn: () => Promise.reject(new Error('no')),
  openPty: () => Promise.reject(new Error('no')),
  available: () => false
}

async function api(): Promise<ApiTestServer> {
  const s = await startApiTestServer()
  cleanups.push(() => s.close())
  return s
}

/** Kết nối TCP thẳng; `delayMs` giả độ trễ mở kênh qua bastion SSH. */
function rawConnect(delayMs = 0) {
  return (host: string, port: number): Promise<Socket> =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        const socket: Socket = connect({ host, port })
        socket.once('connect', () => {
          resolve(socket)
        })
        socket.once('error', reject)
      }, delayMs)
    })
}

function config(server: ApiTestServer, extra: Partial<ResolvedClusterConfig> = {}) {
  return {
    name: 't',
    server: server.url,
    ca: TEST_CA,
    insecure: false,
    namespace: 'shop',
    auth: { token: TOKEN },
    ...extra
  } satisfies ResolvedClusterConfig
}

async function setup(
  server: ApiTestServer,
  extra: Partial<ResolvedClusterConfig> = {},
  deps: Partial<K8sServiceDeps> = {}
) {
  const events: { event: string; data: unknown }[] = []
  const s = new K8sService({
    resolve: () => Promise.resolve(config(server, extra)),
    rawConnect: rawConnect(),
    spawn: noSpawn,
    emit: (event, data) => events.push({ event, data }),
    log: () => undefined,
    ...deps
  })
  cleanups.push(() => {
    s.dispose()
  })
  const run = <T>(op: unknown): Promise<T> => s.run(op, new AbortController().signal) as Promise<T>
  const info = await run<{ readOnly: boolean }>({
    op: 'connect',
    ref: { source: 'file:/x', context: 't' },
    readOnly: false
  })
  const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return { s, run, events, until, info }
}

function client(server: ApiTestServer, delayMs = 0): KubeClient {
  const c = new KubeClient(config(server), rawConnect(delayMs), () =>
    Promise.resolve({ headers: { Authorization: `Bearer ${TOKEN}` } })
  )
  cleanups.push(() => {
    c.close()
  })
  return c
}

describe('K8s client: keep-alive, thời gian chờ', () => {
  it('request thường dùng lại kết nối (keep-alive); nhanh hơn hẳn khi mở kết nối chậm (bastion)', async () => {
    const server = await api()
    const c = client(server, 40)
    const before = server.connections()
    const t0 = performance.now()
    for (let i = 0; i < 15; i++) await c.json('GET', '/api/v1/namespaces/shop/pods')
    const pooled = performance.now() - t0
    expect(server.connections() - before).toBe(1)
    // Song song: tối đa keepAlive.maxSockets kết nối, xong rồi vẫn dùng lại.
    await Promise.all(
      Array.from({ length: 6 }, () => c.json('GET', '/api/v1/namespaces/shop/pods'))
    )
    const afterParallel = server.connections()
    expect(afterParallel - before).toBeLessThanOrEqual(6)
    await c.json('GET', '/version')
    expect(server.connections()).toBe(afterParallel)
    // So với mở kết nối mới cho mỗi request (cách cũ — open() không dùng kết nối giữ lại).
    const t1 = performance.now()
    for (let i = 0; i < 15; i++) {
      const res = await c.open('GET', '/api/v1/namespaces/shop/pods')
      res.resume()
      await new Promise((r) => res.once('end', r))
    }
    const fresh = performance.now() - t1
    console.info(
      `15 GET qua kết nối chậm 40 ms: keep-alive ${pooled.toFixed(0)} ms, mỗi request một kết nối ${fresh.toFixed(0)} ms`
    )
    expect(pooled).toBeLessThan(fresh / 2)
  })

  it('kết nối rảnh quá hạn bị đóng; server đóng kết nối giữ lại → GET gửi lại bằng kết nối mới', async () => {
    const server = await api()
    const c = client(server)
    const saved = keepAlive.idleMs
    keepAlive.idleMs = 100
    cleanups.push(() => {
      keepAlive.idleMs = saved
    })
    await c.json('GET', '/version')
    await new Promise((r) => setTimeout(r, 300))
    const before = server.connections()
    await c.json('GET', '/version')
    expect(server.connections()).toBe(before + 1)
  })

  it('API server treo → request thường báo lỗi sau idleMs (watch / log không bị giới hạn)', async () => {
    const server = await api()
    const c = client(server)
    const saved = requestTimeout.idleMs
    requestTimeout.idleMs = 300
    cleanups.push(() => {
      requestTimeout.idleMs = saved
    })
    server.stall(/^\/api\/v1\/namespaces\/shop\/configmaps$/)
    const t0 = Date.now()
    await expect(c.json('GET', '/api/v1/namespaces/shop/configmaps')).rejects.toBeInstanceOf(
      KubeTimeoutError
    )
    expect(Date.now() - t0).toBeLessThan(3000)
    // Kết nối vẫn dùng được cho request khác.
    server.stall(null)
    await expect(c.json('GET', '/version')).resolves.toMatchObject({ gitVersion: 'v1.31.2' })
  })

  it('request xếp hàng chờ kết nối (đủ maxSockets) không bị tính giờ im lặng', async () => {
    const server = await api()
    const savedIdle = requestTimeout.idleMs
    const savedMax = keepAlive.maxSockets
    requestTimeout.idleMs = 300
    keepAlive.maxSockets = 1
    cleanups.push(() => {
      requestTimeout.idleMs = savedIdle
      keepAlive.maxSockets = savedMax
    })
    const c = client(server)
    // Có sẵn một kết nối giữ lại (agent chỉ đếm socket đã mở xong khi so với maxSockets).
    await c.json('GET', '/version')
    server.stall(/^\/api\/v1\/namespaces\/shop\/configmaps$/)
    const stalled = [1, 2].map(() => c.json('GET', '/api/v1/namespaces/shop/configmaps'))
    for (const p of stalled) p.catch(() => undefined)
    // Chờ sau hai request treo (một socket duy nhất) ~600 ms > idleMs rồi mới có kết nối — vẫn phải
    // thành công.
    const queued = c.json('GET', '/version')
    for (const p of stalled) await expect(p).rejects.toBeInstanceOf(KubeTimeoutError)
    await expect(queued).resolves.toMatchObject({ gitVersion: 'v1.31.2' })
  })
})

describe('K8s xác thực OIDC', () => {
  /** IdP giả (HTTPS, chứng chỉ test): discovery + token endpoint xoay vòng refresh token. */
  async function idp(
    /** Refresh token IdP còn nhận (mặc định: mọi token). */
    accepts: (refreshToken: string | null) => boolean = () => true
  ): Promise<{ url: string; calls: string[]; forms: URLSearchParams[] }> {
    const calls: string[] = []
    const forms: URLSearchParams[] = []
    let n = 0
    const server = createHttpsServer(
      {
        key: readFileSync(join(FIXTURES, 'server.key')),
        cert: readFileSync(join(FIXTURES, 'server.crt'))
      },
      (req, res) => {
        calls.push(`${req.method ?? ''} ${req.url ?? ''}`)
        const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
        if (req.url === '/.well-known/openid-configuration') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ issuer: base, token_endpoint: `${base}/token` }))
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
          forms.push(form)
          if (!accepts(form.get('refresh_token'))) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({ error: 'invalid_grant', error_description: 'Token is not active' })
            )
            return
          }
          n++
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id_token: TOKEN, refresh_token: `rt-${n + 1}` }))
        })
      }
    )
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections()
          server.close(() => {
            r()
          })
        })
    )
    return { url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, forms }
  }

  const expired = `h.${Buffer.from(JSON.stringify({ exp: 1000 })).toString('base64url')}.s`

  it('token hết hạn → hỏi discovery (request thật sự được gửi), đổi refresh token, giữ bản mới, lưu lại', async () => {
    const provider = await idp()
    const server = await api()
    const saved: OidcTokens[] = []
    const { run } = await setup(
      server,
      {
        auth: {
          oidc: {
            idToken: expired,
            refreshToken: 'rt-1',
            issuer: provider.url,
            clientId: 'kube',
            idpCa: TEST_CA
          }
        }
      },
      {
        persistOidc: (_ref, tokens) => {
          saved.push(tokens)
          return Promise.resolve()
        }
      }
    )
    expect(provider.calls).toEqual(['GET /.well-known/openid-configuration', 'POST /token'])
    expect(provider.forms[0]?.get('refresh_token')).toBe('rt-1')
    expect(saved).toEqual([{ idToken: TOKEN, refreshToken: 'rt-2' }])
    // Token mới (không phải JWT — không rõ hạn) dùng tiếp, không hỏi IdP nữa.
    await expect(run({ op: 'namespaces' })).resolves.toMatchObject({ canList: true })
    expect(provider.calls).toHaveLength(2)
  })

  it('nhiều request cùng lúc khi token hết hạn → chỉ làm mới một lần', async () => {
    const provider = await idp()
    let now = 1_000_000
    const creds = credentialProvider(
      {
        oidc: {
          idToken: expired,
          refreshToken: 'rt-1',
          issuer: provider.url,
          clientId: 'kube',
          idpCa: TEST_CA
        }
      },
      noSpawn,
      'https://x',
      () => now
    )
    await Promise.all(Array.from({ length: 8 }, () => creds(false)))
    expect(provider.forms).toHaveLength(1)
    // 401 của các request gửi trước lúc làm mới → không làm mới thêm.
    await Promise.all(Array.from({ length: 4 }, () => creds(true)))
    expect(provider.forms).toHaveLength(1)
    now += 10_000
    await creds(true)
    expect(provider.forms).toHaveLength(2)
    expect(provider.forms[1]?.get('refresh_token')).toBe('rt-2')
  })

  it('refresh token bị tab khác xoay vòng (invalid_grant) → đọc bản đã lưu, thử lại một lần', async () => {
    const provider = await idp((rt) => rt === 'rt-9')
    let reloads = 0
    const auth = {
      oidc: {
        idToken: expired,
        refreshToken: 'rt-1',
        issuer: provider.url,
        clientId: 'kube',
        idpCa: TEST_CA
      }
    }
    const creds = credentialProvider(auth, noSpawn, 'https://x', Date.now, {
      reloadOidc: () => {
        reloads++
        return Promise.resolve({ idToken: expired, refreshToken: 'rt-9' })
      }
    })
    await expect(creds(false)).resolves.toMatchObject({
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    expect(reloads).toBe(1)
    expect(provider.forms.map((f) => f.get('refresh_token'))).toEqual(['rt-1', 'rt-9'])

    // Tab kia đã có id token còn hạn → dùng luôn, không gọi IdP lần nữa.
    const fresh = `h.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url')}.s`
    const other = await idp(() => false)
    const creds2 = credentialProvider(
      { oidc: { ...auth.oidc, issuer: other.url } },
      noSpawn,
      'https://x',
      Date.now,
      { reloadOidc: () => Promise.resolve({ idToken: fresh, refreshToken: 'rt-9' }) }
    )
    await expect(creds2(false)).resolves.toMatchObject({
      headers: { Authorization: `Bearer ${fresh}` }
    })
    expect(other.forms).toHaveLength(1)

    // Bản đã lưu không khác → báo lỗi gốc, không lặp.
    const creds3 = credentialProvider(
      { oidc: { ...auth.oidc, issuer: other.url } },
      noSpawn,
      'https://x',
      Date.now,
      { reloadOidc: () => Promise.resolve({ refreshToken: 'rt-1' }) }
    )
    await expect(creds3(false)).rejects.toThrow(/not active/)
    expect(other.forms).toHaveLength(2)
  })

  it('issuer http:// → không gửi refresh token qua kết nối không mã hoá', async () => {
    const creds = credentialProvider(
      { oidc: { idToken: expired, refreshToken: 'rt', issuer: 'http://idp', clientId: 'k' } },
      noSpawn,
      'https://x'
    )
    await expect(creds(false)).rejects.toThrow(/https/)
  })
})

describe('K8s chế độ chỉ đọc theo main', () => {
  it('main bật chỉ đọc → chặn thay đổi, port-forward, shell dù renderer gửi readOnly:false; xem Secret vẫn được', async () => {
    const server = await api()
    const { s, run, info } = await setup(server, { readOnly: true })
    expect(info.readOnly).toBe(true)
    await expect(
      run({ op: 'scale', kind: 'deployments.apps', namespace: 'shop', name: 'web', replicas: 1 })
    ).rejects.toThrow(/Read-only/)
    await expect(
      run({ op: 'portForward', namespace: 'shop', target: 'pod/web-1', ports: [[0, 8080]] })
    ).rejects.toThrow(/Read-only/)
    await expect(
      s.openTerminal(
        { ref: { source: 'file:/x', context: 't' }, namespace: 'shop', pod: 'web-1' },
        { cols: 80, rows: 24 },
        { onData: () => undefined, onExit: () => undefined }
      )
    ).rejects.toThrow(/Read-only/)
    await expect(
      run({ op: 'secret.reveal', namespace: 'shop', name: 'db', key: 'password' })
    ).resolves.toBe('s3cr3t')
    expect(server.get('deployments', 'shop', 'web')?.spec?.['replicas']).toBe(2)
  })

  it('kết quả resolve sai dạng → từ chối (không tin cast)', async () => {
    const server = await api()
    const s = new K8sService({
      resolve: () => Promise.resolve({ name: 't', server: 42 } as unknown as ResolvedClusterConfig),
      rawConnect: rawConnect(),
      spawn: noSpawn,
      emit: () => undefined,
      log: () => undefined
    })
    cleanups.push(() => {
      s.dispose()
    })
    await expect(
      s.run(
        { op: 'connect', ref: { source: 'file:/x', context: 't' }, readOnly: false },
        new AbortController().signal
      )
    ).rejects.toThrow()
    expect(server.requests).toEqual([])
  })
})

describe('K8s sửa trong editor', () => {
  it('chỉ nhận file tạm main cấp; symlink bị từ chối; bật chỉ đọc giữa chừng → lưu bị chặn', async () => {
    const server = await api()
    const dir = tempDir()
    const allowed = join(dir, 'web.yaml')
    const { run, events, until } = await setup(
      server,
      {},
      {
        checkEditFile: (path) => Promise.resolve(path.startsWith(dir))
      }
    )
    const edit = (localPath: string): Promise<unknown> =>
      run({ op: 'edit', kind: 'deployments.apps', namespace: 'shop', name: 'web', localPath })
    await expect(edit(join(tempDir(), 'elsewhere.yaml'))).rejects.toThrow(/cannot be used/)
    const target = join(tempDir(), 'victim.txt')
    writeFileSync(target, 'keep')
    const link = join(dir, 'link.yaml')
    symlinkSync(target, link)
    await expect(edit(link)).rejects.toThrow(/cannot be used/)
    expect(readFileSync(target, 'utf8')).toBe('keep')

    await edit(allowed)
    // Bật chỉ đọc (renderer kết nối lại với readOnly) → lần lưu sau bị chặn.
    await run({ op: 'connect', ref: { source: 'file:/x', context: 't' }, readOnly: true })
    writeFileSync(allowed, readFileSync(allowed, 'utf8').replace('replicas: 2', 'replicas: 5'))
    await until(() => events.some((e) => e.event === 'edit'), 8000)
    expect(events.find((e) => e.event === 'edit')?.data).toMatchObject({
      ok: false,
      error: expect.stringContaining('Read-only') as unknown
    })
    expect(server.get('deployments', 'shop', 'web')?.spec?.['replicas']).toBe(2)
  }, 20_000)
})

describe('K8s watch dùng chung', () => {
  it('người đến sau (watch đã nhận sự kiện) có watch riêng; watch dừng sau 410 không còn ai nhập vào', async () => {
    const server = await api()
    const { run, events, until } = await setup(server)
    const list = await run<{ resourceVersion: string }>({ op: 'list', kind: 'pods', limit: 100 })
    const a = await run<{ subscription: string }>({
      op: 'watch',
      kind: 'pods',
      resourceVersion: list.resourceVersion
    })
    await new Promise((r) => setTimeout(r, 150))
    server.upsert('pods', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'p1', namespace: 'shop' }
    })
    await until(() =>
      events.some((e) => (e.data as { subscription?: string }).subscription === a.subscription)
    )
    const watchesBefore = server.requests.filter((r) => r.includes('watch=true')).length
    // Cùng khoá nhưng watch kia đã đi tiếp → mở watch mới từ resourceVersion của người đến sau.
    await run({ op: 'watch', kind: 'pods', resourceVersion: list.resourceVersion })
    await until(
      () => server.requests.filter((r) => r.includes('watch=true')).length > watchesBefore
    )
    // 410 Gone → các watch báo relist rồi dừng; đăng ký mới mở watch mới (không nhập watch chết).
    server.expireWatches()
    await until(() => events.some((e) => (e.data as { relist?: boolean }).relist === true))
    await new Promise((r) => setTimeout(r, 100))
    const n = server.requests.filter((r) => r.includes('watch=true')).length
    await run({ op: 'watch', kind: 'pods', resourceVersion: '1' })
    await until(() => server.requests.filter((r) => r.includes('watch=true')).length > n)
  })
})

describe('K8s watch: kết nối chết im lặng', () => {
  it('không có byte nào quá watchIdle → bỏ kết nối, nối lại từ resourceVersion', async () => {
    const server = await api()
    const saved = watchIdle.ms
    watchIdle.ms = 300
    cleanups.push(() => {
      watchIdle.ms = saved
    })
    const { run, until } = await setup(server)
    await run({ op: 'watch', kind: 'configmaps', namespace: 'shop', resourceVersion: '5' })
    const watches = (): number => server.requests.filter((r) => r.includes('watch=true')).length
    await until(() => watches() >= 3, 5000)
  })
})

describe('K8s watch: mất kết nối tới API server', () => {
  it('API server không trả lời /version → báo "cũ" (stale); trả lời lại → báo hết cũ và nối lại watch', async () => {
    const server = await api()
    const saved = { ...linkProbe }
    Object.assign(linkProbe, { intervalMs: 60, timeoutMs: 120, failures: 2 })
    cleanups.push(() => {
      Object.assign(linkProbe, saved)
    })
    const { run, events, until } = await setup(server)
    await run({ op: 'watch', kind: 'configmaps', namespace: 'shop', resourceVersion: '5' })
    const watches = (): number => server.requests.filter((r) => r.includes('watch=true')).length
    await until(() => watches() >= 1)
    const stale = (): boolean[] =>
      events.flatMap((e) => {
        const s = (e.data as { stale?: boolean }).stale
        return s === undefined ? [] : [s]
      })
    // Đang khoẻ: không báo gì.
    await new Promise((r) => setTimeout(r, 250))
    expect(stale()).toEqual([])
    // Treo: sau vài lần dò hụt → stale = true (một lần, không lặp).
    server.stall(/\/version$/)
    await until(() => stale().includes(true), 4000)
    await new Promise((r) => setTimeout(r, 300))
    expect(stale()).toEqual([true])
    // Về lại: stale = false và luồng watch cũ bị bỏ để nối mới.
    const before = watches()
    server.stall(null)
    await until(() => stale().includes(false), 4000)
    await until(() => watches() > before, 4000)
    expect(stale()).toEqual([true, false])
  })

  it('API server trả lỗi HTTP (5xx / 403) cho /version vẫn là đang trả lời — không báo cũ', async () => {
    const server = await api()
    const saved = { ...linkProbe }
    Object.assign(linkProbe, { intervalMs: 50, timeoutMs: 100, failures: 2 })
    cleanups.push(() => {
      Object.assign(linkProbe, saved)
    })
    const { run, events } = await setup(server)
    await run({ op: 'watch', kind: 'configmaps', namespace: 'shop', resourceVersion: '5' })
    server.forbid(/\/version$/)
    await new Promise((r) => setTimeout(r, 500))
    expect(events.some((e) => (e.data as { stale?: boolean }).stale === true)).toBe(false)
  })
})

describe('K8s drain, Secret, Helm, topology', () => {
  it('drain: pod không có controller chặn cả lượt; force → evict; PDB (429) → thử lại tới khi được', async () => {
    const server = await api()
    const { run } = await setup(server)
    const saved = drainRetry.ms
    drainRetry.ms = 50
    cleanups.push(() => {
      drainRetry.ms = saved
    })
    const blocked = await run<DrainResult>({ op: 'drain', node: 'node-1' })
    expect(blocked.evicted).toEqual([])
    expect(blocked.blocked).toEqual(['default/tool'])
    expect(blocked.failed[0]).toMatch(/default\/tool: not managed by a controller/)
    expect(server.list('pods')).toHaveLength(3)
    server.blockEvictions(3)
    const r = await run<DrainResult>({
      op: 'drain',
      node: 'node-1',
      force: true,
      timeoutSeconds: 30
    })
    expect(r.evicted.sort()).toEqual(['default/tool', 'shop/web-1', 'shop/web-2'])
    expect(r.failed).toEqual([])
    expect(server.list('pods')).toHaveLength(0)
  })

  it('drain: PDB chặn tới hết giờ → báo pod nào còn bị chặn', async () => {
    const server = await api()
    const { run } = await setup(server)
    const saved = drainRetry.ms
    drainRetry.ms = 50
    cleanups.push(() => {
      drainRetry.ms = saved
    })
    server.blockEvictions(1000)
    const r = await run<DrainResult>({
      op: 'drain',
      node: 'node-1',
      force: true,
      timeoutSeconds: 1
    })
    expect(r.evicted).toEqual([])
    expect(r.failed).toHaveLength(3)
    expect(r.failed[0]).toMatch(/PodDisruptionBudget/)
  })

  it('Secret: lưu YAML có giá trị bị ẩn (rỗng) không xoá giá trị thật (replace lẫn server-side apply)', async () => {
    const server = await api()
    const { run } = await setup(server)
    const yaml = await run<string>({
      op: 'get',
      kind: 'secrets',
      namespace: 'shop',
      name: 'db',
      format: 'yaml'
    })
    expect(yaml).toContain('password: ""')
    expect(yaml).toContain('shellhouse.io/masked-keys: password')
    await run({ op: 'apply', yaml: yaml.replace('name: db', 'name: db\n  labels:\n    a: b') })
    const after = server.get('secrets', 'shop', 'db')
    expect(after?.data?.['password']).toBe(Buffer.from('s3cr3t').toString('base64'))
    expect(after?.metadata.labels).toEqual({ a: 'b' })
    // Annotation đánh dấu không bao giờ lên cluster.
    expect((after?.metadata as { annotations?: unknown } | undefined)?.annotations).toBeUndefined()
    await run({
      op: 'serverApply',
      yaml: `apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: shop\n  annotations:\n    shellhouse.io/masked-keys: password\ndata:\n  password: ''\n  user: ${Buffer.from('root').toString('base64')}\n`
    })
    const ssa = server.get('secrets', 'shop', 'db')
    expect(ssa?.data?.['password']).toBe(Buffer.from('s3cr3t').toString('base64'))
    expect(ssa?.data?.['user']).toBe(Buffer.from('root').toString('base64'))
    expect((ssa?.metadata as { annotations?: unknown } | undefined)?.annotations).toBeUndefined()
    // YAML không từ Shellhouse (không đánh dấu): "" là người dùng muốn rỗng thật.
    await run({
      op: 'serverApply',
      yaml: `apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: shop\ndata:\n  password: ''\n`
    })
    expect(server.get('secrets', 'shop', 'db')?.data?.['password']).toBe('')
    // Có đánh dấu nhưng khoá "user" không bị ẩn → rỗng thật.
    await run({
      op: 'serverApply',
      yaml: `apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: shop\n  annotations:\n    shellhouse.io/masked-keys: password\ndata:\n  user: ''\n`
    })
    expect(server.get('secrets', 'shop', 'db')?.data?.['user']).toBe('')
  })

  it('Helm: list chỉ metadata, chỉ GET revision mới nhất', async () => {
    const server = await api()
    const { run } = await setup(server)
    for (const [revision, status] of [
      [1, 'superseded'],
      [2, 'deployed']
    ] as const) {
      const record = { name: 'shop-db', namespace: 'shop', version: revision, info: { status } }
      server.upsert('secrets', {
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'helm.sh/release.v1',
        metadata: {
          name: `sh.helm.release.v1.shop-db.v${revision}`,
          namespace: 'shop',
          labels: { owner: 'helm', name: 'shop-db', version: String(revision), status }
        },
        data: {
          release: Buffer.from(Buffer.from(JSON.stringify(record)).toString('base64')).toString(
            'base64'
          )
        }
      })
    }
    const releases = await run<HelmRelease[]>({ op: 'helm.releases', namespaces: [] })
    expect(releases.map((r) => [r.name, r.revision, r.status])).toEqual([
      ['shop-db', 2, 'deployed']
    ])
    expect(
      server.accepts.some(
        (a) => a.startsWith('/api/v1/secrets ') && a.includes('PartialObjectMetadataList')
      )
    ).toBe(true)
    expect(server.requests.filter((r) => r.includes('/secrets/sh.helm.release'))).toEqual([
      'GET /api/v1/namespaces/shop/secrets/sh.helm.release.v1.shop-db.v2'
    ])
  })

  it('topology: phụ thuộc tra theo tên (không list cả Secret / ConfigMap của namespace)', async () => {
    const server = await api()
    const { run } = await setup(server)
    const t = await run<TopologyResult>({
      op: 'topology',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web'
    })
    const cm = t.nodes.find((n) => n.id === 'configmaps|shop|web-config')
    expect(cm?.missing).toBeUndefined()
    expect(server.requests).toContain('GET /api/v1/namespaces/shop/configmaps/web-config')
    expect(
      server.requests.some((r) =>
        /^GET \/api\/v1\/namespaces\/shop\/(secrets|configmaps)\?/.test(r)
      )
    ).toBe(false)
  })
})
