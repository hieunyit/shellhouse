import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Docker Engine API giả (ADR-014 mục 6.6): server HTTP trên unix socket tạm (Windows: named pipe),
 * dữ liệu ghi sẵn, đủ cho danh sách, thao tác, log dạng multiplex, stats, events, pull, prune.
 */

export interface FakeContainer {
  Id: string
  Names: string[]
  Image: string
  ImageID: string
  State: string
  Status: string
  Created: number
  Ports: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[]
  Labels: Record<string, string>
  Env: string[]
  Tty: boolean
  logs: { stream: 1 | 2; text: string }[]
}

export interface EngineTestServer {
  /** Đường dẫn socket / pipe. */
  path: string
  containers: FakeContainer[]
  requests: string[]
  created: unknown[]
  /** Thêm một dòng log cho container (gửi ngay tới các luồng đang follow). */
  log(id: string, stream: 1 | 2, text: string): void
  close(): Promise<void>
}

function container(name: string, extra: Partial<FakeContainer> = {}): FakeContainer {
  return {
    Id: `${name}-${randomUUID().replace(/-/g, '')}`.slice(0, 64),
    Names: [`/${name}`],
    Image: 'nginx:1.27',
    ImageID: 'sha256:img1',
    State: 'running',
    Status: 'Up 2 hours',
    Created: Math.floor(Date.now() / 1000) - 7200,
    Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
    Labels: {},
    Env: ['PATH=/usr/bin', 'DB_PASSWORD=hunter2', 'MODE=prod'],
    Tty: false,
    logs: [
      { stream: 1, text: 'hello from stdout\n' },
      { stream: 2, text: 'warning on stderr\n' }
    ],
    ...extra
  }
}

function frame(stream: 1 | 2, text: string): Buffer {
  const data = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, data])
}

