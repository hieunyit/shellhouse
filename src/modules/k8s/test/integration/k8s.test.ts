import { connect, type Socket } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerMessage } from '@shared/stream-protocol'
import { HostModuleRegistry } from '../../../registry/session-host'
import { Session } from '../../../../session-host/session/session'
import { FakePort } from '../../../../../test/integration/fake-port'
import { startTestSshServer } from '../../../../../test/integration/ssh-test-server'
import { tempDir } from '../../../../../test/unit/helpers'
import type { LimitedSpawn } from '../../../registry/host-types'
import { K8sService, watchRetry, type ResolvedClusterConfig } from '../../session-host/service'
import { k8sHost } from '../../session-host'
import type { DiscoveredKind, PortForwardInfo } from '../../shared/ops'
import type { K8sObject } from '../../shared/resources'
import { startApiTestServer, TEST_CA, TOKEN, type ApiTestServer } from '../api-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function api(tls = true): Promise<ApiTestServer> {
  const s = await startApiTestServer({ tls })
  cleanups.push(() => s.close())
  return s
}

const noSpawn: LimitedSpawn = {
  exec: () => Promise.reject(new Error('no spawn')),
  spawn: () => Promise.reject(new Error('no spawn')),
  openPty: () => Promise.reject(new Error('no spawn')),
  available: () => false
}

function cluster(
  server: ApiTestServer,
  extra: Partial<ResolvedClusterConfig> = {}
): ResolvedClusterConfig {
  return {
    name: 'test',
    server: server.url,
    ca: TEST_CA,
    insecure: false,
    namespace: 'shop',
    auth: { token: TOKEN },
    ...extra
  }
}

