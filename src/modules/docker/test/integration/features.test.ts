import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiBackend } from '../../session-host/api-backend'
import { CliBackend } from '../../session-host/cli-backend'
import { EngineClient } from '../../session-host/engine'
import { DockerService, type DockerServiceDeps } from '../../session-host/service'
import type { DockerCli } from '../../session-host/backend'
import type {
  ContainerFileList,
  ContainerRow,
  CopyResult,
  PruneResult,
  RegistryAuth
} from '../../shared/ops'
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

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
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

const REGISTRIES = {
  hub: { server: 'docker.io', username: 'u', password: 'p' },
  ghcr: { server: 'ghcr.io', username: 'u', password: 'p' },
  bad: { server: 'ghcr.io', username: 'u', password: 'wrong' }
} satisfies Record<string, RegistryAuth>

/** Phần tử thứ i (test: không có thì lỗi rõ thay vì `!`). */
function nth<T>(list: readonly T[], i: number): T {
  const v = list[i]
  if (v === undefined) throw new Error(`no item ${String(i)}`)
  return v
}

function service(deps: Partial<DockerServiceDeps> & Pick<DockerServiceDeps, 'connect'>) {
  const events: { event: string; data: unknown }[] = []
  const s = new DockerService({
    cli: noCli,
    openPty: () => Promise.reject(new Error('no pty')),
    emit: (event, data) => events.push({ event, data }),
    log: () => undefined,
    registryAuth: (id) => {
      const r = (REGISTRIES as Record<string, RegistryAuth | undefined>)[id]
      return r ? Promise.resolve(r) : Promise.reject(new Error('The registry no longer exists'))
    },
    ...deps
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

const apiService = (server: EngineTestServer, deps: Partial<DockerServiceDeps> = {}) =>
  service({
    connect: () => Promise.resolve(new ApiBackend(new EngineClient(socketTo(server.path)))),
    ...deps
  })

/** Đợi sự kiện kết thúc của một luồng pull / push. */
async function streamResult(
  svc: ReturnType<typeof service>,
  kind: 'pull' | 'push',
  subscription: string
): Promise<{ status: string; error?: string }> {
  const done = (): { status: string; error?: string } | undefined =>
    svc.events
      .filter((e) => e.event === kind)
      .map((e) => e.data as { subscription: string; done: boolean; status: string; error?: string })
      .find((d) => d.subscription === subscription && d.done)
  await svc.until(() => done() !== undefined)
  return done() ?? { status: '' }
}

describe('healthcheck', () => {
  it('trạng thái healthy / unhealthy / starting đọc từ Status', async () => {
    const server = await engine()
    nth(server.containers, 1).Status = 'Up 5 seconds (health: starting)'
    const { run } = apiService(server)
    const rows = await run<ContainerRow[]>({ op: 'containers', all: true })
    expect(rows.map((r) => r.health)).toEqual(['healthy', 'starting', null])
  })
})

describe('volume / network', () => {
  it('tạo volume (driver, opts, nhãn), tạo network (IPAM, internal, attachable), nối / tách container', async () => {
    const server = await engine()
    const { run } = apiService(server)
    const v = await run<{ name: string }>({
      op: 'volume.create',
      spec: { name: 'pgdata', driver: 'local', driverOpts: { type: 'tmpfs' }, labels: { a: 'b' } }
    })
    expect(v.name).toBe('pgdata')
    expect(server.volumes.some((x) => x.Name === 'pgdata')).toBe(true)
    await expect(
      run({
        op: 'volume.create',
        spec: { name: 'pgdata', driver: 'local', driverOpts: {}, labels: {} }
      })
    ).rejects.toThrow(/already exists/)

    const n = await run<{ id: string }>({
      op: 'network.create',
      spec: {
        name: 'backend',
        driver: 'bridge',
        subnet: '172.28.0.0/16',
        gateway: '172.28.0.1',
        internal: true,
        attachable: true,
        labels: { team: 'x' },
        options: {}
      }
    })
    expect(n.id).toMatch(/^n-/)
    expect(server.networks.find((x) => x.Name === 'backend')?.body).toMatchObject({
      Driver: 'bridge',
      Internal: true,
      Attachable: true,
      Labels: { team: 'x' },
      IPAM: { Config: [{ Subnet: '172.28.0.0/16', Gateway: '172.28.0.1' }] }
    })

    const web = nth(server.containers, 0).Id
    await run({
      op: 'network.connect',
      network: n.id,
      container: web,
      aliases: ['api'],
      ipv4: '172.28.0.10'
    })
    expect(server.connections).toEqual([
      {
        network: 'backend',
        container: web,
        body: {
          Container: web,
          EndpointConfig: { Aliases: ['api'], IPAMConfig: { IPv4Address: '172.28.0.10' } }
        }
      }
    ])
    await run({ op: 'network.disconnect', network: n.id, container: web, force: false })
    expect(server.connections).toEqual([])
  })

  it('chỉ đọc: tạo / nối bị chặn; xem file / tải về vẫn được', async () => {
    const server = await engine()
    const { run } = apiService(server)
    await run({ op: 'configure', readOnly: true })
    await expect(
      run({
        op: 'network.create',
        spec: {
          name: 'x',
          driver: 'bridge',
          internal: false,
          attachable: false,
          labels: {},
          options: {}
        }
      })
    ).rejects.toThrow(/Read-only/)
    await expect(
      run({ op: 'files.upload', id: 'web', dir: '/tmp', localPaths: ['/etc/hosts'] })
    ).rejects.toThrow(/Read-only/)
    await expect(run({ op: 'image.tag', id: 'nginx:1.27', target: 'x:1' })).rejects.toThrow(
      /Read-only/
    )
    const list = await run<ContainerFileList>({
      op: 'files.list',
      id: nth(server.containers, 0).Id,
      path: '/etc'
    })
    expect(list.entries.map((e) => e.name)).toContain('hosts')
  })
})

describe('dọn dẹp: build cache, mọi image không dùng', () => {
  it('build cache: xem trước = cache không dùng (đúng phần reclaimable), xoá với all=true', async () => {
    const server = await engine()
    const { run } = apiService(server)
    const preview = await run<PruneResult>({ op: 'prune', what: 'buildCache', dryRun: true })
    expect(preview.items).toHaveLength(1)
    expect(preview.items[0]).toContain('cache-free')
    expect(preview.reclaimed).toBe(3000)
    const done = await run<PruneResult>({ op: 'prune', what: 'buildCache', dryRun: false })
    expect(done.reclaimed).toBe(3000)
    expect(server.requests).toContain('POST /v1.45/build/prune?all=true')
    expect(server.buildCache.map((c) => c.ID)).toEqual(['cache-used-1'])
  })

  it('image: mặc định chỉ dangling; all = mọi image không container nào dùng', async () => {
    const server = await engine()
    const { run } = apiService(server)
    const dangling = await run<PruneResult>({ op: 'prune', what: 'images', dryRun: true })
    expect(dangling.items).toEqual(['dangling1'])
    // old-job (đang dừng) vẫn dùng img1 → không bị tính.
    const all = await run<PruneResult>({ op: 'prune', what: 'images', dryRun: true, all: true })
    expect(all.items).toEqual(['dangling1'])
    await run({ op: 'image.pull', ref: 'redis:7' })
    await new Promise((r) => setTimeout(r, 100))
    const after = await run<PruneResult>({ op: 'prune', what: 'images', dryRun: true, all: true })
    expect(after.items).toContain('redis:7')
    await run({ op: 'prune', what: 'images', dryRun: false, all: true })
    const left = await run<{ tags: string[] }[]>({ op: 'images' })
    expect(left.flatMap((i) => i.tags).sort()).toEqual(['nginx:1.27', 'postgres:16'])
  })
})

describe('registry: kéo / đẩy image riêng tư, tag, thử đăng nhập', () => {
  it('pull ảnh riêng tư: không đăng nhập → lỗi rõ; có registry → header X-Registry-Auth', async () => {
    const server = await engine()
    const svc = apiService(server)
    const anon = await svc.run<{ subscription: string }>({
      op: 'image.pull',
      ref: 'ghcr.io/acme/private-app:1'
    })
    expect((await streamResult(svc, 'pull', anon.subscription)).error).toMatch(/docker login/)
    const authed = await svc.run<{ subscription: string }>({
      op: 'image.pull',
      ref: 'ghcr.io/acme/private-app:1',
      registry: 'ghcr'
    })
    expect((await streamResult(svc, 'pull', authed.subscription)).error).toBeUndefined()
    expect(server.registryAuth.at(-1)?.auth).toEqual({
      username: 'u',
      password: 'p',
      serveraddress: 'ghcr.io'
    })
  })

  it('không gửi mật khẩu của registry này tới máy chủ khác', async () => {
    const server = await engine()
    const svc = apiService(server)
    await expect(
      svc.run({ op: 'image.pull', ref: 'evil.example.com/x:1', registry: 'ghcr' })
    ).rejects.toThrow(/not on ghcr\.io/)
    // Docker Hub: "nginx" / "org/app" thuộc docker.io.
    await expect(
      svc.run({ op: 'image.pull', ref: 'acme/private-tool', registry: 'ghcr' })
    ).rejects.toThrow(/not on ghcr\.io/)
    expect(server.requests.some((r) => r.includes('/images/create'))).toBe(false)
    const hub = await svc.run<{ subscription: string }>({
      op: 'image.pull',
      ref: 'acme/private-tool',
      registry: 'hub'
    })
    await streamResult(svc, 'pull', hub.subscription)
    expect(server.registryAuth.at(-1)?.auth['serveraddress']).toBe('https://index.docker.io/v1/')
  })

  it('tag rồi push: tiến độ; sai mật khẩu → lỗi của registry; thử đăng nhập', async () => {
    const server = await engine()
    const svc = apiService(server)
    await svc.run({ op: 'image.tag', id: 'nginx:1.27', target: 'ghcr.io/acme/web:2' })
    const images = await svc.run<{ tags: string[] }[]>({ op: 'images' })
    expect(images.flatMap((i) => i.tags)).toContain('ghcr.io/acme/web:2')

    const ok = await svc.run<{ subscription: string }>({
      op: 'image.push',
      ref: 'ghcr.io/acme/web:2',
      registry: 'ghcr'
    })
    expect((await streamResult(svc, 'push', ok.subscription)).error).toBeUndefined()
    expect(server.requests).toContain('POST /v1.45/images/ghcr.io%2Facme%2Fweb/push?tag=2')
    const progress = svc.events
      .filter((e) => e.event === 'push')
      .map((e) => (e.data as { progress: number | null }).progress)
    expect(progress).toContain(0.5)

    const bad = await svc.run<{ subscription: string }>({
      op: 'image.push',
      ref: 'ghcr.io/acme/web:2',
      registry: 'bad'
    })
    expect((await streamResult(svc, 'push', bad.subscription)).error).toMatch(/unauthorized/)

    expect(await svc.run({ op: 'registry.check', registry: 'ghcr' })).toEqual({
      status: 'Login Succeeded'
    })
    await expect(svc.run({ op: 'registry.check', registry: 'bad' })).rejects.toThrow(
      /incorrect username or password/
    )
  })
})

describe('tab Files: duyệt, tải về, tải lên', () => {
  it('liệt kê bằng sh trong container: kiểu, kích thước, ngày; liên kết tới thư mục mở được', async () => {
    const server = await engine()
    const { run } = apiService(server)
    const web = nth(server.containers, 0).Id
    const root = await run<ContainerFileList>({ op: 'files.list', id: web, path: '/' })
    expect(root.via).toBe('exec')
    expect(root.entries.map((e) => [e.name, e.type])).toEqual([
      ['bin', 'link'],
      ['etc', 'dir'],
      ['usr', 'dir'],
      ['var', 'dir']
    ])
    expect(root.entries[0]?.linkDir).toBe(true)
    const etc = await run<ContainerFileList>({ op: 'files.list', id: web, path: '/etc' })
    expect(etc.entries.find((e) => e.name === 'hosts')).toMatchObject({
      type: 'file',
      size: 20,
      mtime: 1_700_000_000_000,
      mode: '-rw-r--r--'
    })
    await expect(run({ op: 'files.list', id: web, path: '/nope' })).rejects.toThrow(
      /Cannot open \/nope: No such file or directory/
    )
  })

  it('không có shell (distroless) hoặc container dừng → đọc archive', async () => {
    const server = await engine()
    const { run } = apiService(server)
    nth(server.containers, 0).shell = false
    const list = await run<ContainerFileList>({
      op: 'files.list',
      id: nth(server.containers, 0).Id,
      path: '/etc/nginx'
    })
    expect(list.via).toBe('archive')
    expect(list.entries.map((e) => [e.name, e.type])).toEqual([
      ['conf.d', 'dir'],
      ['nginx.conf', 'file']
    ])
    const stopped = await run<ContainerFileList>({
      op: 'files.list',
      id: nth(server.containers, 2).Id,
      path: '/'
    })
    expect(stopped.via).toBe('archive')
    expect(stopped.entries.map((e) => e.name)).toEqual(['bin', 'etc', 'usr', 'var'])
  })

  it('tải thư mục về: giữ cấu trúc; tải lần nữa không ghi đè ("nginx (2)")', async () => {
    const server = await engine()
    const { run } = apiService(server)
    const dir = tempDir('sh-docker-dl-')
    const web = nth(server.containers, 0).Id
    const r = await run<CopyResult>({
      op: 'files.download',
      id: web,
      paths: ['/etc/nginx', '/etc/hosts'],
      localDir: dir
    })
    expect(r.files).toBe(3)
    expect(readFileSync(join(dir, 'nginx', 'conf.d', 'default.conf'), 'utf8')).toContain(
      'listen 80'
    )
    expect(readFileSync(join(dir, 'hosts'), 'utf8')).toBe('127.0.0.1 localhost\n')
    await run({ op: 'files.download', id: web, paths: ['/etc/nginx'], localDir: dir })
    expect(existsSync(join(dir, 'nginx (2)', 'nginx.conf'))).toBe(true)
    await expect(
      run({ op: 'files.download', id: web, paths: ['/missing'], localDir: dir })
    ).rejects.toThrow(/Could not find the file/)
  })

  it('tải lên: file + thư mục (tên dài > 100 byte) vào thư mục của container', async () => {
    const server = await engine()
    const { run } = apiService(server)
    const src = tempDir('sh-docker-ul-')
    const longName = `${'x'.repeat(120)}.txt`
    mkdirSync(join(src, 'site'))
    writeFileSync(join(src, 'site', 'index.html'), '<h1>hi</h1>')
    writeFileSync(join(src, 'site', longName), 'long')
    writeFileSync(join(src, 'app.conf'), 'a=1')
    const web = nth(server.containers, 0)
    const r = await run<CopyResult>({
      op: 'files.upload',
      id: web.Id,
      dir: '/var/log/nginx',
      localPaths: [join(src, 'site'), join(src, 'app.conf')]
    })
    expect(r).toMatchObject({ files: 3, bytes: 11 + 4 + 3 })
    const content = (p: string): string => {
      const f = web.files[p]
      return f?.type === 'file' ? Buffer.from(f.content).toString('utf8') : ''
    }
    expect(content('/var/log/nginx/site/index.html')).toBe('<h1>hi</h1>')
    expect(content(`/var/log/nginx/site/${longName}`)).toBe('long')
    expect(content('/var/log/nginx/app.conf')).toBe('a=1')
    await expect(
      run({ op: 'files.upload', id: web.Id, dir: '/nope', localPaths: [join(src, 'app.conf')] })
    ).rejects.toThrow('Could not find the folder /nope in the container')
  })
})

// ——— CLI dự phòng: tham số lệnh ———

interface FakeProgram {
  args: string[]
  stdout: Buffer[]
  stderr: string
  code: number
}

function fakeCli(
  handle: (
    args: readonly string[],
    input?: string | Buffer
  ) => {
    code?: number
    stdout?: string | Buffer
    stderr?: string
  } = () => ({})
): { cli: DockerCli; calls: { args: string[]; input?: string | Buffer }[]; temp: string[] } {
  const calls: { args: string[]; input?: string | Buffer }[] = []
  const temp: string[] = []
  const cli: DockerCli = {
    exec: (args, options) => {
      calls.push({
        args: [...args],
        ...(options?.input !== undefined ? { input: options.input } : {})
      })
      const r = handle(args, options?.input)
      return Promise.resolve({
        code: r.code ?? 0,
        stdout: typeof r.stdout === 'string' ? r.stdout : (r.stdout?.toString('utf8') ?? ''),
        stderr: r.stderr ?? ''
      })
    },
    spawn: (args) => {
      calls.push({ args: [...args] })
      const r = handle(args)
      const program: FakeProgram = {
        args: [...args],
        stdout: r.stdout === undefined ? [] : [Buffer.from(r.stdout)],
        stderr: r.stderr ?? '',
        code: r.code ?? 0
      }
      const out: ((c: Buffer) => void)[] = []
      const err: ((c: Buffer) => void)[] = []
      const exit: ((c: number | null) => void)[] = []
      setTimeout(() => {
        for (const c of program.stdout) for (const l of out) l(c)
        if (program.stderr) for (const l of err) l(Buffer.from(program.stderr))
        for (const l of exit) l(program.code)
      }, 5)
      return Promise.resolve({
        onStdout: (l) => out.push(l),
        onStderr: (l) => err.push(l),
        onExit: (l) => exit.push(l),
        kill: () => undefined
      })
    },
    tempDir: () => {
      const path = `/tmp/cfg-${String(temp.length)}`
      temp.push(path)
      return Promise.resolve({
        path,
        remove: () => {
          temp.splice(temp.indexOf(path), 1)
          return Promise.resolve()
        }
      })
    }
  }
  return { cli, calls, temp }
}

describe('CLI dự phòng: thao tác mới', () => {
  it('pull / push riêng tư: login --password-stdin vào --config tạm, xoá ngay sau đó', async () => {
    const { cli, calls, temp } = fakeCli()
    const backend = new CliBackend(cli)
    const signal = new AbortController().signal
    await backend.imagePull('ghcr.io/acme/app:1', REGISTRIES.ghcr, () => undefined, signal)
    expect(calls[0]).toEqual({
      args: ['--config', '/tmp/cfg-0', 'login', '--username', 'u', '--password-stdin', 'ghcr.io'],
      input: 'p'
    })
    expect(calls[1]?.args).toEqual(['--config', '/tmp/cfg-0', 'pull', '--', 'ghcr.io/acme/app:1'])
    expect(temp).toEqual([])
    await backend.imagePush('nginx:1', null, () => undefined, signal)
    expect(calls.at(-1)?.args).toEqual(['push', '--', 'nginx:1'])
    // Mật khẩu không bao giờ nằm trong tham số dòng lệnh.
    expect(calls.flatMap((c) => c.args)).not.toContain('p')
  })

  it('đăng nhập lỗi → báo lỗi, vẫn xoá thư mục tạm', async () => {
    const { cli, temp } = fakeCli((args) =>
      args.includes('login') ? { code: 1, stderr: 'Error response from daemon: unauthorized' } : {}
    )
    const backend = new CliBackend(cli)
    await expect(
      backend.registryLogin(REGISTRIES.bad, new AbortController().signal)
    ).rejects.toThrow(/unauthorized/)
    expect(temp).toEqual([])
  })

  it('volume / network: tham số đúng thứ tự, tên sau `--`', async () => {
    const { cli, calls } = fakeCli((args) => ({
      stdout: args[0] === 'volume' ? 'data\n' : 'abc123\n'
    }))
    const backend = new CliBackend(cli)
    expect(
      await backend.volumeCreate({
        name: 'data',
        driver: 'local',
        driverOpts: { type: 'nfs' },
        labels: { app: 'x' }
      })
    ).toBe('data')
    await backend.networkCreate({
      name: 'lan',
      driver: 'macvlan',
      subnet: '192.168.1.0/24',
      gateway: '192.168.1.1',
      ipRange: '192.168.1.128/25',
      internal: false,
      attachable: true,
      labels: {},
      options: { parent: 'eth0' }
    })
    await backend.networkConnect('lan', 'web', ['api', 'www'], '192.168.1.130')
    await backend.networkDisconnect('lan', 'web', true)
    expect(calls.map((c) => c.args)).toEqual([
      [
        'volume',
        'create',
        '--driver',
        'local',
        '--opt',
        'type=nfs',
        '--label',
        'app=x',
        '--',
        'data'
      ],
      [
        'network',
        'create',
        '--driver',
        'macvlan',
        '--subnet',
        '192.168.1.0/24',
        '--gateway',
        '192.168.1.1',
        '--ip-range',
        '192.168.1.128/25',
        '--attachable',
        '--opt',
        'parent=eth0',
        '--',
        'lan'
      ],
      [
        'network',
        'connect',
        '--alias',
        'api',
        '--alias',
        'www',
        '--ip',
        '192.168.1.130',
        '--',
        'lan',
        'web'
      ],
      ['network', 'disconnect', '-f', '--', 'lan', 'web']
    ])
  })

  it('build: `docker build --progress=plain` qua CLI, output trực tiếp, lỗi báo dòng lỗi cuối', async () => {
    const { cli, calls } = fakeCli((args) =>
      args.includes('/srv/broken')
        ? { code: 1, stderr: '#5 ERROR: failed to solve: dockerfile parse error\n' }
        : { stderr: '#1 [internal] load build definition\n#2 DONE 0.1s\n' }
    )
    const svc = service({
      connect: () => Promise.resolve(new CliBackend(cli)),
      cli
    })
    const ok = await svc.run<{ subscription: string }>({
      op: 'build',
      spec: {
        context: '/srv/app',
        dockerfile: 'docker/Dockerfile',
        tags: ['app:dev'],
        buildArgs: ['VERSION=1'],
        target: 'prod',
        noCache: true,
        pull: false
      }
    })
    await svc.until(() => svc.events.some((e) => e.event === 'build-end'))
    expect(calls.at(-1)?.args).toEqual([
      'build',
      '--progress=plain',
      '-f',
      '/srv/app/docker/Dockerfile',
      '-t',
      'app:dev',
      '--build-arg',
      'VERSION=1',
      '--target',
      'prod',
      '--no-cache',
      '--',
      '/srv/app'
    ])
    const text = svc.events
      .filter(
        (e) =>
          e.event === 'build' &&
          (e.data as { subscription: string }).subscription === ok.subscription
      )
      .map((e) => (e.data as { text: string }).text)
      .join('')
    expect(text).toContain('load build definition')
    expect(svc.events.find((e) => e.event === 'build-end')?.data).toEqual({
      subscription: ok.subscription
    })

    const bad = await svc.run<{ subscription: string }>({
      op: 'build',
      spec: { context: '/srv/broken', tags: [], buildArgs: [], noCache: false, pull: true }
    })
    await svc.until(() =>
      svc.events.some(
        (e) =>
          e.event === 'build-end' &&
          (e.data as { subscription: string }).subscription === bad.subscription
      )
    )
    expect(
      svc.events.find(
        (e) =>
          e.event === 'build-end' &&
          (e.data as { subscription: string }).subscription === bad.subscription
      )?.data
    ).toMatchObject({ error: '#5 ERROR: failed to solve: dockerfile parse error' })
  })

  it('build bị chặn ở chế độ chỉ đọc', async () => {
    const { cli } = fakeCli()
    const svc = service({ connect: () => Promise.resolve(new CliBackend(cli)), cli })
    await svc.run({ op: 'configure', readOnly: true })
    await expect(
      svc.run({
        op: 'build',
        spec: { context: '/srv/app', tags: [], buildArgs: [], noCache: false, pull: false }
      })
    ).rejects.toThrow(/Read-only/)
  })

  it('files qua CLI: `docker cp <id>:<path> -` (tar ra stdout), tải lên `docker cp - <id>:<dir>` qua stdin', async () => {
    const server = await engine()
    // Tar thật lấy từ Engine giả (cùng dạng `docker cp` in ra).
    const res = await fetchArchive(server, nth(server.containers, 0).Id, '/etc/nginx')
    const { cli, calls } = fakeCli((args) =>
      args[0] === 'cp' && args.at(-1) === '-' ? { stdout: res } : {}
    )
    const svc = service({ connect: () => Promise.resolve(new CliBackend(cli)), cli })
    const dir = tempDir('sh-docker-cli-dl-')
    const r = await svc.run<CopyResult>({
      op: 'files.download',
      id: 'web',
      paths: ['/etc/nginx'],
      localDir: dir
    })
    expect(r.files).toBe(2)
    expect(calls[0]?.args).toEqual(['cp', '--', 'web:/etc/nginx', '-'])
    expect(readFileSync(join(dir, 'nginx', 'nginx.conf'), 'utf8')).toBe('worker_processes 1;\n')

    const src = tempDir('sh-docker-cli-ul-')
    writeFileSync(join(src, 'a.txt'), 'hello')
    await svc.run({ op: 'files.upload', id: 'web', dir: '/tmp', localPaths: [join(src, 'a.txt')] })
    const upload = calls.at(-1)
    expect(upload?.args).toEqual(['cp', '-', 'web:/tmp'])
    expect(Buffer.isBuffer(upload?.input)).toBe(true)
    expect((upload?.input as Buffer).length % 512).toBe(0)
  })
})

async function fetchArchive(server: EngineTestServer, id: string, path: string): Promise<Buffer> {
  const backend = new ApiBackend(new EngineClient(socketTo(server.path)))
  const chunks: Buffer[] = []
  for await (const c of await backend.archive(id, path, new AbortController().signal))
    chunks.push(c)
  return Buffer.concat(chunks)
}
