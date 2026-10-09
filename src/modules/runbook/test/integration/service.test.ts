import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as netConnect } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecOptions, ExecResult, SshCapability } from '../../../registry/host-types'
import { RunbookService } from '../../session-host/service'
import { HTTP_BODY_LIMIT, type ExecResult as Exec, type HttpResult } from '../../shared/runbook'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const signal = (): AbortSignal => new AbortController().signal

/** Đóng server và mọi socket còn mở khi hết test. */
function track(server: Server): void {
  const sockets = new Set<{ destroy(): void }>()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => {
          resolve()
        })
      })
  )
}

async function listen(server: Server): Promise<number> {
  track(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

/** Server ghi lại request; `/to?u=…` chuyển hướng (302) tới địa chỉ bất kỳ, `/see-other` (303). */
async function echoServer(): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const port = await listen(
    createServer((req, res) => {
      void readBody(req).then((body) => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
        const u = new URL(req.url ?? '/', 'http://x')
        if (u.pathname === '/to') {
          res.statusCode = Number(u.searchParams.get('code') ?? 302)
          res.setHeader('location', u.searchParams.get('u') ?? '/')
          res.end()
          return
        }
        res.setHeader('content-type', 'text/plain')
        res.end(`${req.method ?? ''} ${body}`)
      })
    })
  )
  return { url: `http://127.0.0.1:${String(port)}`, seen }
}

async function webServer(): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = []
  const sockets = new Set<{ destroy(): void }>()
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method ?? ''} ${req.url ?? ''} ${req.headers['user-agent'] ?? ''}`)
    switch (req.url) {
      case '/health':
        res.end('{"ok":true}')
        return
      case '/down':
        res.statusCode = 503
        res.end('upstream down')
        return
      case '/redirect':
        res.statusCode = 302
        res.setHeader('location', '/health')
        res.end()
        return
      case '/big':
        res.write('x'.repeat(HTTP_BODY_LIMIT * 4))
        res.end()
        return
      case '/slow':
        // Không trả lời — để test hết giờ.
        return
      default:
        res.statusCode = 404
        res.end()
    }
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => {
          resolve()
        })
      })
  )
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${String(port)}`, hits }
}

const http = (svc: RunbookService, url: string, timeoutSec = 5): Promise<HttpResult> =>
  svc.run({ op: 'http', url, timeoutSec }, signal()) as Promise<HttpResult>