function service(config: ResolvedClusterConfig) {
  const events: { event: string; data: unknown }[] = []
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
    emit: (event, data) => events.push({ event, data }),
    log: () => undefined
  })
  cleanups.push(() => {
    s.dispose()
  })
  const run = <T>(op: unknown): Promise<T> => s.run(op, new AbortController().signal) as Promise<T>
  const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline)
        throw new Error(`timeout; events: ${JSON.stringify(events.map((e) => e.event))}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return { s, run, events, until }
}

const ref = { source: 'file:~/.kube/config', context: 'test' }

describe('Kubernetes qua API server giả (HTTPS, chứng chỉ test)', () => {
  it('TLS kiểm theo CA của kubeconfig: CA đúng → được; không có CA → từ chối; insecure-skip → được', async () => {
    const server = await api()
    const good = service(cluster(server))
    expect(await good.run({ op: 'connect', ref, readOnly: false })).toEqual({
      version: 'v1.31.2',
      namespace: 'shop'
    })
    const noCa = service(cluster(server, { ca: undefined }))
    await expect(noCa.run({ op: 'connect', ref, readOnly: false })).rejects.toThrow(/certificate/i)
    const insecure = service(cluster(server, { ca: undefined, insecure: true }))
    await expect(insecure.run({ op: 'connect', ref, readOnly: false })).resolves.toMatchObject({
      version: 'v1.31.2'
    })
    // tls-server-name: kiểm theo tên khác địa chỉ (chứng chỉ có DNS:kubernetes.test).
    const named = service(cluster(server, { tlsServerName: 'kubernetes.test' }))
    await expect(named.run({ op: 'connect', ref, readOnly: false })).resolves.toBeTruthy()
    const wrongName = service(cluster(server, { tlsServerName: 'other.test' }))
    await expect(wrongName.run({ op: 'connect', ref, readOnly: false })).rejects.toThrow()
    // Sai token → câu dễ hiểu.
    const badToken = service(cluster(server, { auth: { token: 'nope' } }))
    await expect(badToken.run({ op: 'connect', ref, readOnly: false })).rejects.toThrow(
      /did not accept your credentials/
    )
  })

  it('discovery (CRD, ẩn loại không có quyền), namespace, list có phân trang, bỏ managedFields, secret ẩn giá trị', async () => {
    const server = await api()
    const { run } = service(cluster(server))
    await run({ op: 'connect', ref, readOnly: false })
    const kinds = await run<DiscoveredKind[]>({ op: 'discover', namespace: 'restricted' })
    expect(kinds.find((k) => k.id === 'widgets.example.com')).toMatchObject({
      namespaced: true,
      forbidden: false
    })
    expect(kinds.find((k) => k.id === 'secrets')?.forbidden).toBe(true)
    expect(kinds.some((k) => k.id.includes('/'))).toBe(false)
    expect(await run({ op: 'namespaces' })).toEqual({
      names: ['default', 'restricted', 'shop'],
      canList: true
    })

    const page1 = await run<{ items: K8sObject[]; continue: string | null }>({
      op: 'list',
      kind: 'pods',
      namespace: 'shop',
      limit: 1
    })
    expect(page1.items.map((p) => p.metadata.name)).toEqual(['web-1'])
    expect(page1.items[0]?.metadata).not.toHaveProperty('managedFields')
    const page2 = await run<{ items: K8sObject[]; continue: string | null }>({
      op: 'list',
      kind: 'pods',
      namespace: 'shop',
      limit: 1,
      continue: page1.continue ?? ''
    })
    expect(page2.items.map((p) => p.metadata.name)).toEqual(['web-2'])
    expect(page2.continue).toBeNull()

    const secrets = await run<{ items: K8sObject[] }>({
      op: 'list',
      kind: 'secrets',
      namespace: 'shop',
      limit: 10
    })
    expect(secrets.items[0]?.data).toEqual({ password: '', user: '' })
    expect(await run({ op: 'secret.reveal', namespace: 'shop', name: 'db', key: 'password' })).toBe(
      's3cr3t'
    )
    await expect(
      run({ op: 'list', kind: 'secrets', namespace: 'restricted', limit: 10 })
    ).rejects.toThrow("You can't list secrets in namespace restricted")
    const yaml = await run<string>({
      op: 'get',
      kind: 'secrets',
      namespace: 'shop',
      name: 'db',
      format: 'yaml'
    })
    expect(yaml).not.toContain(Buffer.from('s3cr3t').toString('base64'))
  })

  it('watch dùng chung, gửi theo lô; 410 Gone → báo list lại', async () => {
    const server = await api()
    const { run, events, until } = service(cluster(server))
    await run({ op: 'connect', ref, readOnly: false })
    const list = await run<{ resourceVersion: string }>({
      op: 'list',
      kind: 'pods',
      namespace: 'shop',
      limit: 100
    })
    const a = await run<{ subscription: string }>({
      op: 'watch',
      kind: 'pods',
      namespace: 'shop',
      resourceVersion: list.resourceVersion
    })
    const b = await run<{ subscription: string }>({
      op: 'watch',
      kind: 'pods',
      namespace: 'shop',
      resourceVersion: list.resourceVersion
    })
    await new Promise((r) => setTimeout(r, 150))
    server.upsert('pods', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web-3', namespace: 'shop' }
    })
    server.remove('pods', 'shop', 'web-2')
    await until(() => events.filter((e) => e.event === 'watch').length >= 2)
    const got = events
      .filter((e) => e.event === 'watch')
      .map((e) => e.data as { subscription: string; events: { type: string }[] })
    expect(new Set(got.map((g) => g.subscription))).toEqual(
      new Set([a.subscription, b.subscription])
    )
    expect(got[0]?.events.map((e) => e.type)).toEqual(['ADDED', 'DELETED'])
    // Chỉ một luồng watch tới server cho hai người xem.
    expect(server.requests.filter((r) => r.includes('watch=true')).length).toBe(1)

    events.length = 0
    server.expireWatches()
    await until(() =>
      events.some((e) => e.event === 'watch' && (e.data as { relist?: boolean }).relist === true)
    )
  })

  it('proxy cắt ngang luồng watch nhiều lần (Rancher…): nối lại im lặng, không báo lỗi, không mất sự kiện', async () => {
    const saved = { ...watchRetry }
    watchRetry.baseMs = 5
    try {
      const server = await api()
      const { run, events, until } = service(cluster(server))
      await run({ op: 'connect', ref, readOnly: false })
      const list = await run<{ resourceVersion: string }>({
        op: 'list',
        kind: 'pods',
        namespace: 'shop',
        limit: 100
      })
      await run({
        op: 'watch',
        kind: 'pods',
        namespace: 'shop',
        resourceVersion: list.resourceVersion
      })
      const watchData = () =>
        events
          .filter((e) => e.event === 'watch')
          .map(
            (e) =>
              e.data as {
                error?: string
                relist?: boolean
                events: { object: { metadata: { name: string } } }[]
              }
          )
      for (let i = 0; i < 6; i++) {
        await until(() => server.requests.filter((r) => r.includes('watch=true')).length > i)
        await new Promise((r) => setTimeout(r, 30))
        server.upsert('pods', {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: `cut-${i}`, namespace: 'shop' }
        })
        await until(() =>
          watchData().some((d) => d.events.some((e) => e.object.metadata.name === `cut-${i}`))
        )
        server.cutWatches()
      }
      expect(watchData().filter((d) => d.error || d.relist)).toEqual([])
    } finally {
      Object.assign(watchRetry, saved)
    }
  })

  it('log follow bị proxy cắt ngang: theo dõi tiếp từ lúc cắt (sinceTime), không gửi lại phần đầu, không báo hết', async () => {
    const server = await api()
    const { run, events, until } = service(cluster(server))
    await run({ op: 'connect', ref, readOnly: false })
    await run({
      op: 'logs.subscribe',
      namespace: 'shop',
      pod: 'web-1',
      container: 'app',
      previous: false,
      tail: 100,
      timestamps: false
    })
    const text = () =>
      events
        .filter((e) => e.event === 'logs')
        .map((e) => (e.data as { text: string }).text)
        .join('')
    await until(() => text().includes('log line 1 from web-1'))
    server.cutLogs()
    await until(() => text().includes('resumed web-1'))
    expect(text().split('log line 1 from web-1').length).toBe(2)
    expect(events.some((e) => e.event === 'logs-end')).toBe(false)
    expect(server.requests.some((r) => r.includes('/log?') && r.includes('sinceTime='))).toBe(true)
  })

  it('watch mất kết nối lâu: báo lỗi một lần, vẫn thử lại; nối lại được → báo list lại', async () => {
    const saved = { ...watchRetry }
    watchRetry.baseMs = 5
    watchRetry.maxMs = 20
    try {
      const server = await api()
      const { run, events, until } = service(cluster(server))
      await run({ op: 'connect', ref, readOnly: false })
      const list = await run<{ resourceVersion: string }>({
        op: 'list',
        kind: 'pods',
        namespace: 'shop',
        limit: 100
      })
      await run({
        op: 'watch',
        kind: 'pods',
        namespace: 'shop',
        resourceVersion: list.resourceVersion
      })
      await new Promise((r) => setTimeout(r, 100))
      server.failWatches(7)
      const watchData = () =>
        events
          .filter((e) => e.event === 'watch')
          .map((e) => e.data as { error?: string; relist?: boolean })
      await until(() => watchData().some((d) => d.error))
      expect(watchData().filter((d) => d.error)).toHaveLength(1)
      // Server ổn lại: sự kiện đầu tiên tới → renderer được báo list lại (không treo bảng).
      await until(() => server.requests.filter((r) => r.includes('watch=true')).length >= 9)
      await new Promise((r) => setTimeout(r, 50))
      server.upsert('pods', {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'back', namespace: 'shop' }
      })
      await until(() => watchData().some((d) => d.relist))
    } finally {
      Object.assign(watchRetry, saved)
    }
  })

  it('replace có kiểm resourceVersion (xung đột → báo), scale, restart; chỉ đọc chặn thay đổi', async () => {
    const server = await api()
    const { run } = service(cluster(server))
    await run({ op: 'connect', ref, readOnly: false })
    const yaml = await run<string>({
      op: 'get',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web',
      format: 'yaml'
    })
    await run({
      op: 'scale',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web',
      replicas: 5
    })
    // YAML cũ (resourceVersion trước khi scale) → xung đột, không ghi đè.
    await expect(run({ op: 'apply', yaml })).rejects.toThrow(/Someone changed this object/)
    const fresh = await run<string>({
      op: 'get',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web',
      format: 'yaml'
    })
    expect(fresh).toContain('replicas: 5')
    await run({ op: 'apply', yaml: fresh.replace('replicas: 5', 'replicas: 3') })
    expect(
      await run<string>({
        op: 'get',
        kind: 'deployments.apps',
        namespace: 'shop',
        name: 'web',
        format: 'yaml'
      })
    ).toContain('replicas: 3')
    await run({ op: 'rolloutRestart', kind: 'deployments.apps', namespace: 'shop', name: 'web' })
    expect(
      server.requests.some((r) =>
        r.startsWith('PATCH /apis/apps/v1/namespaces/shop/deployments/web')
      )
    ).toBe(true)

    await run({ op: 'connect', ref, readOnly: true })
    await expect(
      run({ op: 'delete', kind: 'pods', namespace: 'shop', name: 'web-1' })
    ).rejects.toThrow(/Read-only/)
    await expect(
      run({ op: 'scale', kind: 'deployments.apps', namespace: 'shop', name: 'web', replicas: 0 })
    ).rejects.toThrow(/Read-only/)
  })

  it('sửa YAML bằng editor: lưu file → áp dụng; lưu nối tiếp vẫn được; người khác sửa → báo xung đột', async () => {
    const server = await api()
    const { run, events, until } = service(cluster(server))
    await run({ op: 'connect', ref, readOnly: false })
    const file = join(tempDir(), 'web.yaml')
    await run({
      op: 'edit',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web',
      localPath: file
    })
    writeFileSync(file, readFileSync(file, 'utf8').replace('replicas: 2', 'replicas: 4'))
    await until(() => events.some((e) => e.event === 'edit'), 8000)
    expect(events.at(-1)?.data).toMatchObject({ ok: true })
    writeFileSync(file, readFileSync(file, 'utf8').replace('replicas: 4', 'replicas: 6'))
    await until(() => events.filter((e) => e.event === 'edit').length >= 2, 8000)
    expect(events.at(-1)?.data).toMatchObject({ ok: true })
    // Ai đó scale trên cluster → lần lưu sau bị từ chối.
    await run({
      op: 'scale',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web',
      replicas: 1
    })
    writeFileSync(file, readFileSync(file, 'utf8').replace('replicas: 6', 'replicas: 9'))
    await until(() => events.filter((e) => e.event === 'edit').length >= 3, 8000)
    expect(events.at(-1)?.data).toMatchObject({
      ok: false,
      error: expect.stringContaining('Someone changed') as unknown
    })
  }, 30_000)

  it('log theo luồng; exec qua WebSocket (stdin, resize, thoát); port-forward (pod và service → targetPort theo tên)', async () => {
    const server = await api()
    const { s, run, events, until } = service(cluster(server))
    await run({ op: 'connect', ref, readOnly: false })
    await run({
      op: 'logs.subscribe',
      namespace: 'shop',
      pod: 'web-1',
      container: 'app',
      previous: false,
      tail: 10,
      timestamps: false
    })
    await until(() =>
      events.some((e) => e.event === 'logs' && (e.data as { text: string }).text.includes('tick'))
    )
    expect(events.find((e) => e.event === 'logs')?.data).toMatchObject({
      text: expect.stringContaining('log line 1 from web-1') as unknown
    })

    let output = ''
    let exit: number | null | undefined
    const t = await s.openTerminal(
      { ref, namespace: 'shop', pod: 'web-1', container: 'app' },
      { cols: 100, rows: 30 },
      {
        onData: (d) => {
          output += Buffer.from(d).toString('utf8')
        },
        onExit: (e) => {
          exit = e.code
        }
      }
    )
    await until(() => output.includes('[resize {"Width":100,"Height":30}]'))
    expect(output).toContain('exec: sh -c command -v bash')
    t.write('echo hi\r')
    await until(() => output.includes('echo hi'))
    t.write('exit\r')
    await until(() => exit !== undefined)
    expect(exit).toBe(0)
    expect(
      server.requests.some(
        (r) => r.startsWith('WS /api/v1/namespaces/shop/pods/web-1/exec') && r.includes('tty=true')
      )
    ).toBe(true)

    const [fwd] = await run<PortForwardInfo[]>({
      op: 'portForward',
      namespace: 'shop',
      target: 'service/web',
      ports: [[0, 80]]
    })
    expect(fwd?.localPort).toBeGreaterThan(0)
    const reply = await new Promise<string>((resolve, reject) => {
      const c = connect(fwd?.localPort ?? 0, '127.0.0.1')
      c.once('connect', () => {
        c.write('ping')
      })
      c.once('data', (d) => {
        resolve(d.toString('utf8'))
        c.destroy()
      })
      c.once('error', reject)
    })
    // service/web cổng 80 → targetPort "http" → containerPort 8080 của pod web-*.
    expect(reply).toBe('echo:8080:ping')
    await run({ op: 'portForward.stop', id: fwd?.id })
    expect(await run<PortForwardInfo[]>({ op: 'portForwards' })).toEqual([])
  })
})

describe('Kubernetes qua bastion SSH (direct-tcpip)', () => {
  it('API server chỉ tới được từ bastion: tab gắn module vào SSH, thông tin cluster lấy từ main', async () => {
    const server = await api()
    const ssh = await startTestSshServer([{ username: 'alice', password: 'pw' }])
    cleanups.push(() => ssh.close())
    const asked: unknown[] = []
    const modules = new HostModuleRegistry([k8sHost], {
      log: () => undefined,
      requestProgramGrant: () => Promise.resolve(false),
      requestMain: (module, name, params) => {
        asked.push({ module, name, params })
        return Promise.resolve(cluster(server))
      }
    })
    modules.setEnabled(['k8s'])
    const port = new FakePort()
    const session = new Session(
      'k8s-ssh',
      {
        kind: 'ssh',
        cols: 80,
        rows: 24,
        target: { host: '127.0.0.1', port: ssh.port, username: 'alice' },
        noShell: true
      },
      port,
      {
        log: () => undefined,
        appVersion: 'test',
        hostKeys: { check: () => Promise.resolve({ status: 'match' }), trust: () => undefined },
        onEnded: () => undefined,
        modules,
        sshOverrides: { agent: null, keyFiles: [] }
      },
      { credentials: { password: 'pw' } }
    )
    cleanups.push(() => {
      session.close()
    })
    void session.start()
    port.deliver({ t: 'module-attach', module: 'k8s' })
    port.deliver({ t: 'module', id: 1, module: 'k8s', op: { op: 'connect', ref, readOnly: false } })
    const result = (id: number): Extract<ServerMessage, { t: 'module-result' }> | undefined =>
      port.sent.find(
        (m): m is Extract<ServerMessage, { t: 'module-result' }> =>
          m.t === 'module-result' && m.id === id
      )
    // Thao tác chỉ gửi sau khi connect xong (như tab thật).
    await port.until(() => result(1) !== undefined, 10_000)
    port.deliver({
      t: 'module',
      id: 2,
      module: 'k8s',
      op: { op: 'list', kind: 'pods', namespace: 'shop', limit: 10 }
    })
    await port.until(() => result(2) !== undefined, 10_000)
    expect(result(1)).toMatchObject({ ok: true })
    expect(
      (result(2) as { result: { items: K8sObject[] } }).result.items.map((p) => p.metadata.name)
    ).toEqual(['web-1', 'web-2'])
    expect(asked).toEqual([{ module: 'k8s', name: 'resolve', params: ref }])
    expect(ssh.events.directTcpip).toContainEqual({ destIP: '127.0.0.1', destPort: server.port })
  })
})
