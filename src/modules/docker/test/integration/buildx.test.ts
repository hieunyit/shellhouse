import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecOptions, ExecResult, RunningProgram } from '../../../registry/host-types'
import { ApiBackend } from '../../session-host/api-backend'
import type { DockerCli } from '../../session-host/backend'
import { EngineClient } from '../../session-host/engine'
import { DockerService } from '../../session-host/service'
import type { BuildInfo, RegistryAuth } from '../../shared/ops'
import { startEngineTestServer } from '../engine-test-server'

/** Build đa nền tảng: `docker buildx build`, đăng nhập registry vào thư mục `--config` tạm, thông tin buildx. */
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

interface Call {
  kind: 'exec' | 'spawn'
  args: readonly string[]
  options?: ExecOptions
}

const REGISTRY: RegistryAuth = { server: 'ghcr.io', username: 'me', password: 's3cret' }

async function setup(opts: {
  exec?: (args: readonly string[]) => ExecResult
  buildExit?: number
  noTempDir?: boolean
}) {
  const server = await startEngineTestServer()
  cleanups.push(() => server.close())
  const calls: Call[] = []
  const events: { event: string; data: unknown }[] = []
  const removed: string[] = []
  const cli: DockerCli = {
    exec: (args, options) => {
      calls.push({ kind: 'exec', args, ...(options ? { options } : {}) })
      return Promise.resolve(opts.exec?.(args) ?? { code: 0, stdout: '', stderr: '' })
    },
    spawn: (args) => {
      calls.push({ kind: 'spawn', args })
      let exit: ((code: number | null) => void) | undefined
      let out: ((c: Buffer) => void) | undefined
      const program: RunningProgram = {
        onStdout: (l) => {
          out = l
        },
        onStderr: () => undefined,
        onExit: (l) => {
          exit = l
          setTimeout(() => {
            out?.(Buffer.from('#1 DONE\n'))
            exit?.(opts.buildExit ?? 0)
          }, 5)
        },
        kill: () => undefined
      }
      return Promise.resolve(program)
    },
    ...(opts.noTempDir
      ? {}
      : {
          tempDir: () =>
            Promise.resolve({
              path: '/tmp/cfg-1',
              remove: () => {
                removed.push('/tmp/cfg-1')
                return Promise.resolve()
              }
            })
        })
  }
  const s = new DockerService({
    cli,
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
    emit: (event, data) => events.push({ event, data }),
    log: () => undefined,
    registryAuth: (id) =>
      id === 'ghcr' ? Promise.resolve(REGISTRY) : Promise.reject(new Error('no such registry'))
  })
  cleanups.push(() => {
    s.dispose()
  })
  const run = <T>(op: unknown): Promise<T> => s.run(op, new AbortController().signal) as Promise<T>
  const finished = async (): Promise<{ error?: string }> => {
    const deadline = Date.now() + 5000
    for (;;) {
      const end = events.find((e) => e.event === 'build-end')
      if (end) return end.data as { error?: string }
      if (Date.now() > deadline) throw new Error('build did not finish')
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { run, calls, removed, finished, events }
}

const SPEC = {
  context: '/srv/app',
  tags: ['ghcr.io/me/app:1'],
  buildArgs: [],
  noCache: false,
  pull: false
}

describe('Docker: buildx / build đa nền tảng', () => {
  it('đẩy lên registry đã lưu: login vào --config tạm, buildx build --push với cùng --config, xoá thư mục', async () => {
    const { run, calls, removed, finished } = await setup({})
    await run({
      op: 'build',
      spec: {
        ...SPEC,
        platforms: ['linux/amd64', 'linux/arm64'],
        output: 'push',
        registry: 'ghcr'
      }
    })
    expect(await finished()).not.toHaveProperty('error')
    const login = calls.find((c) => c.kind === 'exec' && c.args.includes('login'))
    expect(login?.args).toEqual([
      '--config',
      '/tmp/cfg-1',
      'login',
      '--username',
      'me',
      '--password-stdin',
      'ghcr.io'
    ])
    // Mật khẩu đi qua stdin, không nằm trong tham số.
    expect(login?.options?.input).toBe('s3cret')
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain('s3cret')
    const build = calls.find((c) => c.kind === 'spawn')
    expect(build?.args.slice(0, 4)).toEqual(['--config', '/tmp/cfg-1', 'buildx', 'build'])
    expect(build?.args).toContain('--push')
    expect(build?.args).toContain('linux/amd64,linux/arm64')
    expect(removed).toEqual(['/tmp/cfg-1'])
  })

  it('registry đã lưu không khớp tag → lỗi, không đăng nhập, không build', async () => {
    const { run, calls, finished } = await setup({})
    await run({
      op: 'build',
      spec: {
        ...SPEC,
        tags: ['docker.io/me/app:1'],
        platforms: ['linux/amd64'],
        output: 'push',
        registry: 'ghcr'
      }
    })
    const end = await finished()
    expect(end.error).toMatch(/not on ghcr\.io/)
    expect(calls).toHaveLength(0)
  })

  it('build lỗi → thư mục --config vẫn bị xoá; không chọn registry → không đăng nhập', async () => {
    const failed = await setup({ buildExit: 1 })
    await failed.run({
      op: 'build',
      spec: { ...SPEC, platforms: ['linux/amd64'], output: 'push', registry: 'ghcr' }
    })
    expect((await failed.finished()).error).toBeTruthy()
    expect(failed.removed).toEqual(['/tmp/cfg-1'])

    const anonymous = await setup({})
    await anonymous.run({
      op: 'build',
      spec: { ...SPEC, platforms: ['linux/amd64', 'linux/arm64'], output: 'none' }
    })
    await anonymous.finished()
    expect(anonymous.calls.filter((c) => c.kind === 'exec')).toHaveLength(0)
    expect(anonymous.calls.find((c) => c.kind === 'spawn')?.args[0]).toBe('buildx')
  })

  it('build.info: phiên bản buildx và các builder (nền tảng bỏ dấu *)', async () => {
    const { run } = await setup({
      exec: (args) =>
        args[1] === 'version'
          ? { code: 0, stdout: 'github.com/docker/buildx v0.17.1 abc123\n', stderr: '' }
          : {
              code: 0,
              stdout: [
                JSON.stringify({
                  Name: 'multi',
                  Driver: 'docker-container',
                  Current: true,
                  Nodes: [{ Platforms: ['linux/amd64*', 'linux/arm64'] }]
                }),
                JSON.stringify({
                  Name: 'default',
                  Driver: 'docker',
                  Nodes: [{ Platforms: 'linux/amd64, linux/386' }]
                }),
                'not json'
              ].join('\n'),
              stderr: ''
            }
    })
    const info = await run<BuildInfo>({ op: 'build.info' })
    expect(info.buildx).toBe('0.17.1')
    expect(info.builders).toEqual([
      {
        name: 'multi',
        driver: 'docker-container',
        current: true,
        platforms: ['linux/amd64', 'linux/arm64']
      },
      { name: 'default', driver: 'docker', current: false, platforms: ['linux/amd64', 'linux/386'] }
    ])
  })

  it('build.info: chưa cài buildx → buildx null, không lỗi', async () => {
    const { run } = await setup({
      exec: () => ({ code: 1, stdout: '', stderr: "docker: 'buildx' is not a docker command." })
    })
    expect(await run<BuildInfo>({ op: 'build.info' })).toEqual({ buildx: null, builders: [] })
  })
})
