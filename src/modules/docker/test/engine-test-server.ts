import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseTar, tarHeader } from '../session-host/tar'

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
  /** Hệ thống file giả: đường dẫn tuyệt đối → mục (thư mục không cần khai báo cha). */
  files: Record<string, FakeFile>
  /** false = image distroless (không có `sh`): exec lỗi 127, tab Files đọc archive. */
  shell: boolean
}

export type FakeFile =
  | { type: 'dir'; mtime?: number }
  | { type: 'file'; content: string | Buffer; mtime?: number }
  | { type: 'link'; target: string }

export interface EngineTestServer {
  /** Đường dẫn socket / pipe. */
  path: string
  containers: FakeContainer[]
  volumes: { Name: string }[]
  requests: string[]
  created: unknown[]
  /** Header X-Registry-Auth đã nhận (giải mã) theo đường dẫn. */
  registryAuth: { path: string; auth: Record<string, unknown> }[]
  networks: { Id: string; Name: string; Driver: string; Scope: string; body?: unknown }[]
  /** Container nối vào network (connect / disconnect). */
  connections: { network: string; container: string; body: unknown }[]
  buildCache: { ID: string; Size: number; InUse: boolean; Description: string }[]
  /** Thêm một dòng log cho container (gửi ngay tới các luồng đang follow). */
  log(id: string, stream: 1 | 2, text: string): void
  /** Ngắt mọi luồng /events đang mở (daemon khởi động lại). */
  dropEvents(): void
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
    files: {
      '/etc/hosts': { type: 'file', content: '127.0.0.1 localhost\n', mtime: 1_700_000_000_000 },
      '/etc/nginx/nginx.conf': { type: 'file', content: 'worker_processes 1;\n' },
      '/etc/nginx/conf.d/default.conf': { type: 'file', content: 'server { listen 80; }\n' },
      '/var/log/nginx': { type: 'dir' },
      '/bin': { type: 'link', target: 'usr/bin' },
      '/usr/bin/env': { type: 'file', content: 'ELF' }
    },
    shell: true,
    ...extra
  }
}

/** Mục con trực tiếp của thư mục trong hệ file giả. */
function children(
  files: Record<string, FakeFile>,
  dir: string
): { name: string; path: string; file: FakeFile }[] {
  const base = dir === '/' ? '' : dir.replace(/\/+$/, '')
  const out = new Map<string, { name: string; path: string; file: FakeFile }>()
  for (const [path, file] of Object.entries(files)) {
    if (!path.startsWith(`${base}/`)) continue
    const rest = path.slice(base.length + 1)
    const name = rest.split('/')[0] ?? ''
    if (!name) continue
    const full = `${base}/${name}`
    if (rest === name) out.set(name, { name, path: full, file })
    else if (!out.has(name)) out.set(name, { name, path: full, file: { type: 'dir' } })
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function kindOf(files: Record<string, FakeFile>, path: string): FakeFile | null {
  if (path === '/') return { type: 'dir' }
  const clean = path.replace(/\/+$/, '')
  const f = files[clean]
  if (f) return f
  return Object.keys(files).some((p) => p.startsWith(`${clean}/`)) ? { type: 'dir' } : null
}

/** Như `sh -c LIST_SCRIPT sh <dir>` của Session Host: "kiểu/tên", "--", rồi `stat -c`. */
function fakeListing(files: Record<string, FakeFile>, dir: string): string {
  const list = children(files, dir)
  const head = list.map((c) => {
    const target =
      c.file.type === 'link' ? kindOf(files, `${dir.replace(/\/+$/, '')}/${c.file.target}`) : null
    const k =
      c.file.type === 'dir'
        ? 'd'
        : c.file.type === 'file'
          ? 'f'
          : target?.type === 'dir'
            ? 'L'
            : 'l'
    return `${k}/${c.name}`
  })
  const stats = list.map((c) => {
    const size = c.file.type === 'file' ? Buffer.byteLength(c.file.content) : 4096
    const mtime =
      'mtime' in c.file && c.file.mtime ? Math.floor(c.file.mtime / 1000) : 1_700_000_000
    const mode =
      c.file.type === 'dir' ? 'drwxr-xr-x' : c.file.type === 'link' ? 'lrwxrwxrwx' : '-rw-r--r--'
    return `${size}/${mtime}/${mode}/${c.name}`
  })
  return [...head, '--', ...stats, ''].join('\n')
}

/** Tar của một đường dẫn (như GET /containers/{id}/archive): mục đầu là tên cuối của đường dẫn. */
function fakeArchive(files: Record<string, FakeFile>, path: string): Buffer {
  const clean = path === '/' ? '/' : path.replace(/\/+$/, '')
  const top = clean === '/' ? '' : (clean.split('/').pop() ?? '')
  const parts: Buffer[] = []
  const walk = (abs: string, rel: string): void => {
    const f = kindOf(files, abs)
    if (!f) return
    if (f.type === 'file') {
      const data = Buffer.from(f.content)
      parts.push(
        tarHeader({ path: rel, type: 'file', size: data.length, mode: 0o644, mtime: f.mtime ?? 0 })
      )
      parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512))
      return
    }
    if (f.type === 'link') {
      // Liên kết: header kiểu '2' (tarHeader chỉ ghi file / thư mục — tự dựng).
      const h = tarHeader({ path: rel, type: 'file', size: 0, mode: 0o777, mtime: 0 })
      h.write('2', 156, 1, 'ascii')
      h.write(f.target, 157, 100, 'utf8')
      h.write('        ', 148, 8, 'ascii')
      let sum = 0
      for (const b of h) sum += b
      h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
      parts.push(h)
      return
    }
    if (rel) parts.push(tarHeader({ path: rel, type: 'dir', size: 0, mode: 0o755, mtime: 0 }))
    for (const c of children(files, abs)) walk(c.path, rel ? `${rel}/${c.name}` : c.name)
  }
  walk(clean, top)
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

function frame(stream: 1 | 2, text: string): Buffer {
  const data = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, data])
}

