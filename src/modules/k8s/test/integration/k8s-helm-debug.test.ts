import { connect, type Socket } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { LimitedSpawn } from '../../../registry/host-types'
import { K8sService, type ResolvedClusterConfig } from '../../session-host/service'
import { decodeHelmRelease } from '../../session-host/operations'
import { debugWait } from '../../session-host/debug'
import type {
  DiffItem,
  HelmActionResult,
  HelmReleaseDetail,
  HelmRevisionDetail
} from '../../shared/ops'
import { startApiTestServer, TEST_CA, TOKEN, type ApiTestServer } from '../api-test-server'

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

async function setup(readOnly = false): Promise<{
  server: ApiTestServer
  service: K8sService
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
  const service = new K8sService({
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
    service.dispose()
  })
  const run = <T>(op: unknown): Promise<T> =>
    service.run(op, new AbortController().signal) as Promise<T>
  await run({ op: 'connect', ref: { source: 'file:/x', context: 't' }, readOnly })
  return { server, service, run }
}

// ——— Helm ———

const MANIFEST_V1 = `---
# Source: app/templates/cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  mode: v1
---
# Source: app/templates/svc.yaml
apiVersion: v1
kind: Service
metadata:
  name: app
spec:
  ports:
    - port: 80
`
const MANIFEST_V2 = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  mode: v2
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-extra
data:
  added: in-v2
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-keep
  annotations:
    helm.sh/resource-policy: keep
data:
  keep: me
