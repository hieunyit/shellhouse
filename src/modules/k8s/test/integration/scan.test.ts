import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecResult, LimitedSpawn } from '../../../registry/host-types'
import type { ScanResult } from '../../../../shared/trivy'
import { K8sService, type ResolvedClusterConfig } from '../../session-host/service'
import { startApiTestServer, TEST_CA, TOKEN, type ApiTestServer } from '../api-test-server'

/** Quét cấu hình: YAML của đối tượng ra thư mục tạm → `trivy config` → đọc JSON → xoá thư mục. */
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const REPORT = JSON.stringify({
  ArtifactName: '/tmp/some-random-dir',
  Results: [
    {
      Target: 'resource.yaml',
      Class: 'config',
      Misconfigurations: [
        {
          ID: 'KSV014',
          AVDID: 'AVD-KSV-0014',
          Title: 'Root file system is not read-only',
          Message: 'Container should set readOnlyRootFilesystem to true',
          Severity: 'HIGH',
          Status: 'FAIL',
          CauseMetadata: { StartLine: 7 }
        }
      ]
    }
  ]
})

interface Call {
  binary: string
  args: readonly string[]
  yaml: string | null
  dir: string
}

async function setup(
  exec: (call: Call) => ExecResult | Promise<ExecResult>
): Promise<{ server: ApiTestServer; calls: Call[]; run: <T>(op: unknown) => Promise<T> }> {
  const server = await startApiTestServer()
  cleanups.push(() => server.close())
  const calls: Call[] = []
  const spawn: LimitedSpawn = {
    exec: async (binary, args) => {
      const dir = args.at(-1) ?? ''
      const file = `${dir}/resource.yaml`
      const call: Call = {
        binary,
        args,
        dir,
        yaml: existsSync(file) ? readFileSync(file, 'utf8') : null
      }
      calls.push(call)
      return exec(call)
    },
    spawn: () => Promise.reject(new Error('no')),
    openPty: () => Promise.reject(new Error('no')),
    available: () => true
  }
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
    spawn,
    emit: () => undefined,
    log: () => undefined
  })
  cleanups.push(() => {
    s.dispose()
  })
  const run = <T>(op: unknown): Promise<T> => s.run(op, new AbortController().signal) as Promise<T>
  await run({ op: 'connect', ref: { source: 'file:/x', context: 't' }, readOnly: false })
  return { server, calls, run }
}

describe('Kubernetes: quét cấu hình bằng Trivy', () => {
  it('YAML đối tượng → `trivy config` → kết quả; tên đích là đối tượng, thư mục tạm được xoá', async () => {
    const { server, calls, run } = await setup(() => ({ code: 0, stdout: REPORT, stderr: '' }))
    server.seedDemo()
    const r = await run<ScanResult>({
      op: 'scan',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web'
    })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.binary).toBe('trivy')
    expect(call?.args.slice(0, 2)).toEqual(['config', '--quiet'])
    expect(call?.args.at(-2)).toBe('--')
    expect(call?.yaml).toContain('kind: Deployment')
    expect(call?.yaml).toContain('name: web')
    // Không lộ đường dẫn thư mục tạm ra giao diện.
    expect(r.target).toBe('Deployment shop/web')
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ id: 'AVD-KSV-0014', severity: 'HIGH', line: 7 })
    expect(existsSync(call?.dir ?? '')).toBe(false)
    expect(
      readdirSync(call?.dir.replace(/[^/]+$/, '') ?? '/').includes(call?.dir.split('/').pop() ?? '')
    ).toBe(false)
  })

  it('Secret không được quét — không gọi Trivy, không đọc đối tượng', async () => {
    const { server, calls, run } = await setup(() => ({ code: 0, stdout: REPORT, stderr: '' }))
    server.seedDemo()
    const before = server.requests.length
    await expect(
      run({ op: 'scan', kind: 'secrets', namespace: 'shop', name: 'whatever' })
    ).rejects.toThrow(/Secrets are not scanned/)
    expect(calls).toHaveLength(0)
    expect(server.requests.slice(before).some((q) => /\/secrets/.test(q))).toBe(false)
  })

  it('Trivy lỗi → báo lỗi và vẫn xoá thư mục tạm', async () => {
    const { server, calls, run } = await setup(() => ({
      code: 2,
      stdout: '',
      stderr: 'FATAL bad things\n'
    }))
    server.seedDemo()
    await expect(
      run({ op: 'scan', kind: 'deployments.apps', namespace: 'shop', name: 'web' })
    ).rejects.toThrow(/Trivy failed: FATAL bad things/)
    expect(existsSync(calls[0]?.dir ?? '')).toBe(false)
  })

  it('đối tượng không có → lỗi của API, không chạy Trivy', async () => {
    const { server, calls, run } = await setup(() => ({ code: 0, stdout: REPORT, stderr: '' }))
    server.seedDemo()
    await expect(
      run({ op: 'scan', kind: 'deployments.apps', namespace: 'shop', name: 'nope' })
    ).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