/** Volume ẩn danh (Docker ≥ 23 gắn nhãn). */
export const ANON_VOLUME = 'a'.repeat(64)

export interface EngineTestOptions {
  /** Phiên bản API của server (header Api-Version, /version). Mặc định 1.45. */
  apiVersion?: string
  /** Phiên bản tối thiểu server chấp nhận (Docker 29: 1.44). Mặc định 1.24. */
  minApiVersion?: string
  /** false = /_ping không gửi header Api-Version (Podman cũ…). */
  pingHeader?: boolean
}

const versionNumber = (v: string): number => {
  const [a, b] = v.split('.').map(Number)
  return (a ?? 0) * 1000 + (b ?? 0)
}

export async function startEngineTestServer(
  options: EngineTestOptions = {}
): Promise<EngineTestServer> {
  const apiVersion = options.apiVersion ?? '1.45'
  const minApiVersion = options.minApiVersion ?? '1.24'
  const dir = process.platform === 'win32' ? '' : mkdtempSync(join(tmpdir(), 'sh-docker-'))
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\shellhouse-docker-test-${randomUUID()}`
      : join(dir, 'docker.sock')
  const containers: FakeContainer[] = [
    container('web', {
      Status: 'Up 2 hours (healthy)',
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
    { Name: 'orphan', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/orphan', Labels: null },
    {
      Name: ANON_VOLUME,
      Driver: 'local',
      Mountpoint: `/var/lib/docker/volumes/${ANON_VOLUME}`,
      Labels: { 'com.docker.volume.anonymous': '' }
    }
  ] as {
    Name: string
    Driver: string
    Mountpoint: string
    Labels: Record<string, string> | null
  }[]
  /** Volume container đang dùng (không dangling). */
  const usedVolumes = new Set(['shop_data'])
  const networks: EngineTestServer['networks'] = [
    { Id: 'n-bridge', Name: 'bridge', Driver: 'bridge', Scope: 'local' },
    { Id: 'n-host', Name: 'host', Driver: 'host', Scope: 'local' },
    { Id: 'n-shop', Name: 'shop_default', Driver: 'bridge', Scope: 'local' },
    { Id: 'n-unused', Name: 'unused', Driver: 'bridge', Scope: 'local' }
  ]
  const requests: string[] = []
  /** Thân request tạo container (kiểm tham số `docker run`). */
  const created: unknown[] = []
  const registryAuth: EngineTestServer['registryAuth'] = []
  const connections: EngineTestServer['connections'] = []
  const buildCache = [
    { ID: 'cache-used-1', Size: 1000, InUse: true, Description: 'mount / from exec' },
    { ID: 'cache-free-1', Size: 3000, InUse: false, Description: 'RUN apt-get update' }
  ]
  const execs = new Map<
    string,
    { container: FakeContainer; cmd: string[]; exitCode: number | null }
  >()
  const authOf = (req: IncomingMessage, path: string): Record<string, unknown> | null => {
    const header = req.headers['x-registry-auth']
    if (typeof header !== 'string') return null
    const auth = JSON.parse(Buffer.from(header, 'base64url').toString('utf8') || '{}') as Record<
      string,
      unknown
    >
    registryAuth.push({ path, auth })
    return auth
  }
  const goodAuth = (a: Record<string, unknown> | null): boolean =>
    a?.['username'] === 'u' && a['password'] === 'p'
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(c)
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as unknown
  }
  const followers = new Map<string, Set<{ res: ServerResponse; tty: boolean }>>()
  const cpuTicks = new Map<string, number>()
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
      res.writeHead(200, {
        ...(options.pingHeader === false ? {} : { 'Api-Version': apiVersion }),
        'Content-Type': 'text/plain'
      })
      res.end('OK')
      return true
    }
    // Như dockerd: phiên bản trong đường dẫn ngoài [min, max] → 400 với câu chuẩn của Docker.
    const requested = /^\/v(\d+\.\d+)\//.exec(url.pathname)?.[1]
    if (requested && versionNumber(requested) < versionNumber(minApiVersion))
      return json(res, 400, {
        message: `client version ${requested} is too old. Minimum supported API version is ${minApiVersion}, please upgrade your client to a newer version`
      })
    if (requested && versionNumber(requested) > versionNumber(apiVersion))
      return json(res, 400, {
        message: `client version ${requested} is too new. Maximum supported API version is ${apiVersion}`
      })
    const version = requested ?? apiVersion
    const p = url.pathname.replace(/^\/v\d+\.\d+/, '')
    let m: RegExpExecArray | null
    if (method === 'GET' && p === '/system/df')
      return json(res, 200, {
        Images: images.map((i) => ({
          Size: i.Size,
          SharedSize: 0,
          RepoTags: i.RepoTags,
          Containers: containers.filter((c) => c.ImageID === i.Id).length
        })),
        Containers: containers.map((c) => ({ SizeRw: 1000, State: c.State })),
        Volumes: volumes.map((v) => ({
          Name: v.Name,
          Labels: v.Labels,
          UsageData: {
            Size: v.Name === 'shop_data' ? 123_456 : 2000,
            RefCount: usedVolumes.has(v.Name) ? 1 : 0
          }
        })),
        BuildCache: buildCache
      })
    if (method === 'POST' && p === '/build/prune') {
      const all = url.searchParams.get('all') === 'true'
      const gone = buildCache.filter((c) => !c.InUse && all)
      for (const c of gone) buildCache.splice(buildCache.indexOf(c), 1)
      return json(res, 200, {
        CachesDeleted: gone.map((c) => c.ID),
        SpaceReclaimed: gone.reduce((n, c) => n + c.Size, 0)
      })
    }
    if (method === 'POST' && p === '/auth') {
      const body = (await readBody(req)) as Record<string, unknown>
      return goodAuth(body)
        ? json(res, 200, { Status: 'Login Succeeded', IdentityToken: '' })
        : json(res, 401, { message: 'unauthorized: incorrect username or password' })
    }
    if (method === 'POST' && p === '/volumes/create') {
      const body = (await readBody(req)) as {
        Name?: string
        Driver: string
        Labels?: Record<string, string>
      }
      const name = body.Name || randomUUID().replace(/-/g, '').repeat(2).slice(0, 64)
      if (volumes.some((v) => v.Name === name))
        return json(res, 409, { message: `volume ${name} already exists` })
      volumes.push({
        Name: name,
        Driver: body.Driver,
        Mountpoint: `/var/lib/docker/volumes/${name}`,
        Labels: body.Labels ?? null
      })
      created.push(body)
      return json(res, 201, { Name: name, Driver: body.Driver })
    }
    if (method === 'POST' && p === '/networks/create') {
      const body = (await readBody(req)) as { Name: string; Driver: string }
      if (networks.some((n) => n.Name === body.Name))
        return json(res, 409, { message: `network with name ${body.Name} already exists` })
      const id = `n-${randomUUID().slice(0, 8)}`
      networks.push({ Id: id, Name: body.Name, Driver: body.Driver, Scope: 'local', body })
      return json(res, 201, { Id: id, Warning: '' })
    }
    if (method === 'POST' && (m = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(p))) {
      const net = networks.find((n) => n.Id === m?.[1] || n.Name === m?.[1])
      if (!net) return json(res, 404, { message: 'network not found' })
      const body = (await readBody(req)) as { Container: string }
      if (!find(body.Container))
        return json(res, 404, { message: `No such container: ${body.Container}` })
      if (m[2] === 'connect')
        connections.push({ network: net.Name, container: body.Container, body })
      else {
        const i = connections.findIndex(
          (c) => c.network === net.Name && c.container === body.Container
        )
        if (i >= 0) connections.splice(i, 1)
      }
      return json(res, 200, undefined)
    }
    if (method === 'POST' && (m = /^\/containers\/([^/]+)\/exec$/.exec(p))) {
      const c = find(decodeURIComponent(m[1] ?? ''))
      if (!c) return json(res, 404, { message: 'No such container' })
      if (c.State !== 'running')
        return json(res, 409, { message: `Container ${c.Id} is not running` })
      const body = (await readBody(req)) as { Cmd: string[] }
      const id = randomUUID().replace(/-/g, '')
      execs.set(id, { container: c, cmd: body.Cmd, exitCode: null })
      return json(res, 201, { Id: id })
    }
    if (method === 'POST' && (m = /^\/exec\/([^/]+)\/start$/.exec(p))) {
      const e = execs.get(m[1] ?? '')
      if (!e) return json(res, 404, { message: 'No such exec instance' })
      await readBody(req)
      let out = ''
      let err = ''
      if (!e.container.shell || e.cmd[0] !== 'sh') {
        e.exitCode = 127
        err = `OCI runtime exec failed: exec failed: unable to start container process: exec: "${e.cmd[0] ?? ''}": executable file not found in $PATH: unknown\n`
      } else {
        const dir = e.cmd[4] ?? '/'
        const k = kindOf(e.container.files, dir)
        if (k?.type !== 'dir') {
          e.exitCode = 3
          err = `sh: cd: line 1: can't cd to ${dir}: No such file or directory\n`
        } else {
          e.exitCode = 0
          out = fakeListing(e.container.files, dir)
        }
      }
      // Như dockerd không có Upgrade: dòng trạng thái + header rồi luồng thô, đóng kết nối khi xong
      // (không Content-Length, không chunked).
      const socket = req.socket
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\n\r\n'
      )
      if (out) socket.write(frame(1, out))
      if (err) socket.write(frame(2, err))
      socket.end()
      return true
    }
    if (method === 'GET' && (m = /^\/exec\/([^/]+)\/json$/.exec(p))) {
      const e = execs.get(m[1] ?? '')
      if (!e) return json(res, 404, { message: 'No such exec instance' })
      return json(res, 200, { ExitCode: e.exitCode, Running: false })
    }
    if ((m = /^\/containers\/([^/]+)\/archive$/.exec(p))) {
      const c = find(decodeURIComponent(m[1] ?? ''))
      if (!c) return json(res, 404, { message: 'No such container' })
      const path = url.searchParams.get('path') ?? ''
      if (method === 'HEAD') {
        const k = kindOf(c.files, path)
        res.writeHead(k ? 200 : 404, {
          ...(k
            ? {
                'X-Docker-Container-Path-Stat': Buffer.from(
                  JSON.stringify({
                    name: path.split('/').pop(),
                    mode: k.type === 'dir' ? 2147484141 : 420
                  })
                ).toString('base64')
              }
            : {})
        })
        res.end()
        return true
      }
      if (method === 'GET') {
        if (!kindOf(c.files, path))
          return json(res, 404, {
            message: `Could not find the file ${path} in container ${c.Names[0] ?? ''}`
          })
        const data = fakeArchive(c.files, path)
        res.writeHead(200, { 'Content-Type': 'application/x-tar' })
        res.end(data)
        return true
      }
      if (method === 'PUT') {
        if (kindOf(c.files, path)?.type !== 'dir')
          return json(res, 404, { message: `Could not find the file ${path} in container` })
        let current: { path: string; chunks: Buffer[]; mtime: number } | null = null
        const base = path === '/' ? '' : path.replace(/\/+$/, '')
        await parseTar(req as AsyncIterable<Buffer>, {
          entry: (e) => {
            if (e.type === 'dir') c.files[`${base}/${e.path}`] = { type: 'dir' }
            else if (e.type === 'file')
              current = { path: `${base}/${e.path}`, chunks: [], mtime: e.mtime }
          },
          data: (chunk) => {
            current?.chunks.push(Buffer.from(chunk))
          },
          end: () => {
            const f = current
            if (f)
              c.files[f.path] = { type: 'file', content: Buffer.concat(f.chunks), mtime: f.mtime }
            current = null
          }
        })
        return json(res, 200, undefined)
      }
    }
    if (method === 'POST' && (m = /^\/images\/(.+)\/push$/.exec(p))) {
      const name = decodeURIComponent(m[1] ?? '')
      const auth = authOf(req, p)
      if (auth === null)
        return json(res, 400, { message: 'Bad parameters and missing X-Registry-Auth: EOF' })
      const tag = url.searchParams.get('tag') ?? 'latest'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (!images.some((i) => i.RepoTags.includes(`${name}:${tag}`))) {
        res.end(
          `${JSON.stringify({ error: `An image does not exist locally with the tag: ${name}` })}\n`
        )
        return true
      }
      if (!goodAuth(auth)) {
        res.end(`${JSON.stringify({ error: 'unauthorized: authentication required' })}\n`)
        return true
      }
      const lines = [
        { status: `The push refers to repository [${name}]` },
        { status: 'Pushing', id: 'layer1', progressDetail: { current: 50, total: 100 } },
        { status: 'Pushed', id: 'layer1' },
        { status: `${tag}: digest: sha256:abc size: 528` }
      ]
      for (const l of lines) res.write(`${JSON.stringify(l)}\n`)
      res.end()
      return true
    }
    if (method === 'POST' && (m = /^\/images\/(.+)\/tag$/.exec(p))) {
      const id = decodeURIComponent(m[1] ?? '')
      const image = images.find((x) => x.Id === id || x.RepoTags.includes(id))
      if (!image) return json(res, 404, { message: `No such image: ${id}` })
      image.RepoTags = [
        ...image.RepoTags.filter((t) => t !== '<none>:<none>'),
        `${url.searchParams.get('repo') ?? ''}:${url.searchParams.get('tag') ?? 'latest'}`
      ]
      return json(res, 201, undefined)
    }
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
        ApiVersion: apiVersion,
        MinAPIVersion: minApiVersion,
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
            // Volume `shop_data` do container `web` gắn.
            Mounts: c.Names.includes('/web') ? [{ Type: 'volume', Name: 'shop_data' }] : [],
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
      // Container "(healthy)": health check bằng curl (output thật có thanh tiến trình).
      const healthy = /\(healthy\)/.test(c.Status)
      const curl = (body: string): string =>
        `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n\r  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\r100    15  100    15    0     0   7055      0 --:--:-- --:--:-- --:--:--  7666\n${body}`
      const ago = (s: number): string => new Date(Date.now() - s * 1000).toISOString()
      return json(res, 200, {
        Id: c.Id,
        Name: c.Names[0],
        State: {
          Status: c.State,
          ...(healthy
            ? {
                Health: {
                  Status: 'healthy',
                  FailingStreak: 0,
                  Log: [90, 60, 30].map((s) => ({
                    Start: ago(s),
                    End: ago(s - 1),
                    ExitCode: 0,
                    Output: curl('{"status":"ok"}')
                  }))
                }
              }
            : {})
        },
        Config: {
          Tty: c.Tty,
          Env: c.Env,
          Image: c.Image,
          ...(healthy
            ? {
                Healthcheck: {
                  Test: ['CMD-SHELL', 'curl -f http://localhost:8080/health'],
                  Interval: 30_000_000_000,
                  Timeout: 5_000_000_000,
                  Retries: 3
                }
              }
            : {})
        },
        HostConfig: { Memory: 0 }
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
      // Bộ đếm CPU tăng dần qua các lần gọi (như Docker thật); one-shot → không có precpu.
      const id = m[1] ?? ''
      let n = cpuTicks.get(id) ?? 0
      const oneShot = url.searchParams.get('one-shot') === 'true'
      const tick = (): void => {
        n++
        cpuTicks.set(id, n)
        res.write(
          `${JSON.stringify({
            read: new Date().toISOString(),
            cpu_stats: {
              cpu_usage: { total_usage: 1_000_000 * n },
              system_cpu_usage: 10_000_000 * n,
              online_cpus: 2
            },
            precpu_stats: oneShot
              ? { cpu_usage: { total_usage: 0 } }
              : {
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
      // Như Engine thật: container chạy luôn chặn; container dừng chặn trừ khi force.
      const users = containers.filter((c) => c.ImageID === images[i]?.Id)
      const force = url.searchParams.get('force') === 'true'
      const short = (images[i]?.Id ?? '').replace(/^sha256:/, '').slice(0, 12)
      if (users.some((c) => c.State === 'running'))
        return json(res, 409, {
          message: `conflict: unable to delete ${short} (cannot be forced) - image is being used by running container ${users[0]?.Id.slice(0, 12) ?? ''}`
        })
      if (users.length && !force)
        return json(res, 409, {
          message: `conflict: unable to delete ${short} (must be forced) - image is being used by stopped container ${users[0]?.Id.slice(0, 12) ?? ''}`
        })
      images.splice(i, 1)
      return json(res, 200, [{ Deleted: id }])
    }
    if (method === 'POST' && p === '/images/create') {
      const from = url.searchParams.get('fromImage') ?? ''
      const auth = authOf(req, p)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Ảnh riêng tư: cần đăng nhập đúng (như registry thật trả lỗi giữa luồng).
      if (from.includes('/private') && !goodAuth(auth)) {
        res.end(
          `${JSON.stringify({ error: `pull access denied for ${from}, repository does not exist or may require 'docker login'` })}\n`
        )
        return true
      }
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
        Volumes: volumes.filter((v) => !dangling || !usedVolumes.has(v.Name)),
        Warnings: null
      })
    }
    if (method === 'POST' && p === '/volumes/prune') {
      // API ≥ 1.42: mặc định chỉ volume ẩn danh (nhãn), filter all=true = mọi volume không dùng;
      // API cũ hơn: mọi volume không dùng, kể cả có tên.
      const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as { all?: string[] }
      const all = versionNumber(version) < 1042 || filters.all?.includes('true') === true
      const gone = volumes.filter(
        (v) =>
          !usedVolumes.has(v.Name) &&
          (all || (v.Labels ?? {})['com.docker.volume.anonymous'] !== undefined)
      )
      for (const v of gone) volumes.splice(volumes.indexOf(v), 1)
      return json(res, 200, { VolumesDeleted: gone.map((v) => v.Name), SpaceReclaimed: 0 })
    }
    if (method === 'DELETE' && (m = /^\/volumes\/(.+)$/.exec(p))) {
      const name = decodeURIComponent(m[1] ?? '')
      const i = volumes.findIndex((v) => v.Name === name)
      if (i < 0) return json(res, 404, { message: 'no such volume' })
      if (usedVolumes.has(name))
        return json(res, 409, {
          message: `remove ${name}: volume is in use - [${containers[1]?.Id ?? ''}]`
        })
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
      const all = url.searchParams.get('filters')?.includes('"false"') === true
      const gone = images.filter((i) =>
        all ? !containers.some((c) => c.ImageID === i.Id) : i.RepoTags[0] === '<none>:<none>'
      )
      for (const i of gone) images.splice(images.indexOf(i), 1)
      return json(res, 200, {
        ImagesDeleted: gone.map((i) => ({ Deleted: i.Id })),
        SpaceReclaimed: 5_000_000
      })
    }
    return json(res, 404, { message: `page not found: ${method} ${p}` })
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    void handleAsync(req, res).catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { message: String(error) })
    })
  }
  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return {
    path,
    volumes,
    containers,
    requests,
    created,
    registryAuth,
    networks,
    connections,
    buildCache,
    log: (id, stream, text) => {
      const c = find(id)
      c?.logs.push({ stream, text })
      for (const f of followers.get(c?.Id ?? '') ?? [])
        f.res.write(f.tty ? text : frame(stream, text))
    },
    dropEvents: () => {
      for (const r of eventStreams) r.destroy()
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