describe('Runbook: bước HTTP', () => {
  it('trả mã trạng thái và thân; gửi GET kèm User-Agent riêng', async () => {
    const { url, hits } = await webServer()
    const r = await http(new RunbookService(), `${url}/health`)
    expect(r).toEqual({ status: 200, body: '{"ok":true}' })
    expect(hits).toEqual(['GET /health Shellhouse-Runbook'])
  })

  it('mã lỗi vẫn là kết quả (không phải lỗi) — để điều kiện đạt quyết định', async () => {
    const { url } = await webServer()
    expect(await http(new RunbookService(), `${url}/down`)).toEqual({
      status: 503,
      body: 'upstream down'
    })
  })

  it('theo chuyển hướng; chỉ đọc phần đầu của thân quá lớn', async () => {
    const { url } = await webServer()
    expect((await http(new RunbookService(), `${url}/redirect`)).status).toBe(200)
    const big = await http(new RunbookService(), `${url}/big`)
    expect(big.body).toHaveLength(HTTP_BODY_LIMIT)
  })

  it('không trả lời kịp → lỗi "did not answer within"; cổng đóng → "connection refused"', async () => {
    const { url } = await webServer()
    const slow = await http(new RunbookService(), `${url}/slow`, 1)
    expect(slow.status).toBeNull()
    expect(slow.error).toMatch(/Did not answer within 1 s/)
    // Cổng vừa đóng (cổng thấp như 1 bị fetch chặn từ trước: "bad port").
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as { port: number }).port
    await new Promise<void>((resolve) => {
      closed.close(() => {
        resolve()
      })
    })
    const refused = await http(new RunbookService(), `http://127.0.0.1:${String(port)}/`)
    expect(refused.error).toMatch(/Connection refused/)
  })

  it('từ chối địa chỉ không phải http(s) và địa chỉ hỏng — kể cả khi renderer gửi', async () => {
    const svc = new RunbookService()
    expect((await http(svc, 'file:///etc/passwd')).error).toMatch(/Only http/)
    expect((await http(svc, 'ftp://x/y')).error).toMatch(/Only http/)
    expect((await http(svc, 'not a url')).error).toMatch(/not a valid web address/)
  })

  it('POST gửi thân và header; HEAD không đọc thân', async () => {
    const { url, seen } = await echoServer()
    const r = (await new RunbookService().run(
      {
        op: 'http',
        method: 'POST',
        url: `${url}/check`,
        headers: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'X-Env', value: 'prod' }
        ],
        body: '{"ping":true}',
        timeoutSec: 5
      },
      signal()
    )) as HttpResult
    expect(r).toEqual({ status: 200, body: 'POST {"ping":true}' })
    expect(seen[0]?.headers['content-type']).toBe('application/json')
    expect(seen[0]?.headers['x-env']).toBe('prod')
    const head = (await new RunbookService().run(
      { op: 'http', method: 'HEAD', url: `${url}/x`, timeoutSec: 5 },
      signal()
    )) as HttpResult
    expect(head).toEqual({ status: 200, body: '' })
  })

  it('header bí mật: giá trị lấy từ cấu hình phiên (main giải mã); thiếu → báo nhập lại', async () => {
    const { url, seen } = await echoServer()
    const svc = new RunbookService({ config: { proxy: null, secrets: { s1: 'Bearer t0k3n' } } })
    const op = (secretId: string): unknown => ({
      op: 'http',
      url: `${url}/api`,
      headers: [{ name: 'Authorization', value: '', secretId }],
      timeoutSec: 5
    })
    expect(((await svc.run(op('s1'), signal())) as HttpResult).status).toBe(200)
    expect(seen[0]?.headers.authorization).toBe('Bearer t0k3n')
    const missing = (await svc.run(op('gone'), signal())) as HttpResult
    expect(missing.status).toBeNull()
    expect(missing.error).toMatch(/secret value of header Authorization is missing/)
    expect(seen).toHaveLength(1)
  })

  it('chuyển hướng sang origin khác: bỏ header bí mật / Authorization; cùng origin thì giữ', async () => {
    const a = await echoServer()
    const b = await echoServer()
    const svc = new RunbookService({ config: { proxy: null, secrets: { s1: 'tok' } } })
    const headers = [
      { name: 'X-Token', value: '', secretId: 's1' },
      { name: 'Authorization', value: 'Basic abc' },
      { name: 'X-Trace', value: 'keep' }
    ]
    const go = (target: string): Promise<unknown> =>
      svc.run(
        {
          op: 'http',
          url: `${a.url}/to?u=${encodeURIComponent(target)}`,
          headers,
          timeoutSec: 5
        },
        signal()
      )
    await go(`${a.url}/same`)
    const same = a.seen.find((x) => x.url === '/same')
    expect(same?.headers['x-token']).toBe('tok')
    expect(same?.headers.authorization).toBe('Basic abc')
    await go(`${b.url}/other`)
    const other = b.seen.find((x) => x.url === '/other')
    expect(other?.headers['x-token']).toBeUndefined()
    expect(other?.headers.authorization).toBeUndefined()
    expect(other?.headers['x-trace']).toBe('keep')
  })

  it('303 sau POST → GET không thân; 307 giữ POST và thân', async () => {
    const { url, seen } = await echoServer()
    const post = (code: number): Promise<unknown> =>
      new RunbookService().run(
        {
          op: 'http',
          method: 'POST',
          url: `${url}/to?code=${String(code)}&u=/done${String(code)}`,
          body: 'data',
          timeoutSec: 5
        },
        signal()
      )
    expect(await post(303)).toEqual({ status: 200, body: 'GET ' })
    expect(await post(307)).toEqual({ status: 200, body: 'POST data' })
    expect(seen.map((x) => `${x.method} ${x.url.split('?')[0] ?? ''}`)).toEqual([
      'POST /to',
      'GET /done303',
      'POST /to',
      'POST /done307'
    ])
  })

  it('HTTPS tự ký: mặc định từ chối kèm gợi ý; bật bỏ kiểm chứng chỉ thì qua', async () => {
    const fixtures = join(__dirname, '..', 'fixtures')
    const server = createHttpsServer(
      {
        cert: readFileSync(join(fixtures, 'server.crt')),
        key: readFileSync(join(fixtures, 'server.key'))
      },
      (_req, res) => {
        res.end('secure ok')
      }
    )
    const port = await listen(server)
    const op = (insecureTls: boolean): unknown => ({
      op: 'http',
      url: `https://127.0.0.1:${String(port)}/`,
      insecureTls,
      timeoutSec: 5
    })
    const strict = (await new RunbookService().run(op(false), signal())) as HttpResult
    expect(strict.status).toBeNull()
    expect(strict.error).toMatch(/not trusted.*Skip certificate verification/)
    expect(await new RunbookService().run(op(true), signal())).toEqual({
      status: 200,
      body: 'secure ok'
    })
  })

  it('đi qua proxy main chọn (Settings › Network)', async () => {
    const { url } = await echoServer()
    const tunnels: string[] = []
    const proxy = createServer()
    proxy.on('connect', (req: IncomingMessage, client: import('node:net').Socket) => {
      tunnels.push(req.url ?? '')
      const [host, port] = (req.url ?? '').split(':')
      const upstream = netConnect(Number(port), host ?? '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n')
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
    })
    const proxyPort = await listen(proxy)
    const svc = new RunbookService({
      config: { proxy: `http://127.0.0.1:${String(proxyPort)}`, secrets: {} }
    })
    expect(
      ((await svc.run({ op: 'http', url: `${url}/via`, timeoutSec: 5 }, signal())) as HttpResult)
        .status
    ).toBe(200)
    expect(tunnels).toEqual([new URL(url).host])
  })

  it('thao tác không hợp lệ bị schema từ chối', async () => {
    await expect(new RunbookService().run({ op: 'shell', cmd: 'x' }, signal())).rejects.toThrow()
  })
})