export async function startEngineTestServer(): Promise<EngineTestServer> {
  const dir = process.platform === 'win32' ? '' : mkdtempSync(join(tmpdir(), 'sh-docker-'))
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\shellhouse-docker-test-${randomUUID()}`
      : join(dir, 'docker.sock')
  const containers: FakeContainer[] = [
    container('web', {
      Labels: {
        'com.docker.compose.project': 'shop',
        'com.docker.compose.service': 'web',
        'com.docker.compose.project.working_dir': '/srv/shop',
        'com.docker.compose.project.config_files': '/srv/shop/compose.yaml'
      }
    }),
    container('db', {
      Image: 'postgres:16',
      ImageID: 'sha256:img2',
      Ports: [{ PrivatePort: 5432, Type: 'tcp' }],
      Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'db' }
    }),
    container('old-job', { State: 'exited', Status: 'Exited (0) 3 days ago', Ports: [] })
  ]
  const images = [
    { Id: 'sha256:img1', RepoTags: ['nginx:1.27'], Size: 190_000_000, Created: 1_700_000_000 },
    { Id: 'sha256:img2', RepoTags: ['postgres:16'], Size: 420_000_000, Created: 1_700_000_100 },
    { Id: 'sha256:dangling1', RepoTags: ['<none>:<none>'], Size: 5_000_000, Created: 1_600_000_000 }
  ]
  const volumes = [
    {
      Name: 'shop_data',
      Driver: 'local',
      Mountpoint: '/var/lib/docker/volumes/shop_data',
      Labels: { 'com.docker.compose.project': 'shop' }
    },
    { Name: 'orphan', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/orphan', Labels: null }
  ]
  const networks = [
    { Id: 'n-bridge', Name: 'bridge', Driver: 'bridge', Scope: 'local' },
    { Id: 'n-host', Name: 'host', Driver: 'host', Scope: 'local' },
    { Id: 'n-shop', Name: 'shop_default', Driver: 'bridge', Scope: 'local' },
    { Id: 'n-unused', Name: 'unused', Driver: 'bridge', Scope: 'local' }
  ]
  const requests: string[] = []
  /** Thân request tạo container (kiểm tham số `docker run`). */
  const created: unknown[] = []
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(c)
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as unknown
  }
  const followers = new Map<string, Set<{ res: ServerResponse; tty: boolean }>>()
  const eventStreams = new Set<ServerResponse>()
  const timers = new Set<NodeJS.Timeout>()

  const find = (id: string): FakeContainer | undefined =>
    containers.find((c) => c.Id === id || c.Id.startsWith(id) || c.Names[0] === `/${id}`)
  /** Trả `true` để các nhánh viết gọn `return json(...)`. */
  const json = (res: ServerResponse, status: number, body: unknown): true => {
    const data = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    })
    res.end(data)
    return true
  }
  const event = (action: string, id: string): void => {
    for (const res of eventStreams)
      res.write(
        `${JSON.stringify({ Type: 'container', Action: action, Actor: { ID: id }, time: Date.now() })}\n`
      )
  }

  const handleAsync = async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
    const url = new URL(req.url ?? '/', 'http://docker')
    const method = req.method ?? 'GET'
    requests.push(`${method} ${url.pathname}${url.search}`)
    if (url.pathname === '/_ping') {
      res.writeHead(200, { 'Api-Version': '1.45', 'Content-Type': 'text/plain' })
      res.end('OK')
      return true
    }
    const p = url.pathname.replace(/^\/v1\.41/, '')
    let m: RegExpExecArray | null
    if (method === 'GET' && p === '/system/df')
      return json(res, 200, {
        Images: images.map((i) => ({
          Size: i.Size,
          SharedSize: 0,
          Containers: containers.filter((c) => c.ImageID === i.Id).length
        })),
        Containers: containers.map((c) => ({ SizeRw: 1000, State: c.State })),
        Volumes: volumes.map((v) => ({
          UsageData: { Size: 2000, RefCount: v.Name === 'orphan' ? 0 : 1 }
        })),
        BuildCache: [{ Size: 3000, InUse: false }]
      })
    if (method === 'GET' && (m = /^\/containers\/([^/]+)\/top$/.exec(p)))
      return json(res, 200, {
        Titles: ['UID', 'PID', 'CMD'],
        Processes: [['root', '1', 'nginx: master process nginx -g daemon off;']]
      })
    if (method === 'GET' && (m = /^\/images\/(.+)\/history$/.exec(p)))
      return json(res, 200, [
        {
          Id: 'sha256:l2',
          Created: 1_700_000_100,
          CreatedBy: '/bin/sh -c #(nop)  CMD ["nginx"]',
          Size: 0,
          Comment: ''
        },
        {
          Id: 'sha256:l1',
          Created: 1_700_000_000,
          CreatedBy: '/bin/sh -c apt-get install nginx',
          Size: 50_000_000,
          Comment: ''
        }
      ])
    if (method === 'POST' && p === '/containers/create') {
      const body = (await readBody(req)) as {
        Image: string
        Env?: string[]
        HostConfig?: { PortBindings?: Record<string, { HostPort: string }[]> }
      }
      if (
        !images.some(
          (i) => i.RepoTags.includes(body.Image) || i.RepoTags.includes(`${body.Image}:latest`)
        )
      )
        return json(res, 404, { message: `No such image: ${body.Image}` })
      const name = url.searchParams.get('name') || `created-${containers.length}`
      const c = container(name, {
        Image: body.Image,
        State: 'created',
        Env: body.Env ?? [],
        Ports: Object.entries(body.HostConfig?.PortBindings ?? {}).map(([k, v]) => ({
          PrivatePort: Number(k.split('/')[0]),
          PublicPort: Number(v[0]?.HostPort) || undefined,
          Type: k.split('/')[1] ?? 'tcp'
        }))
      })
      containers.push(c)
      created.push(body)
      return json(res, 201, { Id: c.Id, Warnings: [] })
    }
    if (method === 'GET' && p === '/version')
      return json(res, 200, {
        Version: '27.1.1',
        ApiVersion: '1.46',
        Os: 'linux',
        Arch: 'amd64',
        Components: [{ Name: 'Engine' }]
      })
    if (method === 'GET' && p === '/info')
      return json(res, 200, {
        Containers: containers.length,
        ContainersRunning: containers.filter((c) => c.State === 'running').length,
        Images: images.length,
        OperatingSystem: 'Ubuntu 24.04'
      })
    if (method === 'GET' && p === '/containers/json') {
      const all = url.searchParams.get('all') === 'true'
      return json(
        res,
        200,
        containers
          .filter((c) => all || c.State === 'running')
          .map((c) => ({
            Id: c.Id,
            Names: c.Names,
            Image: c.Image,
            ImageID: c.ImageID,
            State: c.State,
            Status: c.Status,
            Created: c.Created,
            Ports: c.Ports,
            Labels: c.Labels
          }))
      )
    }
    if ((m = /^\/containers\/([^/]+)\/json$/.exec(p))) {
      const c = find(decodeURIComponent(m[1] ?? ''))
      if (!c) return json(res, 404, { message: `No such container: ${m[1] ?? ''}` })
      return json(res, 200, {
        Id: c.Id,
        Name: c.Names[0],
        State: { Status: c.State },
        Config: { Tty: c.Tty, Env: c.Env, Image: c.Image }
      })
    }
    if (
      method === 'POST' &&
      (m = /^\/containers\/([^/]+)\/(start|stop|restart|pause|unpause|kill|rename)$/.exec(p))
    ) {
      const c = find(decodeURIComponent(m[1] ?? ''))
      if (!c) return json(res, 404, { message: 'No such container' })
      const action = m[2] ?? ''
      if (action === 'rename') c.Names = [`/${url.searchParams.get('name') ?? ''}`]
      else if (action === 'stop' || action === 'kill') c.State = 'exited'
      else if (action === 'pause') c.State = 'paused'
      else c.State = 'running'
      event(action, c.Id)
      return json(res, 204, undefined)
    }
    if (method === 'DELETE' && (m = /^\/containers\/([^/]+)$/.exec(p))) {
      const c = find(decodeURIComponent(m[1] ?? ''))
      if (!c) return json(res, 404, { message: 'No such container' })
      if (c.State === 'running' && url.searchParams.get('force') !== 'true')
        return json(res, 409, {
          message: `You cannot remove a running container ${c.Id}. Stop the container before attempting removal or force remove`
        })
      containers.splice(containers.indexOf(c), 1)
      event('destroy', c.Id)
      return json(res, 204, undefined)
    }
    if ((m = /^\/containers\/([^/]+)\/logs$/.exec(p))) {
      const c = find(decodeURIComponent(m[1] ?? ''))
      if (!c) return json(res, 404, { message: 'No such container' })
      res.writeHead(200, {
        'Content-Type': c.Tty
          ? 'application/vnd.docker.raw-stream'
          : 'application/vnd.docker.multiplexed-stream'
      })
      const tail = Number(url.searchParams.get('tail') ?? '0')
      for (const l of c.logs.slice(-tail || undefined))
        res.write(c.Tty ? l.text : frame(l.stream, l.text))
      if (url.searchParams.get('follow') !== 'true') {
        res.end()
        return true
      }
      const set = followers.get(c.Id) ?? new Set()
      const entry = { res, tty: c.Tty }
      set.add(entry)
      followers.set(c.Id, set)
      res.on('close', () => set.delete(entry))
      return true
    }
    if ((m = /^\/containers\/([^/]+)\/stats$/.exec(p))) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      let n = 0
      const tick = (): void => {
        n++
        res.write(
          `${JSON.stringify({
            read: new Date().toISOString(),
            cpu_stats: {
              cpu_usage: { total_usage: 1_000_000 * n },
              system_cpu_usage: 10_000_000 * n,
              online_cpus: 2
            },
            precpu_stats: {
              cpu_usage: { total_usage: 1_000_000 * (n - 1) },
              system_cpu_usage: 10_000_000 * (n - 1)
            },
            memory_stats: {
              usage: 60_000_000,
              limit: 1_000_000_000,
              stats: { inactive_file: 10_000_000 }
            },
            networks: { eth0: { rx_bytes: 1000 * n, tx_bytes: 500 * n } }
          })}\n`
        )
      }
      tick()
      if (url.searchParams.get('stream') === 'false') {
        res.end()
        return true
      }
      const timer = setInterval(tick, 100)
      timers.add(timer)
      res.on('close', () => {
        clearInterval(timer)
        timers.delete(timer)
      })
      return true
    }
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.flushHeaders()
      eventStreams.add(res)
      res.on('close', () => eventStreams.delete(res))
      return true
    }
    if (method === 'GET' && p === '/images/json') {
      const dangling = url.searchParams.get('filters')?.includes('dangling')
      return json(
        res,
        200,
        images.filter((i) => !dangling || i.RepoTags[0] === '<none>:<none>')
      )
    }
    if (method === 'DELETE' && (m = /^\/images\/(.+)$/.exec(p))) {
      const id = decodeURIComponent(m[1] ?? '')
      const i = images.findIndex((x) => x.Id === id || x.RepoTags.includes(id))
      if (i < 0) return json(res, 404, { message: 'No such image' })
      images.splice(i, 1)
      return json(res, 200, [{ Deleted: id }])
    }
    if (method === 'POST' && p === '/images/create') {
      const from = url.searchParams.get('fromImage') ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (from === 'does-not-exist') {
        res.end(`${JSON.stringify({ error: 'pull access denied for does-not-exist' })}\n`)
        return true
      }
      const lines = [
        { status: `Pulling from library/${from}`, id: url.searchParams.get('tag') ?? 'latest' },
        { status: 'Downloading', id: 'layer1', progressDetail: { current: 50, total: 100 } },
        { status: 'Download complete', id: 'layer1' },
        { status: `Status: Downloaded newer image for ${from}` }
      ]
      for (const l of lines) res.write(`${JSON.stringify(l)}\n`)
      images.push({
        Id: `sha256:${from}`,
        RepoTags: [`${from}:${url.searchParams.get('tag') ?? 'latest'}`],
        Size: 1,
        Created: 1
      })
      res.end()
      return true
    }
    if (method === 'GET' && p === '/volumes') {
      const dangling = url.searchParams.get('filters')?.includes('dangling')
      return json(res, 200, {
        Volumes: volumes.filter((v) => !dangling || v.Name === 'orphan'),
        Warnings: null
      })
    }
    if (method === 'DELETE' && (m = /^\/volumes\/(.+)$/.exec(p))) {
      const i = volumes.findIndex((v) => v.Name === decodeURIComponent(m?.[1] ?? ''))
      if (i < 0) return json(res, 404, { message: 'no such volume' })
      volumes.splice(i, 1)
      return json(res, 204, undefined)
    }
    if (method === 'GET' && p === '/networks') {
      const dangling = url.searchParams.get('filters')?.includes('dangling')
      return json(
        res,
        200,
        networks.filter((n) => !dangling || n.Name === 'unused' || n.Name === 'bridge')
      )
    }
    if (method === 'DELETE' && (m = /^\/networks\/(.+)$/.exec(p))) {
      const i = networks.findIndex((n) => n.Id === decodeURIComponent(m?.[1] ?? ''))
      if (i < 0) return json(res, 404, { message: 'no such network' })
      networks.splice(i, 1)
      return json(res, 204, undefined)
    }
    if (method === 'POST' && p === '/containers/prune') {
      const gone = containers.filter((c) => c.State === 'exited')
      for (const c of gone) containers.splice(containers.indexOf(c), 1)
      return json(res, 200, { ContainersDeleted: gone.map((c) => c.Id), SpaceReclaimed: 1234 })
    }
    if (method === 'POST' && p === '/images/prune') {
      const gone = images.filter((i) => i.RepoTags[0] === '<none>:<none>')
      for (const i of gone) images.splice(images.indexOf(i), 1)
      return json(res, 200, {
        ImagesDeleted: gone.map((i) => ({ Deleted: i.Id })),
        SpaceReclaimed: 5_000_000
      })
    }
    return json(res, 404, { message: `page not found: ${method} ${p}` })
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    void handleAsync(req, res)
  }
  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return {
    path,
    containers,
    requests,
    created,
    log: (id, stream, text) => {
      const c = find(id)
      c?.logs.push({ stream, text })
      for (const f of followers.get(c?.Id ?? '') ?? [])
        f.res.write(f.tty ? text : frame(stream, text))
    },
    close: async () => {
      for (const t of timers) clearInterval(t)
      for (const r of eventStreams) r.destroy()
      for (const set of followers.values()) for (const f of set) f.res.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve()
        })
      )
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  }
}
