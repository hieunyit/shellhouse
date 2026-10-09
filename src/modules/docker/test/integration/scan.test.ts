import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecOptions, ExecResult } from '../../../registry/host-types'
import { ApiBackend } from '../../session-host/api-backend'
import { EngineClient } from '../../session-host/engine'
import { DockerService } from '../../session-host/service'
import type { ScanResult } from '../../../../shared/trivy'
import { startEngineTestServer } from '../engine-test-server'

/** Quét image: Session Host chạy `trivy image …` qua `scanner`, đọc JSON, báo lỗi dễ hiểu. */
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const REPORT = JSON.stringify({
  ArtifactName: 'nginx:1.21',
  Results: [
    {
      Target: 'nginx:1.21 (debian 11)',
      Vulnerabilities: [
        { VulnerabilityID: 'CVE-1', PkgName: 'openssl', Severity: 'HIGH', FixedVersion: '2' }
      ]
    }
  ]
})

async function setup(
  scanner: ((args: readonly string[], options: ExecOptions) => Promise<ExecResult>) | undefined,
  readOnly = false
): Promise<{ run: <T>(op: unknown) => Promise<T> }> {
  const server = await startEngineTestServer()
  cleanups.push(() => server.close())
  const s = new DockerService({
    cli: {
      exec: () => Promise.reject(new Error('no cli')),
      spawn: () => Promise.reject(new Error('no cli'))
    },
    connect: () =>
      Promise.resolve(
        new ApiBackend(
          new EngineClient(
            () =>
              new Promise<Socket>((resolve, reject) => {
                const socket = connect(server.path)
                socket.once('connect', () => {
                  resolve(socket)
                })
                socket.once('error', reject)
              })
          )
        )
      ),
    openPty: () => Promise.reject(new Error('no pty')),
    emit: () => undefined,
    log: () => undefined,
    ...(scanner ? { scanner } : {})
  })
  cleanups.push(() => {
    s.dispose()
  })
  const run = <T>(op: unknown): Promise<T> => s.run(op, new AbortController().signal) as Promise<T>
  if (readOnly) await run({ op: 'configure', readOnly: true })
  return { run }
}

describe('Docker: quét image bằng Trivy', () => {
  it('gọi `trivy image` đúng tham số (ref sau "--"), trả kết quả đã gọn', async () => {
    const calls: { args: readonly string[]; options: ExecOptions }[] = []
    const { run } = await setup((args, options) => {
      calls.push({ args, options })
      return Promise.resolve({ code: 0, stdout: REPORT, stderr: '' })
    })
    const r = await run<ScanResult>({ op: 'image.scan', ref: 'nginx:1.21' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args.slice(0, 2)).toEqual(['image', '--quiet'])
    expect(calls[0]?.args.slice(-2)).toEqual(['--', 'nginx:1.21'])
    expect(calls[0]?.args).toContain('json')
    expect(calls[0]?.options.timeoutMs).toBeGreaterThan(5 * 60_000)
    expect(r.summary.HIGH).toBe(1)
    expect(r.findings[0]).toMatchObject({ id: 'CVE-1', fixed: '2' })
  })

  it('quét không phải thao tác thay đổi: chạy được cả khi chỉ đọc', async () => {
    const { run } = await setup(
      () => Promise.resolve({ code: 0, stdout: REPORT, stderr: '' }),
      true
    )
    await expect(run({ op: 'image.scan', ref: 'nginx:1.21' })).resolves.toBeTruthy()
  })

  it('ref có dạng tuỳ chọn bị từ chối trước khi chạy gì', async () => {
    let called = false
    const { run } = await setup(() => {
      called = true
      return Promise.resolve({ code: 0, stdout: REPORT, stderr: '' })
    })
    await expect(run({ op: 'image.scan', ref: '--exit-code=1' })).rejects.toThrow()
    await expect(run({ op: 'image.scan', ref: 'a b' })).rejects.toThrow()
    expect(called).toBe(false)
  })

  it('Trivy chưa cài (127) → câu hướng dẫn; lỗi khác → dòng lỗi cuối', async () => {
    const missing = await setup(() =>
      Promise.resolve({ code: 127, stdout: '', stderr: 'sh: trivy: command not found' })
    )
    await expect(missing.run({ op: 'image.scan', ref: 'x' })).rejects.toThrow(/not installed/)
    const failed = await setup(() =>
      Promise.resolve({ code: 1, stdout: '', stderr: 'INFO\nFATAL failed to download db\n' })
    )
    await expect(failed.run({ op: 'image.scan', ref: 'x' })).rejects.toThrow(
      /Trivy failed: INFO FATAL failed to download db/
    )
  })

  it('đầu ra không phải JSON → lỗi nói rõ', async () => {
    const { run } = await setup(() => Promise.resolve({ code: 0, stdout: 'not json', stderr: '' }))
    await expect(run({ op: 'image.scan', ref: 'x' })).rejects.toThrow(/JSON report/)
  })

  it('nguồn không có scanner → báo không quét được', async () => {
    const { run } = await setup(undefined)
    await expect(run({ op: 'image.scan', ref: 'x' })).rejects.toThrow(/not available/)
  })
})
