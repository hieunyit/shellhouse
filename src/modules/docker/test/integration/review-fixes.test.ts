import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiBackend } from '../../session-host/api-backend'
import { CliBackend } from '../../session-host/cli-backend'
import { EngineClient } from '../../session-host/engine'
import { cliReprobe, DockerService, type DockerServiceDeps } from '../../session-host/service'
import type { DockerBackend, DockerCli } from '../../session-host/backend'
import { dockerMain } from '../../main'
import type { ContainerRow, ImageRow, PruneResult, StatsSample } from '../../shared/ops'
import {
  ANON_VOLUME,
  startEngineTestServer,
  type EngineTestOptions,
  type EngineTestServer
} from '../engine-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function engine(options?: EngineTestOptions): Promise<EngineTestServer> {
  const server = await startEngineTestServer(options)
  cleanups.push(() => server.close())
  return server
}

const socketTo = (path: string) => () =>
  new Promise<import('node:net').Socket>((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      resolve(socket)
    })
    socket.once('error', reject)
  })

const noCli: DockerCli = {
  exec: () => Promise.reject(new Error('no cli')),
  spawn: () => Promise.reject(new Error('no cli'))
}

function service(deps: Partial<DockerServiceDeps> & Pick<DockerServiceDeps, 'connect'>) {
  const events: { event: string; data: unknown }[] = []
  const logs: string[] = []
  const s = new DockerService({
    cli: noCli,
    openPty: () => Promise.reject(new Error('no pty')),
    emit: (event, data) => events.push({ event, data }),
    log: (_level, message) => logs.push(message),
    ...deps
  })
  cleanups.push(() => {
    s.dispose()
  })
  const run = <T>(op: unknown): Promise<T> => s.run(op, new AbortController().signal) as Promise<T>
  const until = async (pred: () => boolean, what = ''): Promise<void> => {
    const deadline = Date.now() + 5000
    while (!pred()) {
      if (Date.now() > deadline)
        throw new Error(`timeout ${what}; events: ${JSON.stringify(events.map((e) => e.event))}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return { s, run, events, logs, until }
}

const apiService = (server: EngineTestServer, deps: Partial<DockerServiceDeps> = {}) =>
  service({
    connect: () => Promise.resolve(new ApiBackend(new EngineClient(socketTo(server.path)))),
    ...deps
  })

describe('thương lượng phiên bản Engine API', () => {
  it('Docker 29 (tối thiểu 1.44): dùng phiên bản server báo, không còn cố định v1.41', async () => {
    const server = await engine({ apiVersion: '1.52', minApiVersion: '1.44' })
    const { run } = apiService(server)
    expect(await run<ContainerRow[]>({ op: 'containers', all: true })).toHaveLength(3)
    // Server mới hơn bản mình hỗ trợ → dùng bản mình hỗ trợ (1.47 ≥ 1.44).
    expect(server.requests).toContain('GET /v1.47/containers/json?all=true')
    expect(server.requests.some((r) => r.includes('/v1.41/'))).toBe(false)
  })

  it('server cũ (1.40) → dùng 1.40; không có header (Podman cũ) → 1.41', async () => {
    const old = await engine({ apiVersion: '1.40' })
    await apiService(old).run({ op: 'containers', all: false })
    expect(old.requests).toContain('GET /v1.40/containers/json?all=false')
    const podman = await engine({ apiVersion: '1.41', pingHeader: false })
    await apiService(podman).run({ op: 'containers', all: false })
    expect(podman.requests).toContain('GET /v1.41/containers/json?all=false')
  })

  it('server đòi bản mới hơn bản mình hỗ trợ ("too old") → thử lại với bản server nêu', async () => {
    const server = await engine({ apiVersion: '1.52', minApiVersion: '1.49' })
    const { run } = apiService(server)
    expect(await run<ContainerRow[]>({ op: 'containers', all: true })).toHaveLength(3)
    expect(server.requests).toContain('GET /v1.47/containers/json?all=true')
    expect(server.requests).toContain('GET /v1.49/containers/json?all=true')
    // Các request sau dùng luôn bản đã chọn.
    await run({ op: 'images' })
    expect(server.requests.at(-1)).toMatch(/^GET \/v1\.49\//)
  })
})

describe('dọn volume: xem trước khớp đúng thứ bị xoá', () => {
  it('API ≥ 1.42: mặc định chỉ volume ẩn danh; "Include named volumes" xoá cả volume có tên', async () => {
    const server = await engine({ apiVersion: '1.45' })
    const { run } = apiService(server)
    const preview = await run<PruneResult>({ op: 'prune', what: 'volumes', dryRun: true })
    expect(preview.items).toEqual([ANON_VOLUME])
    const done = await run<PruneResult>({ op: 'prune', what: 'volumes', dryRun: false })
    expect(done.items).toEqual(preview.items)
    expect(server.volumes.map((v) => v.Name)).toEqual(['shop_data', 'orphan'])

    const all = await run<PruneResult>({
      op: 'prune',
      what: 'volumes',
      dryRun: true,
      all: true
    })
    expect(all.items).toEqual(['orphan'])
    const doneAll = await run<PruneResult>({
      op: 'prune',
      what: 'volumes',
      dryRun: false,
      all: true
    })
    expect(doneAll.items).toEqual(['orphan'])
    expect(server.requests.some((r) => r.startsWith('POST /v1.45/volumes/prune?filters='))).toBe(
      true
    )
    expect(server.volumes.map((v) => v.Name)).toEqual(['shop_data'])
  })

  it('API < 1.42 (Docker 20.10 / Podman): không gọi /volumes/prune khi chỉ xoá ẩn danh — volume có tên còn nguyên', async () => {
    const server = await engine({ apiVersion: '1.41' })
    const { run } = apiService(server)
    const done = await run<PruneResult>({ op: 'prune', what: 'volumes', dryRun: false })
    expect(done.items).toEqual([ANON_VOLUME])
    expect(server.volumes.map((v) => v.Name)).toEqual(['shop_data', 'orphan'])
    expect(server.requests.some((r) => r.includes('/volumes/prune'))).toBe(false)
    // all: API cũ đã xoá mọi volume không dùng — không gửi filter `all` (Podman không hiểu).
    await run({ op: 'prune', what: 'volumes', dryRun: false, all: true })
    expect(server.requests).toContain('POST /v1.41/volumes/prune')
    expect(server.volumes.map((v) => v.Name)).toEqual(['shop_data'])
  })

  it('CLI: xem trước lọc volume ẩn danh; xoá đúng danh sách bằng `volume rm --`', async () => {
    const calls: string[][] = []
    const cli = new CliBackend({
      exec: (args) => {
        calls.push([...args])
        if (args[0] === 'volume' && args[1] === 'ls')
          return Promise.resolve({
            code: 0,
            stdout: [
              { Name: 'pgdata', Labels: 'com.docker.compose.project=shop' },
              { Name: 'anon1', Labels: 'com.docker.volume.anonymous=' },
              { Name: 'c'.repeat(64), Labels: '' }
            ]
              .map((v) => JSON.stringify(v))
              .join('\n'),
            stderr: ''
          })
        if (args[0] === 'volume' && args[1] === 'rm')
          return Promise.resolve({ code: 0, stdout: `${args.slice(3).join('\n')}\n`, stderr: '' })
        return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected' })
      },
      spawn: () => Promise.reject(new Error('unused'))
    })
    expect((await cli.prune('volumes', true)).items).toEqual(['anon1', 'c'.repeat(64)])
    expect((await cli.prune('volumes', false)).items).toEqual(['anon1', 'c'.repeat(64)])
    expect(calls.at(-1)).toEqual(['volume', 'rm', '--', 'anon1', 'c'.repeat(64)])
    expect((await cli.prune('volumes', false, true)).items).toEqual([
      'pgdata',
      'anon1',
      'c'.repeat(64)
    ])
    // Không còn `docker volume prune -f` (CLI < 23 xoá cả volume có tên).
    expect(calls.some((c) => c.includes('prune'))).toBe(false)
  })
})

describe('CLI dự phòng', () => {
  it('số container theo image: id image thật (inspect), không phải chuỗi người dùng gõ', async () => {
    const calls: string[][] = []
    const cli = new CliBackend({
      exec: (args) => {
        calls.push([...args])
        const out = (stdout: string) => Promise.resolve({ code: 0, stdout, stderr: '' })
        if (args[0] === 'images')
          return out(
            [
              {
                ID: 'sha256:aaa',
                Repository: 'nginx',
                Tag: 'latest',
                Size: '1MB',
                CreatedAt: ''
              },
              { ID: 'sha256:bbb', Repository: 'redis', Tag: '7', Size: '1MB', CreatedAt: '' }
            ]
              .map((x) => JSON.stringify(x))
              .join('\n')
          )
        if (args[0] === 'ps') return out('c1\nc2\nc3\n')
        if (args[0] === 'container' && args[1] === 'inspect')
          return out('sha256:aaa\nsha256:aaa\nsha256:bbb\n')
        return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected' })
      },
      spawn: () => Promise.reject(new Error('unused'))
    })
    const images = await cli.images(new AbortController().signal)
    expect(images.map((i) => [i.tags[0], i.containers])).toEqual([
      ['nginx:latest', 2],
      ['redis:7', 1]
    ])
    expect(calls.find((c) => c[1] === 'inspect')).toEqual([
      'container',
      'inspect',
      '--format',
      '{{.Image}}',
      '--',
      'c1',
      'c2',
      'c3'
    ])
  })

  it('đối số vị trí sau `--`; xoá container kèm volume ẩn danh (-v)', async () => {
    const calls: string[][] = []
    const cli = new CliBackend({
      exec: (args) => {
        calls.push([...args])
        return Promise.resolve({ code: 0, stdout: '', stderr: '' })
      },
      spawn: () => Promise.reject(new Error('unused'))
    })
    await cli.action('web', 'remove', true, true)
    await cli.action('web', 'stop', false)
    await cli.imageRemove('nginx:1.27', false)
    await cli.volumeRemove('data')
    expect(calls).toEqual([
      ['rm', '-f', '-v', '--', 'web'],
      ['stop', '--', 'web'],
      ['rmi', '--', 'nginx:1.27'],
      ['volume', 'rm', '--', 'data']
    ])
  })
})

/** Backend giả cho các luồng của DockerService. */
function fakeBackend(over: Partial<DockerBackend>): DockerBackend {
  const fail = () => Promise.reject(new Error('not implemented'))
  return {
    via: 'api',
    info: fail,
    containers: () => Promise.resolve([]),
    inspect: fail,
    action: () => Promise.resolve(),
    rename: fail,
    logs: fail,
    stats: fail,
    events: (_on, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve()
        })
      }),
    images: fail,
    imageRemove: fail,
    imagePull: fail,
    volumes: fail,
    volumeRemove: fail,
    networks: fail,
    networkRemove: fail,
    prune: fail,
    df: fail,
    statsOnce: () => Promise.resolve({}),
    top: fail,
    imageHistory: fail,
    run: fail,
    imagePush: fail,
    imageTag: fail,
    registryLogin: fail,
    volumeCreate: fail,
    networkCreate: fail,
    networkConnect: fail,
    networkDisconnect: fail,
    execCapture: fail,
    archive: fail,
    putArchive: fail,
    ...over
  }
}

describe('log nhiều container', () => {
  it('một container lỗi không làm đứt các container khác; dòng cuối không có \\n vẫn hiện', async () => {
    let bSignal: AbortSignal | null = null
    const backend = fakeBackend({
      logs: (id, _tail, _ts, onData, signal) => {
        if (id === 'gone') return Promise.reject(new Error('No such container: gone'))
        if (id === 'a') {
          onData('stdout', 'line1\npart')
          onData('stdout', 'ial')
          return Promise.resolve()
        }
        bSignal = signal
        onData('stderr', 'b says hi\n')
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve()
          })
        })
      }
    })
    const { run, events, until } = service({ connect: () => Promise.resolve(backend) })
    const { subscription } = await run<{ subscription: string }>({
      op: 'logs.subscribeMany',
      containers: [
        { id: 'a', name: 'a' },
        { id: 'gone', name: 'gone' },
        { id: 'b', name: 'b' }
      ],
      tail: 10,
      timestamps: false
    })
    const text = (): string =>
      events
        .filter((e) => e.event === 'logs')
        .map((e) => (e.data as { text: string }).text)
        .join('')
    await until(() => text().includes('[a] partial\n') && text().includes('b says hi'), 'logs')
    expect(text()).toContain('[a] line1\n')
    expect(text()).toContain('[gone] log stream failed: No such container: gone')
    // Luồng của b vẫn chạy, chưa kết thúc.
    expect(events.some((e) => e.event === 'logs-end')).toBe(false)
    expect((bSignal as AbortSignal | null)?.aborted).toBe(false)
    await run({ op: 'unsubscribe', subscription })
    expect((bSignal as AbortSignal | null)?.aborted).toBe(true)
  })

  it('mọi container lỗi → logs-end có lỗi; luồng kết thúc thì tín hiệu huỷ luôn được bật', async () => {
    const signals: AbortSignal[] = []
    const backend = fakeBackend({
      logs: (_id, _tail, _ts, _onData, signal) => {
        signals.push(signal)
        return Promise.reject(new Error('boom'))
      }
    })
    const { run, events, until } = service({ connect: () => Promise.resolve(backend) })
    await run({
      op: 'logs.subscribeMany',
      containers: [
        { id: 'x', name: 'x' },
        { id: 'y', name: 'y' }
      ],
      tail: 1,
      timestamps: false
    })
    await until(() => events.some((e) => e.event === 'logs-end'), 'logs-end')
    expect(events.find((e) => e.event === 'logs-end')?.data).toMatchObject({ error: 'boom' })
    await until(() => signals.every((s) => s.aborted), 'aborted')
  })
})

describe('chế độ chỉ đọc do main giữ', () => {
  it('cờ đã lưu ở main chặn thao tác thay đổi và shell, kể cả khi renderer không báo', async () => {
    const asked: (string | undefined)[] = []
    const actions: string[] = []
    let ptys = 0
    const backend = fakeBackend({
      action: (_id, action) => {
        actions.push(action)
        return Promise.resolve()
      }
    })
    const { run, s } = service({
      connect: () => Promise.resolve(backend),
      storedReadOnly: (hostId) => {
        asked.push(hostId)
        return Promise.resolve(hostId === 'prod')
      },
      openPty: () => {
        ptys++
        return Promise.reject(new Error('pty opened'))
      }
    })
    // Phiên SSH: renderer báo hostId (không báo readOnly) → Session Host hỏi main.
    await run({ op: 'configure', readOnly: false, hostId: 'prod' })
    await expect(run({ op: 'action', id: 'web', action: 'stop' })).rejects.toThrow(/Read-only/)
    expect(actions).toEqual([])
    const size = { cols: 80, rows: 24 }
    const cb = { onData: () => undefined, onExit: () => undefined } as never
    await expect(s.openTerminal({ container: 'web', hostId: 'prod' }, size, cb)).rejects.toThrow(
      /Read-only/
    )
    expect(ptys).toBe(0)
    // Host khác (không chỉ đọc): shell mở được, thao tác chạy.
    await expect(s.openTerminal({ container: 'web', hostId: 'dev' }, size, cb)).rejects.toThrow(
      /pty opened/
    )
    await run({ op: 'configure', readOnly: false, hostId: 'dev' })
    await run({ op: 'action', id: 'web', action: 'stop' })
    expect(actions).toEqual(['stop'])
    expect(asked).toContain('prod')
    // Xem vẫn được ở chế độ chỉ đọc.
    await run({ op: 'configure', readOnly: false, hostId: 'prod' })
    expect(await run({ op: 'containers', all: true })).toEqual([])
  })

  it('main trả cờ chỉ đọc theo nguồn đã lưu (fromMain "readOnly")', () => {
    const rows = new Map<string, number>([
      ['local', 0],
      ['prod', 1],
      ['wsl:Ubuntu', 1]
    ])
    const api = dockerMain.activate({
      db: {
        prepare: () => ({
          run: () => ({ changes: 0 }),
          get: (id: unknown) =>
            rows.has(String(id)) ? { read_only: rows.get(String(id)) } : undefined,
          all: () => []
        }),
        transaction: <T>(fn: () => T): T => fn()
      },
      ipc: { handle: () => undefined },
      events: { emit: () => undefined },
      wslDistros: () => Promise.resolve([])
    } as never)
    expect(api.onHostRequest?.('readOnly', 'prod')).toBe(true)
    expect(api.onHostRequest?.('readOnly', 'wsl:Ubuntu')).toBe(true)
    expect(api.onHostRequest?.('readOnly', null)).toBe(false)
    expect(api.onHostRequest?.('readOnly', 'unknown')).toBe(false)
    expect(() => api.onHostRequest?.('readOnly', 42)).toThrow()
  })
})

describe('backend chết / CLI dự phòng', () => {
  it('statsAll lỗi → báo tab (không nuốt im); mất socket → kết nối lại', async () => {
    let connects = 0
    let fail = true
    const backend = fakeBackend({
      statsOnce: () =>
        fail
          ? Promise.reject(
              Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
            )
          : Promise.resolve({ web: { at: 1 } as StatsSample })
    })
    const { run, events, until } = service({
      connect: () => {
        connects++
        return Promise.resolve(backend)
      }
    })
    await run({ op: 'statsAll.subscribe' })
    await until(
      () => events.some((e) => e.event === 'statsAll' && (e.data as { error?: string }).error),
      'stats error'
    )
    expect(events[0]?.data).toMatchObject({ samples: {}, error: 'connect ECONNREFUSED' })
    fail = false
    // Lỗi đường truyền → bỏ backend; lượt sau kết nối lại.
    await run({ op: 'containers', all: true })
    expect(connects).toBe(2)
  })

  it('đang dùng CLI dự phòng: sau một lúc thử lại Engine API, được thì đổi sang', async () => {
    const saved = cliReprobe.ms
    cliReprobe.ms = 0
    cleanups.push(() => {
      cliReprobe.ms = saved
    })
    const cliBackend = fakeBackend({ via: 'cli', containers: () => Promise.resolve([]) })
    const apiBackend = fakeBackend({
      via: 'api',
      containers: () => Promise.resolve([{ name: 'from-api' } as ContainerRow])
    })
    let connects = 0
    const { run, until } = service({
      connect: () => Promise.resolve(++connects === 1 ? cliBackend : apiBackend)
    })
    expect(await run<ContainerRow[]>({ op: 'containers', all: true })).toEqual([])
    await run({ op: 'containers', all: true })
    await until(() => connects === 2, 'reprobe')
    await new Promise((r) => setTimeout(r, 10))
    expect((await run<ContainerRow[]>({ op: 'containers', all: true }))[0]?.name).toBe('from-api')
  })

  it('xoá container kèm volume ẩn danh: API gửi v=true', async () => {
    const server = await engine()
    const { run } = apiService(server)
    const job = server.containers.find((c) => c.Names[0] === '/old-job')
    await run({ op: 'action', id: job?.Id, action: 'remove', volumes: true })
    expect(
      server.requests.some((r) => /DELETE \/v1\.45\/containers\/old-job-.*v=true/.test(r))
    ).toBe(true)
    expect((await run<ImageRow[]>({ op: 'images' })).length).toBe(3)
  })
})

describe('chỉ đọc: hỏi main lỗi thì chặn (fail-closed)', () => {
  it('storedReadOnly lỗi → chặn thao tác thay đổi và shell, xem vẫn được', async () => {
    let ptys = 0
    const { run, s } = service({
      connect: () => Promise.resolve(fakeBackend({ action: () => Promise.resolve() })),
      storedReadOnly: () => Promise.reject(new Error('Not available')),
      openPty: () => {
        ptys++
        return Promise.reject(new Error('pty opened'))
      }
    })
    await run({ op: 'configure', readOnly: false, hostId: 'prod' })
    await expect(run({ op: 'action', id: 'web', action: 'stop' })).rejects.toThrow(/Read-only/)
    const cb = { onData: () => undefined, onExit: () => undefined } as never
    await expect(
      s.openTerminal({ container: 'web', hostId: 'prod' }, { cols: 80, rows: 24 }, cb)
    ).rejects.toThrow(/Read-only/)
    expect(ptys).toBe(0)
    expect(await run({ op: 'containers', all: true })).toEqual([])
  })
})

describe('Docker CLI: nhiều container, Podman', () => {
  const ok = (stdout: string) => Promise.resolve({ code: 0, stdout, stderr: '' })

  it('container inspect chia lô; một lô lỗi không làm hỏng tab Images', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => i.toString(16).padStart(64, '0'))
    const batches: number[] = []
    const cli: DockerCli = {
      exec: (args) => {
        if (args[0] === 'ps') return ok(ids.join('\n'))
        if (args[0] === 'images')
          return ok(
            JSON.stringify({
              ID: 'sha256:img',
              Repository: 'nginx',
              Tag: 'latest',
              Size: '10MB',
              CreatedAt: '2024-01-01 00:00:00 +0000 UTC'
            })
          )
        if (args[0] === 'container') {
          const n = args.length - 5
          batches.push(n)
          // Lô thứ hai lỗi hẳn (không stdout).
          if (batches.length === 2) return Promise.resolve({ code: 1, stdout: '', stderr: 'boom' })
          return ok(Array.from({ length: n }, () => 'sha256:img').join('\n'))
        }
        return Promise.reject(new Error(`unexpected ${args.join(' ')}`))
      },
      spawn: () => Promise.reject(new Error('no spawn'))
    }
    const images = await new CliBackend(cli).images(new AbortController().signal)
    expect(batches).toEqual([150, 150, 100])
    expect(images[0]?.containers).toBe(250)
  })

  it('ps lỗi → Images vẫn trả danh sách, số container 0', async () => {
    const cli: DockerCli = {
      exec: (args) =>
        args[0] === 'images'
          ? ok(JSON.stringify({ ID: 'x', Repository: 'a', Tag: 'b', Size: '1kB', CreatedAt: '' }))
          : Promise.resolve({ code: 1, stdout: '', stderr: 'nope' }),
      spawn: () => Promise.reject(new Error('no spawn'))
    }
    const images = await new CliBackend(cli).images(new AbortController().signal)
    expect(images.map((i) => i.containers)).toEqual([0])
  })

  it('Podman: Labels dạng object (volume ls, prune dry-run)', async () => {
    const cli: DockerCli = {
      exec: () =>
        ok(
          [
            JSON.stringify({
              Name: 'shop_data',
              Driver: 'local',
              Mountpoint: '/v',
              Labels: { 'com.docker.compose.project': 'shop' }
            }),
            JSON.stringify({
              Name: 'f'.repeat(64),
              Driver: 'local',
              Mountpoint: '/v',
              Labels: null
            })
          ].join('\n')
        ),
      spawn: () => Promise.reject(new Error('no spawn'))
    }
    const volumes = await new CliBackend(cli).volumes(new AbortController().signal)
    expect(volumes.map((v) => v.project)).toEqual(['shop', null])
    const prune = await new CliBackend({
      ...cli,
      exec: () =>
        ok(
          [
            JSON.stringify({ Name: 'named', Labels: { 'com.docker.volume.anonymous': '' } }),
            JSON.stringify({ Name: 'keep', Labels: { 'com.docker.compose.project': 'shop' } })
          ].join('\n')
        )
    }).prune('volumes', true)
    expect(prune.items).toEqual(['named'])
  })
})
