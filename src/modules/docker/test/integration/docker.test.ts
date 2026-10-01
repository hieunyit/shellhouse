import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerMessage } from '@shared/stream-protocol'
import { HostModuleRegistry } from '../../../registry/session-host'
import { Session } from '../../../../session-host/session/session'
import { FakePort } from '../../../../../test/integration/fake-port'
import { startTestSshServer } from '../../../../../test/integration/ssh-test-server'
import { ApiBackend } from '../../session-host/api-backend'
import { CliBackend } from '../../session-host/cli-backend'
import { EngineClient } from '../../session-host/engine'
import { DockerService } from '../../session-host/service'
import { dockerHost } from '../../session-host'
import type { DockerCli } from '../../session-host/backend'
import type { ContainerRow, ImageRow, PruneResult } from '../../shared/ops'
import { startEngineTestServer, type EngineTestServer } from '../engine-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function engine(): Promise<EngineTestServer> {
  const server = await startEngineTestServer()
  cleanups.push(() => server.close())
  return server
}

function service(server: EngineTestServer, cli?: DockerCli) {
  const events: { event: string; data: unknown }[] = []
  const s = new DockerService({
    connect: () =>
      Promise.resolve(
        new ApiBackend(
          new EngineClient(
            () =>
              new Promise((resolve, reject) => {
                const socket = connect(server.path)
                socket.once('connect', () => {
                  resolve(socket)
                })
                socket.once('error', reject)
              })
          )
        )
      ),
    cli: cli ?? {
      exec: () => Promise.reject(new Error('no cli')),
      spawn: () => Promise.reject(new Error('no cli'))
    },
    openPty: () => Promise.reject(new Error('no pty')),
    emit: (event, data) => events.push({ event, data }),
    log: () => undefined
  })
  cleanups.push(() => {
    s.dispose()
  })
  const run = <T>(op: unknown): Promise<T> => s.run(op, new AbortController().signal) as Promise<T>
  const until = async (pred: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000
    while (!pred()) {
      if (Date.now() > deadline)
        throw new Error(`timeout; events: ${JSON.stringify(events.map((e) => e.event))}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return { s, run, events, until }
}

describe('Docker qua Engine API (Engine giả trên unix socket)', () => {
  it('thông tin, danh sách container (cổng, nhãn compose), thao tác, đổi tên, xoá có xác nhận force', async () => {
    const server = await engine()
    const { run } = service(server)
    expect(await run({ op: 'info' })).toMatchObject({
      version: 'Docker Engine 27.1.1',
      containers: 3,
      running: 2,
      via: 'api'
    })
    const list = await run<ContainerRow[]>({ op: 'containers', all: true })
    expect(list.map((c) => c.name)).toEqual(['web', 'db', 'old-job'])
    const web = list[0] as ContainerRow
    expect(web).toMatchObject({
      state: 'running',
      project: 'shop',
      service: 'web',
      composeDir: '/srv/shop',
      ports: [{ ip: '0.0.0.0', privatePort: 80, publicPort: 8080, type: 'tcp' }]
    })
    await run({ op: 'action', id: web.id, action: 'stop' })
    expect(server.containers[0]?.State).toBe('exited')
    await run({ op: 'rename', id: web.id, name: 'web-2' })
    expect(server.containers[0]?.Names).toEqual(['/web-2'])
    // Docker từ chối xoá container đang chạy → thông báo của Docker tới nguyên vẹn.
    const db = list[1] as ContainerRow
    await expect(run({ op: 'action', id: db.id, action: 'remove' })).rejects.toThrow(
      /cannot remove a running container/
    )
    await run({ op: 'action', id: db.id, action: 'remove', force: true })
    expect(server.containers.map((c) => c.Names[0])).toEqual(['/web-2', '/old-job'])
    // Tham số lạ bị schema chặn trước khi tới Docker.
    await expect(run({ op: 'action', id: 'x; rm -rf /', action: 'stop' })).rejects.toThrow()
    await expect(run({ op: 'action', id: db.id, action: 'explode' })).rejects.toThrow()
  })

  it('inspect che giá trị biến môi trường có vẻ bí mật', async () => {
    const server = await engine()
    const { run } = service(server)
    const id = server.containers[0]?.Id ?? ''
    const data = await run<{ Config: { Env: string[] } }>({ op: 'inspect', kind: 'container', id })
    expect(data.Config.Env).toEqual(['PATH=/usr/bin', 'DB_PASSWORD=••••••', 'MODE=prod'])
  })

  it('log: tách stdout / stderr (header 8 byte), follow nhận dòng mới, huỷ đăng ký dừng luồng', async () => {
    const server = await engine()
    const { run, events, until } = service(server)
    const id = server.containers[0]?.Id ?? ''
    const { subscription } = await run<{ subscription: string }>({
      op: 'logs.subscribe',
      id,
      tail: 100,
      timestamps: false
    })
    const logs = (): { stream: string; text: string }[] =>
      events
        .filter((e) => e.event === 'logs')
        .map((e) => e.data as { stream: string; text: string; subscription: string })
        .filter((d) => d.subscription === subscription)
    await until(() => logs().some((l) => l.stream === 'stderr'))
    expect(logs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stream: 'stdout', text: 'hello from stdout\n' }),
        expect.objectContaining({ stream: 'stderr', text: 'warning on stderr\n' })
      ])
    )
    server.log(id, 1, 'dòng mới — tiếng Việt\n')
    await until(() => logs().some((l) => l.text.includes('dòng mới')))
    await run({ op: 'unsubscribe', subscription })
    server.log(id, 1, 'after unsubscribe\n')
    await new Promise((r) => setTimeout(r, 200))
    expect(logs().some((l) => l.text.includes('after unsubscribe'))).toBe(false)
  })

  it('log container có TTY: luồng thô, không header', async () => {
    const server = await engine()
    const c = server.containers[0]
    if (c) c.Tty = true
    const { run, events, until } = service(server)
    await run({ op: 'logs.subscribe', id: c?.Id ?? '', tail: 10, timestamps: false })
    await until(() => events.some((e) => e.event === 'logs'))
    const text = events
      .filter((e) => e.event === 'logs')
      .map((e) => (e.data as { text: string }).text)
      .join('')
    expect(text).toBe('hello from stdout\nwarning on stderr\n')
  })

  it('stats: % CPU như `docker stats`, RAM trừ page cache; events: danh sách tự cập nhật', async () => {
    const server = await engine()
    const { run, events, until } = service(server)
    const id = server.containers[0]?.Id ?? ''
    await run({ op: 'stats.subscribe', id })
    await until(() => events.filter((e) => e.event === 'stats').length >= 2)
    const sample = (
      events.filter((e) => e.event === 'stats').at(-1)?.data as {
        sample: { cpuPercent: number; memUsage: number }
      }
    ).sample
    // cpuDelta / sysDelta × 2 CPU × 100 = 1/10 × 2 × 100
    expect(sample.cpuPercent).toBeCloseTo(20)
    expect(sample.memUsage).toBe(50_000_000)

    await run({ op: 'events.subscribe' })
    await new Promise((r) => setTimeout(r, 100))
    await run({ op: 'action', id, action: 'restart' })
    await until(() => events.some((e) => e.event === 'engine'))
    expect(events.find((e) => e.event === 'engine')?.data).toMatchObject({ action: 'restart', id })
  })

  it('image: danh sách (dangling, số container dùng), pull có tiến độ, pull lỗi báo rõ, prune xem trước rồi xoá', async () => {
    const server = await engine()
    const { run, events, until } = service(server)
    const images = await run<ImageRow[]>({ op: 'images' })
    expect(images.find((i) => i.tags[0] === 'nginx:1.27')).toMatchObject({
      containers: 2,
      dangling: false
    })
    expect(images.find((i) => i.id === 'sha256:dangling1')).toMatchObject({
      dangling: true,
      tags: []
    })

    await run({ op: 'image.pull', ref: 'redis:7' })
    await until(() => events.some((e) => e.event === 'pull' && (e.data as { done: boolean }).done))
    const pulls = events
      .filter((e) => e.event === 'pull')
      .map((e) => e.data as { progress: number | null; error?: string })
    expect(pulls.some((p) => p.progress === 0.5)).toBe(true)
    expect(pulls.at(-1)).toMatchObject({ progress: 1 })
    expect(server.requests).toContain('POST /v1.41/images/create?fromImage=redis&tag=7')

    events.length = 0
    await run({ op: 'image.pull', ref: 'does-not-exist' })
    await until(() => events.some((e) => e.event === 'pull' && (e.data as { done: boolean }).done))
    expect(events.at(-1)?.data).toMatchObject({ error: 'pull access denied for does-not-exist' })

    const preview = await run<PruneResult>({ op: 'prune', what: 'images', dryRun: true })
    expect(preview.items).toEqual(['dangling1'])
    expect((await run<ImageRow[]>({ op: 'images' })).length).toBe(4)
    const done = await run<PruneResult>({ op: 'prune', what: 'images', dryRun: false })
    expect(done.reclaimed).toBe(5_000_000)
    expect(
      (await run<PruneResult>({ op: 'prune', what: 'containers', dryRun: true })).items
    ).toEqual(['old-job'])
    expect((await run<PruneResult>({ op: 'prune', what: 'networks', dryRun: true })).items).toEqual(
      ['unused']
    )
    expect((await run<PruneResult>({ op: 'prune', what: 'volumes', dryRun: true })).items).toEqual([
      'orphan'
    ])
  })

  it('chế độ chỉ đọc: thao tác thay đổi bị từ chối ở Session Host; xem vẫn được', async () => {
    const server = await engine()
    const { run } = service(server)
    await run({ op: 'configure', readOnly: true })
    const id = server.containers[0]?.Id ?? ''
    await expect(run({ op: 'action', id, action: 'stop' })).rejects.toThrow(/Read-only/)
    await expect(run({ op: 'prune', what: 'images', dryRun: false })).rejects.toThrow(/Read-only/)
    await expect(run({ op: 'image.pull', ref: 'x' })).rejects.toThrow(/Read-only/)
    expect(
      (await run<PruneResult>({ op: 'prune', what: 'images', dryRun: true })).items
    ).toHaveLength(1)
    expect(server.containers[0]?.State).toBe('running')
  })

  it('compose: start/stop theo nhãn project qua API; up/down qua `docker compose` với thư mục + file từ nhãn', async () => {
    const server = await engine()
    const calls: string[][] = []
    const { run } = service(server, {
      exec: (args) => {
        calls.push([...args])
        return Promise.resolve({ code: 0, stdout: 'done', stderr: '' })
      },
      spawn: () => Promise.reject(new Error('unused'))
    })
    await run({ op: 'compose', project: 'shop', action: 'stop' })
    expect(
      server.containers
        .filter((c) => c.Labels['com.docker.compose.project'] === 'shop')
        .map((c) => c.State)
    ).toEqual(['exited', 'exited'])
    await run({ op: 'compose', project: 'shop', action: 'up' })
    expect(calls).toEqual([
      [
        'compose',
        '-p',
        'shop',
        '--project-directory',
        '/srv/shop',
        '-f',
        '/srv/shop/compose.yaml',
        'up',
        '-d'
      ]
    ])
  })
})

describe('Docker — Overview, stats cả bảng, top, history, run, log Compose', () => {
  it('dung lượng đĩa, CPU/RAM mọi container đang chạy, tiến trình, lớp image', async () => {
    const server = await engine()
    const { run, events, until } = service(server)
    const df = await run<{
      images: { count: number; reclaimable: number }
      volumes: { reclaimable: number }
      buildCache: { size: number }
    }>({ op: 'df' })
    expect(df.images.count).toBe(3)
    expect(df.images.reclaimable).toBe(5_000_000)
    expect(df.volumes.reclaimable).toBe(2000)
    expect(df.buildCache.size).toBe(3000)
    await run({ op: 'statsAll.subscribe' })
    await until(() => events.some((e) => e.event === 'statsAll'))
    const samples = (
      events.find((e) => e.event === 'statsAll')?.data as {
        samples: Record<string, { memUsage: number }>
      }
    ).samples
    expect(Object.keys(samples).length).toBe(2)
    expect(Object.values(samples)[0]?.memUsage).toBe(50_000_000)
    const top = await run<{ titles: string[]; processes: string[][] }>({
      op: 'top',
      id: server.containers[0]?.Id
    })
    expect(top.processes[0]?.[2]).toContain('nginx: master')
    const layers = await run<{ createdBy: string; size: number }[]>({
      op: 'image.history',
      id: 'sha256:img1'
    })
    expect(layers.map((l) => l.size)).toEqual([0, 50_000_000])
  })

  it('run: tạo + chạy; image chưa có → kéo về rồi tạo; tham số cổng / env', async () => {
    const server = await engine()
    const { run } = service(server)
    const spec = {
      image: 'redis:7',
      name: 'cache',
      ports: [{ host: 6380, container: 6379, protocol: 'tcp' }],
      env: ['MODE=test'],
      volumes: [{ source: 'cache-data', target: '/data', readOnly: false }],
      restart: 'unless-stopped',
      autoRemove: false,
      pull: false
    }
    await expect(run({ op: 'run', spec })).rejects.toThrow(/No such image/)
    const r = await run<{ id: string }>({ op: 'run', spec: { ...spec, pull: true } })
    const c = server.containers.find((x) => x.Id === r.id)
    expect(c?.Names).toEqual(['/cache'])
    expect(c?.State).toBe('running')
    expect(server.created.at(-1)).toMatchObject({
      Image: 'redis:7',
      Env: ['MODE=test'],
      HostConfig: {
        PortBindings: { '6379/tcp': [{ HostPort: '6380' }] },
        Binds: ['cache-data:/data'],
        RestartPolicy: { Name: 'unless-stopped' }
      }
    })
    await run({ op: 'configure', readOnly: true })
    await expect(run({ op: 'run', spec })).rejects.toThrow(/Read-only/)
  })

  it('inspect: che env mặc định, reveal = giá trị thật', async () => {
    const server = await engine()
    const { run } = service(server)
    const id = server.containers[0]?.Id ?? ''
    const shown = await run<{ Config: { Env: string[] } }>({
      op: 'inspect',
      kind: 'container',
      id,
      reveal: true
    })
    expect(shown.Config.Env).toContain('DB_PASSWORD=hunter2')
  })

  it('log nhiều container (Compose): tiền tố tên mỗi dòng', async () => {
    const server = await engine()
    const { run, events, until } = service(server)
    const [web, db] = server.containers
    await run({
      op: 'logs.subscribeMany',
      containers: [
        { id: web?.Id, name: 'web' },
        { id: db?.Id, name: 'db' }
      ],
      tail: 10,
      timestamps: false
    })
    await until(() => {
      const text = events
        .filter((e) => e.event === 'logs')
        .map((e) => (e.data as { text: string }).text)
        .join('')
      return text.includes('[web] hello from stdout') && text.includes('[db] warning on stderr')
    })
  })
})

describe('Docker CLI dự phòng', () => {
  it('đọc `--format {{json .}}`, lỗi quyền socket → câu dễ hiểu', async () => {
    const outputs: Record<string, { code: number; stdout: string; stderr: string }> = {
      ps: {
        code: 0,
        stdout: `${JSON.stringify({ ID: 'abc', Names: 'api', Image: 'node:22', State: 'running', Status: 'Up 1 hour', CreatedAt: '2026-09-01 10:00:00 +0000 UTC', Ports: '0.0.0.0:3000->3000/tcp, :::3000->3000/tcp', Labels: 'com.docker.compose.project=blog,x=y' })}\n`,
        stderr: ''
      },
      volume: {
        code: 1,
        stdout: '',
        stderr:
          'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'
      }
    }
    const cli = new CliBackend({
      exec: (args) =>
        Promise.resolve(
          outputs[args[0] ?? ''] ?? {
            code: 127,
            stdout: '',
            stderr: 'sh: docker: command not found'
          }
        ),
      spawn: () => Promise.reject(new Error('unused'))
    })
    const signal = new AbortController().signal
    const list = await cli.containers(true, signal)
    expect(list[0]).toMatchObject({
      id: 'abc',
      name: 'api',
      project: 'blog',
      ports: [
        { ip: '0.0.0.0', publicPort: 3000, privatePort: 3000, type: 'tcp' },
        { ip: '::', publicPort: 3000, privatePort: 3000, type: 'tcp' }
      ]
    })
    expect(list[0]?.created).toBe(Date.parse('2026-09-01T10:00:00+00:00'))
    await expect(cli.volumes(signal)).rejects.toThrow(/can't access the Docker socket/)
    await expect(cli.networks(signal)).rejects.toThrow(/not installed/)
  })
})

describe('Docker qua SSH (streamlocal tới socket trên server)', () => {
  it('tab gắn module Docker vào kết nối SSH: thao tác đi qua kênh streamlocal; socket không khai báo bị chặn', async () => {
    const eng = await engine()
    const ssh = await startTestSshServer([{ username: 'alice', password: 'pw' }], {
      streamLocal: { '/var/run/docker.sock': eng.path }
    })
    cleanups.push(() => ssh.close())
    const modules = new HostModuleRegistry([dockerHost], {
      log: () => undefined,
      requestProgramGrant: () => Promise.resolve(false)
    })
    modules.setEnabled(['docker'])
    const port = new FakePort()
    const session = new Session(
      'docker-ssh',
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
    port.deliver({ t: 'module-attach', module: 'docker' })
    port.deliver({ t: 'module', id: 1, module: 'docker', op: { op: 'containers', all: true } })
    const result = (id: number): Extract<ServerMessage, { t: 'module-result' }> | undefined =>
      port.sent.find(
        (m): m is Extract<ServerMessage, { t: 'module-result' }> =>
          m.t === 'module-result' && m.id === id
      )
    await port.until(() => result(1) !== undefined, 10_000)
    const r1 = result(1)
    expect(r1?.ok).toBe(true)
    expect((r1 as { result: ContainerRow[] }).result.map((c) => c.name)).toEqual([
      'web',
      'db',
      'old-job'
    ])
    expect(ssh.events.streamLocal).toContain('/var/run/docker.sock')

    // Log stream qua SSH → module-event.
    port.deliver({
      t: 'module',
      id: 2,
      module: 'docker',
      op: { op: 'logs.subscribe', id: eng.containers[0]?.Id, tail: 5, timestamps: false }
    })
    await port.until(
      () => port.sent.some((m) => m.t === 'module-event' && m.event === 'logs'),
      10_000
    )

    // Module không được mở socket ngoài danh sách khai báo, kể cả qua SSH.
    const guarded = modules.guardSsh(dockerHost.manifest, {
      label: 'x',
      exec: () => Promise.reject(new Error('x')),
      spawn: () => Promise.reject(new Error('x')),
      openPty: () => Promise.reject(new Error('x')),
      openUnixSocket: () => Promise.reject(new Error('should not be called')),
      openTcp: () => Promise.reject(new Error('x'))
    })
    await expect(guarded.openUnixSocket('/etc/ssh/ssh_host_key')).rejects.toThrow(/not allowed/)
    await expect(guarded.openTcp('10.0.0.1', 22)).rejects.toThrow(/not allowed/)
  })
})