`

function seedRelease(server: ApiTestServer, statusOfLatest = 'deployed'): void {
  const put = (revision: number, status: string, manifest: string, config: object): void => {
    const record = {
      name: 'app',
      namespace: 'shop',
      version: revision,
      info: {
        status,
        first_deployed: '2026-09-01T10:00:00Z',
        last_deployed: `2026-09-0${String(revision)}T10:00:00Z`,
        deleted: '',
        description: revision === 1 ? 'Install complete' : 'Upgrade complete',
        notes: `notes v${String(revision)}`
      },
      chart: {
        metadata: { name: 'app', version: `1.${String(revision)}.0`, appVersion: '2.0' },
        values: { replicaCount: 1, image: { repository: 'nginx', tag: 'stable' } }
      },
      config,
      manifest,
      hooks: [
        { name: 'app-migrate', kind: 'Job', events: ['pre-upgrade', 'pre-rollback'] },
        { name: 'app-cleanup', kind: 'Job', events: ['post-delete'] }
      ],
      labels: { team: 'shop' }
    }
    const inner = gzipSync(Buffer.from(JSON.stringify(record))).toString('base64')
    server.upsert('secrets', {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'helm.sh/release.v1',
      metadata: {
        name: `sh.helm.release.v1.app.v${String(revision)}`,
        namespace: 'shop',
        labels: { owner: 'helm', name: 'app', version: String(revision), status }
      },
      data: { release: Buffer.from(inner).toString('base64') }
    })
  }
  put(1, 'superseded', MANIFEST_V1, { image: { tag: '1.0' } })
  put(2, statusOfLatest, MANIFEST_V2, { image: { tag: '2.0' }, auth: { password: 's3cret' } })
  // Trạng thái trên cluster = revision 2.
  for (const [name, data, annotations] of [
    ['app-config', { mode: 'v2' }, {}],
    ['app-extra', { added: 'in-v2' }, {}],
    ['app-keep', { keep: 'me' }, { 'helm.sh/resource-policy': 'keep' }]
  ] as const)
    server.upsert('configmaps', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name,
        namespace: 'shop',
        annotations,
        managedFields: [{ manager: 'helm', operation: 'Update', fieldsV1: {} }]
      } as never,
      data
    })
}

const recordOf = (server: ApiTestServer, revision: number) => {
  const sec = server.get('secrets', 'shop', `sh.helm.release.v1.app.v${String(revision)}`)
  return sec?.data?.['release'] ? { sec, record: decodeHelmRelease(sec.data['release']) } : null
}

describe('K8s — Helm rollback / uninstall (không cần helm CLI)', () => {
  it('revision: values người dùng, values gộp với chart, manifest, hook', async () => {
    const { server, run } = await setup()
    seedRelease(server)
    const r = await run<HelmRevisionDetail>({
      op: 'helm.revision',
      namespace: 'shop',
      name: 'app',
      revision: 1
    })
    expect(r.revision).toBe(1)
    expect(r.chartVersion).toBe('1.1.0')
    expect(r.values).toBe('image:\n  tag: "1.0"\n')
    // Values gộp: mặc định của chart + ghi đè của người dùng (map gộp sâu).
    expect(r.computedValues).toContain('repository: nginx')
    expect(r.computedValues).toContain('tag: "1.0"')
    expect(r.computedValues).toContain('replicaCount: 1')
    expect(r.manifest).toContain('mode: v1')
    expect(r.notes).toBe('notes v1')
    expect(r.hooks.map((h) => h.name)).toEqual(['app-migrate', 'app-cleanup'])
    await expect(
      run({ op: 'helm.revision', namespace: 'shop', name: 'app', revision: 9 })
    ).rejects.toThrow(/Revision 9 of app was not found/)
  })

  it('rollback: revision mới từ manifest cũ (SSA manager helm), xoá tài nguyên thừa, giữ resource-policy keep, cập nhật trạng thái', async () => {
    const { server, run } = await setup()
    seedRelease(server)
    const res = await run<HelmActionResult>({
      op: 'helm.rollback',
      namespace: 'shop',
      name: 'app',
      revision: 1
    })
    expect(res.revision).toBe(3)
    expect(res.failed).toEqual([])
    expect(res.applied).toEqual(['shop/configmap/app-config', 'shop/service/app'])
    expect(res.deleted).toEqual(['shop/configmap/app-extra'])
    expect(res.kept).toEqual(['shop/configmap/app-keep'])
    expect(res.hooksSkipped).toBe(1)

    // Tài nguyên trên cluster.
    expect(server.get('configmaps', 'shop', 'app-config')?.data).toEqual({ mode: 'v1' })
    expect(server.get('services', 'shop', 'app')).toBeDefined()
    expect(server.get('configmaps', 'shop', 'app-extra')).toBeUndefined()
    expect(server.get('configmaps', 'shop', 'app-keep')).toBeDefined()
    const svc = server.get('services', 'shop', 'app') as unknown as {
      metadata: { labels: Record<string, string>; annotations: Record<string, string> }
    }
    expect(svc.metadata.labels['app.kubernetes.io/managed-by']).toBe('Helm')
    expect(svc.metadata.annotations['meta.helm.sh/release-name']).toBe('app')
    expect(
      server.requests.some(
        (r) =>
          r.startsWith('PATCH /api/v1/namespaces/shop/configmaps/app-config?') &&
          r.includes('fieldManager=helm') &&
          r.includes('force=true')
      )
    ).toBe(true)

    // Bản ghi: v3 deployed (mang chart / values / manifest của v1), v2 superseded.
    const v3 = recordOf(server, 3)
    expect(v3?.sec.metadata.labels).toMatchObject({
      owner: 'helm',
      name: 'app',
      version: '3',
      status: 'deployed'
    })
    expect(v3?.sec['type']).toBe('helm.sh/release.v1')
    expect(v3?.record).toMatchObject({
      name: 'app',
      namespace: 'shop',
      version: 3,
      manifest: MANIFEST_V1,
      config: { image: { tag: '1.0' } },
      labels: { team: 'shop' },
      info: {
        status: 'deployed',
        description: 'Rollback to 1',
        first_deployed: '2026-09-01T10:00:00Z',
        notes: 'notes v1'
      }
    })
    expect(recordOf(server, 2)?.record.info?.status).toBe('superseded')
    expect(recordOf(server, 2)?.sec.metadata.labels?.['status']).toBe('superseded')

    // Chi tiết release đọc lại được (như helm history).
    const detail = await run<HelmReleaseDetail>({
      op: 'helm.release',
      namespace: 'shop',
      name: 'app'
    })
    expect(detail.history.map((h) => [h.revision, h.status])).toEqual([
      [3, 'deployed'],
      [2, 'superseded'],
      [1, 'superseded']
    ])
  })

  it('rollback: đang có thao tác khác (pending-upgrade) → từ chối, không ghi gì', async () => {
    const { server, run } = await setup()
    seedRelease(server, 'pending-upgrade')
    await expect(
      run({ op: 'helm.rollback', namespace: 'shop', name: 'app', revision: 1 })
    ).rejects.toThrow(/pending-upgrade/)
    expect(recordOf(server, 3)).toBeNull()
    expect(server.get('configmaps', 'shop', 'app-extra')).toBeDefined()
  })

  it('uninstall: xoá tài nguyên + bản ghi, giữ resource-policy keep; keepHistory → uninstalled', async () => {
    const { server, run } = await setup()
    seedRelease(server)
    const kept = await run<HelmActionResult>({
      op: 'helm.uninstall',
      namespace: 'shop',
      name: 'app',
      keepHistory: true
    })
    expect(kept.deleted.sort()).toEqual(['shop/configmap/app-config', 'shop/configmap/app-extra'])
    expect(kept.kept).toEqual(['shop/configmap/app-keep'])
    expect(kept.hooksSkipped).toBe(1)
    expect(recordOf(server, 2)?.record.info).toMatchObject({
      status: 'uninstalled',
      description: 'Uninstallation complete'
    })
    expect(recordOf(server, 1)).not.toBeNull()

    // Gỡ hẳn (đã uninstalled, còn lịch sử) → xoá bản ghi.
    const purged = await run<HelmActionResult>({
      op: 'helm.uninstall',
      namespace: 'shop',
      name: 'app',
      keepHistory: false
    })
    expect(purged.failed).toEqual([])
    expect(recordOf(server, 1)).toBeNull()
    expect(recordOf(server, 2)).toBeNull()
    expect(server.get('configmaps', 'shop', 'app-keep')).toBeDefined()
    await expect(run({ op: 'helm.release', namespace: 'shop', name: 'app' })).rejects.toThrow(
      /not found/
    )
  })

  it('chế độ chỉ đọc chặn rollback / uninstall / debug', async () => {
    const { server, run } = await setup(true)
    seedRelease(server)
    for (const op of [
      { op: 'helm.rollback', namespace: 'shop', name: 'app', revision: 1 },
      { op: 'helm.uninstall', namespace: 'shop', name: 'app', keepHistory: false },
      { op: 'debug.ephemeral', namespace: 'shop', pod: 'web-1', image: 'busybox' },
      { op: 'debug.node', node: 'node-1', image: 'busybox', namespace: 'default' }
    ])
      await expect(run(op)).rejects.toThrow(/Read-only/)
    // Đọc vẫn được.
    await expect(
      run({ op: 'helm.revision', namespace: 'shop', name: 'app', revision: 2 })
    ).resolves.toBeTruthy()
  })
})

// ——— Xem trước thay đổi (dry run) ———

describe('K8s — diff trước khi áp dụng (dryRun=All)', () => {
  it('apply: bản trên cluster vs kết quả, không ghi gì; đối tượng mới → live null; bỏ nhiễu', async () => {
    const { server, run } = await setup()
    server.upsert('configmaps', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'web-config', namespace: 'shop' },
      data: { color: 'blue' }
    })
    const before = server.get('configmaps', 'shop', 'web-config')?.metadata.resourceVersion
    const items = await run<DiffItem[]>({
      op: 'diff',
      mode: 'apply',
      yaml: [
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-config\ndata:\n  color: green\n',
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: brand-new\ndata:\n  a: "1"\n'
      ].join('---\n')
    })
    expect(items.map((i) => i.object)).toEqual([
      'shop/configmap/web-config',
      'shop/configmap/brand-new'
    ])
    expect(items[0]?.live).toContain('color: blue')
    expect(items[0]?.result).toContain('color: green')
    expect(items[0]?.result).not.toContain('managedFields')
    expect(items[0]?.result).not.toContain('resourceVersion')
    expect(items[1]?.live).toBeNull()
    expect(items[1]?.result).toContain('name: brand-new')
    // Không ghi gì.
    expect(server.get('configmaps', 'shop', 'web-config')?.data).toEqual({ color: 'blue' })
    expect(server.get('configmaps', 'shop', 'web-config')?.metadata.resourceVersion).toBe(before)
    expect(server.get('configmaps', 'shop', 'brand-new')).toBeUndefined()
    expect(server.requests.filter((r) => r.includes('dryRun=All'))).toHaveLength(2)
  })

  it('replace: resourceVersion cũ → báo xung đột; Secret không lộ giá trị', async () => {
    const { server, run } = await setup()
    server.upsert('secrets', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'db', namespace: 'shop' },
      data: { password: Buffer.from('old').toString('base64') }
    })
    const live = server.get('secrets', 'shop', 'db')
    const yaml = (rv: string, value: string): string =>
      `apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: shop\n  resourceVersion: "${rv}"\ndata:\n  password: ${Buffer.from(value).toString('base64')}\n`
    const [ok] = await run<DiffItem[]>({
      op: 'diff',
      mode: 'replace',
      yaml: yaml(live?.metadata.resourceVersion ?? '', 'new')
    })
    expect(ok?.error).toBeUndefined()
    expect(ok?.live).toMatch(/password: <hidden sha256:[0-9a-f]{12}>/)
    expect(ok?.live).not.toBe(ok?.result)
    expect(`${ok?.live ?? ''}${ok?.result ?? ''}`).not.toContain(
      Buffer.from('new').toString('base64')
    )
    const [stale] = await run<DiffItem[]>({ op: 'diff', mode: 'replace', yaml: yaml('1', 'new') })
    expect(stale?.error).toMatch(/Someone changed this object/)
  })
})

// ——— kubectl debug ———

describe('K8s — debug (ephemeral container, pod debug node)', () => {
  it('ephemeral: PATCH ephemeralcontainers (target container), chờ chạy; image hỏng → báo lỗi', async () => {
    const { server, run } = await setup()
    debugWait.pollMs = 20
    const { container } = await run<{ container: string }>({
      op: 'debug.ephemeral',
      namespace: 'shop',
      pod: 'web-1',
      image: 'busybox:1.36',
      target: 'app'
    })
    expect(container).toMatch(/^debugger-[0-9a-f]{5}$/)
    const pod = server.get('pods', 'shop', 'web-1') as unknown as {
      spec: { ephemeralContainers: Record<string, unknown>[] }
    }
    expect(pod.spec.ephemeralContainers[0]).toMatchObject({
      name: container,
      image: 'busybox:1.36',
      stdin: true,
      tty: true,
      targetContainerName: 'app'
    })
    await expect(
      run({ op: 'debug.ephemeral', namespace: 'shop', pod: 'web-1', image: 'missing/image' })
    ).rejects.toThrow(/ErrImagePull/)
  })

  it('node: pod đặc quyền trên node (hostPID / hostNetwork, / ở /host), terminal attach có hướng dẫn', async () => {
    const { server, service, run } = await setup()
    debugWait.pollMs = 20
    const r = await run<{ namespace: string; pod: string; container: string }>({
      op: 'debug.node',
      node: 'node-1',
      image: 'busybox',
      namespace: 'default'
    })
    expect(r.pod).toMatch(/^node-debugger-node-1-[0-9a-f]{5}$/)
    const pod = server.get('pods', 'default', r.pod) as unknown as {
      metadata: { labels: Record<string, string> }
      spec: Record<string, unknown> & { containers: Record<string, unknown>[] }
    }
    expect(pod.spec).toMatchObject({
      nodeName: 'node-1',
      hostPID: true,
      hostNetwork: true,
      tolerations: [{ operator: 'Exists' }],
      volumes: [{ name: 'host-root', hostPath: { path: '/' } }]
    })
    expect(pod.spec.containers[0]).toMatchObject({
      securityContext: { privileged: true },
      volumeMounts: [{ name: 'host-root', mountPath: '/host' }]
    })
    expect(pod.metadata.labels['shellhouse.dev/debug']).toBe('node')

    let output = ''
    const t = await service.openTerminal(
      {
        ref: { source: 'file:/x', context: 't' },
        namespace: r.namespace,
        pod: r.pod,
        container: r.container,
        attach: true,
        banner: 'Run chroot /host'
      },
      { cols: 80, rows: 24 },
      {
        onData: (d) => {
          output += Buffer.from(d).toString('utf8')
        },
        onExit: () => undefined
      }
    )
    const deadline = Date.now() + 5000
    while (!output.includes('attached: debugger') && Date.now() < deadline)
      await new Promise((res) => setTimeout(res, 20))
    expect(output).toContain('Run chroot /host')
    expect(output).toContain('attached: debugger')
    expect(
      server.requests.some((q) =>
        q.startsWith(`WS /api/v1/namespaces/default/pods/${r.pod}/attach`)
      )
    ).toBe(true)
    t.close()
  })
})