function fakeSsh(
  exec: (argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>
): SshCapability {
  return {
    exec,
    spawn: () => Promise.reject(new Error('no')),
    openPty: () => Promise.reject(new Error('no')),
    openUnixSocket: () => Promise.reject(new Error('no')),
    openTcp: () => Promise.reject(new Error('no')),
    label: 'me@host'
  }
}

const exec = (svc: RunbookService, command: string, timeoutSec = 5): Promise<Exec> =>
  svc.run({ op: 'exec', command, timeoutSec }, signal()) as Promise<Exec>

describe('Runbook: bước lệnh qua SSH', () => {
  it('chạy `sh -c <lệnh>` qua kênh exec và trả mã thoát + đầu ra', async () => {
    const seen: { argv: readonly string[]; options?: ExecOptions }[] = []
    const svc = new RunbookService({
      ssh: fakeSsh((argv, options) => {
        seen.push({ argv, ...(options ? { options } : {}) })
        return Promise.resolve({ code: 0, stdout: 'active\n', stderr: '' })
      })
    })
    expect(await exec(svc, 'systemctl is-active app && echo "$HOME" | wc -c')).toEqual({
      code: 0,
      stdout: 'active\n',
      stderr: '',
      timedOut: false
    })
    // Lệnh nguyên văn là MỘT tham số của sh -c (lõi tự quote) — không bị tách / nối thêm.
    expect(seen[0]?.argv).toEqual(['sh', '-c', 'systemctl is-active app && echo "$HOME" | wc -c'])
    expect(seen[0]?.options?.maxOutputBytes).toBeGreaterThan(1024 * 1024)
  })

  it('mã thoát khác 0 là kết quả, không phải lỗi', async () => {
    const svc = new RunbookService({
      ssh: fakeSsh(() => Promise.resolve({ code: 3, stdout: '', stderr: 'inactive' }))
    })
    expect(await exec(svc, 'false')).toMatchObject({ code: 3, stderr: 'inactive', timedOut: false })
  })

  it('quá giờ → timedOut: true (không phải lỗi chung chung)', async () => {
    const svc = new RunbookService({
      ssh: fakeSsh(
        (_argv, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new Error('Cancelled'))
            })
          })
      )
    })
    expect(await exec(svc, 'sleep 100', 1)).toEqual({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })
  })

  it('người dùng dừng → lỗi (không giả làm hết giờ); lỗi kênh ném lên nguyên văn', async () => {
    const controller = new AbortController()
    const svc = new RunbookService({
      ssh: fakeSsh(
        (_argv, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new Error('Cancelled'))
            })
          })
      )
    })
    const pending = svc.run({ op: 'exec', command: 'sleep 100', timeoutSec: 60 }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('Cancelled')
    const broken = new RunbookService({
      ssh: fakeSsh(() => Promise.reject(new Error('The command printed too much output')))
    })
    await expect(exec(broken, 'yes')).rejects.toThrow(/too much output/)
  })

  it('phiên không gắn SSH → báo cần chọn host', async () => {
    await expect(exec(new RunbookService(), 'ls')).rejects.toThrow(/SSH server/)
  })
})
