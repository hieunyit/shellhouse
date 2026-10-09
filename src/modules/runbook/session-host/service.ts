import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { t } from '@shared/i18n'
import { proxiedAgents } from '../../../node-shared/proxy-tunnel'
import type { HostModuleSession, SshCapability } from '../../registry/host-types'
import {
  HTTP_BODY_LIMIT,
  RunbookOp,
  type ExecResult,
  type HttpResult,
  type RunbookSessionConfig
} from '../shared/runbook'

/** Đầu ra tối đa của một lệnh (chỉ cần vài dòng cuối để hiện, nhưng đủ rộng cho lệnh nói nhiều). */
const EXEC_MAX_OUTPUT = 2 * 1024 * 1024

/** Số lần theo chuyển hướng tối đa (như trình duyệt / curl -L giới hạn). */
const MAX_REDIRECTS = 5

/** Header không được mang sang origin khác khi bị chuyển hướng (như `fetch`). */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

export interface RunbookServiceDeps {
  /** Có khi phiên gắn vào kết nối SSH — cần cho `exec`. */
  ssh?: SshCapability
  /** Phiên `local`: proxy và bí mật do main phân giải. */
  config?: RunbookSessionConfig
}

type HttpOp = Extract<RunbookOp, { op: 'http' }>

interface OutHeader {
  name: string
  value: string
  /** Giá trị lấy từ vault hoặc header chứa thông tin đăng nhập — bỏ khi sang origin khác. */
  sensitive: boolean
}

/**
 * Việc Session Host làm cho Runbook (ADR-016): chạy một lệnh trên server qua kênh exec của kết nối
 * SSH đã có, và gọi một địa chỉ HTTP(S) từ máy này (qua proxy của Settings › Network). Không giữ
 * trạng thái giữa các lần gọi.
 */
export class RunbookService implements HostModuleSession {
  constructor(private readonly deps: RunbookServiceDeps = {}) {}

  async run(raw: unknown, signal: AbortSignal): Promise<unknown> {
    const op = RunbookOp.parse(raw)
    switch (op.op) {
      case 'exec':
        return this.exec(op.command, op.timeoutSec, signal)
      case 'http':
        return this.http(op, signal)
    }
  }

  private async exec(
    command: string,
    timeoutSec: number,
    signal: AbortSignal
  ): Promise<ExecResult> {
    const ssh = this.deps.ssh
    if (!ssh) throw new Error(t('Commands run on an SSH server — pick a host for this step.'))
    // Hết giờ do mình tính (không dựa vào lỗi "Timed out" của lõi) để báo "chưa xong" rõ ràng.
    const limit = new AbortController()
    const state = { timedOut: false }
    const timer = setTimeout(() => {
      state.timedOut = true
      limit.abort()
    }, timeoutSec * 1000)
    try {
      const r = await ssh.exec(['sh', '-c', command], {
        signal: AbortSignal.any([signal, limit.signal]),
        maxOutputBytes: EXEC_MAX_OUTPUT
      })
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: false }
    } catch (error) {
      if (state.timedOut && !signal.aborted)
        return { code: null, stdout: '', stderr: '', timedOut: true }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async http(op: HttpOp, signal: AbortSignal): Promise<HttpResult> {
    // Chỉ http(s) — không cho file:, ftp:… dù renderer gửi gì.
    let url: URL
    try {
      url = new URL(op.url)
    } catch {
      return { status: null, body: '', error: t('This is not a valid web address.') }
    }
    if (!isHttp(url))
      return {
        status: null,
        body: '',
        error: t('Only http:// and https:// addresses are checked.')
      }
    const secrets = this.deps.config?.secrets ?? {}
    let headers: OutHeader[] = []
    for (const h of op.headers) {
      if (h.secretId === undefined) {
        headers.push({
          name: h.name,
          value: h.value,
          sensitive: CREDENTIAL_HEADERS.has(h.name.toLowerCase())
        })
        continue
      }
      const value = secrets[h.secretId]
      if (value === undefined)
        return {
          status: null,
          body: '',
          error: t('The secret value of header {name} is missing — enter it again', {
            name: h.name
          })
        }
      headers.push({ name: h.name, value, sensitive: true })
    }
    // Proxy main chọn theo địa chỉ ban đầu (chuyển hướng sang host khác vẫn đi cùng đường).
    const agents = proxiedAgents(
      this.deps.config?.proxy ?? null,
      { keepAlive: false },
      { rejectUnauthorized: !op.insecureTls }
    )
    const limit = AbortSignal.any([signal, AbortSignal.timeout(op.timeoutSec * 1000)])
    let method: string = op.method
    let body: string | undefined = op.method === 'POST' ? op.body : undefined
    try {
      for (let hop = 0; ; hop++) {
        const res = await send(url, method, headers, body, agents, limit)
        const location = res.headers.location
        if (isRedirect(res.statusCode) && location && hop < MAX_REDIRECTS) {
          res.resume()
          const next = new URL(location, url)
          if (!isHttp(next))
            return {
              status: null,
              body: '',
              error: t('Only http:// and https:// addresses are checked.')
            }
          // 303, hoặc 301 / 302 sau POST → GET không thân (như trình duyệt); 307 / 308 giữ nguyên.
          if (
            res.statusCode === 303 ||
            (method === 'POST' && res.statusCode !== 307 && res.statusCode !== 308)
          ) {
            method = 'GET'
            body = undefined
          }
          // Không gửi token / mật khẩu cho origin khác.
          if (next.origin !== url.origin) headers = headers.filter((h) => !h.sensitive)
          url = next
          continue
        }
        const text = method === 'HEAD' ? '' : await readLimited(res, HTTP_BODY_LIMIT)
        return { status: res.statusCode ?? null, body: text }
      }
    } catch (error) {
      if (signal.aborted) throw error
      return { status: null, body: '', error: describeFetchError(error, op.timeoutSec) }
    } finally {
      agents.httpAgent.destroy()
      agents.httpsAgent.destroy()
    }
  }

  dispose(): void {
    // Không giữ gì.
  }
}

const isHttp = (url: URL): boolean => url.protocol === 'http:' || url.protocol === 'https:'

const isRedirect = (status: number | undefined): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308

/** Gửi một request (không tự theo chuyển hướng) → phản hồi khi có dòng trạng thái + header. */
function send(
  url: URL,
  method: string,
  headers: readonly OutHeader[],
  body: string | undefined,
  agents: ReturnType<typeof proxiedAgents>,
  signal: AbortSignal
): Promise<IncomingMessage> {
  const out: OutgoingHttpHeaders = { 'user-agent': 'Shellhouse-Runbook' }
  for (const h of headers) out[h.name.toLowerCase()] = h.value
  if (body !== undefined) out['content-length'] = Buffer.byteLength(body)
  const secure = url.protocol === 'https:'
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(
      url,
      { method, headers: out, agent: secure ? agents.httpsAgent : agents.httpAgent, signal },
      resolve
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** Đọc tối đa `limit` byte đầu của thân, bỏ phần còn lại (không kéo cả tệp lớn). */
async function readLimited(res: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of res as AsyncIterable<Buffer>) {
    chunks.push(chunk)
    total += chunk.length
    if (total >= limit) break
  }
  res.destroy()
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8')
}

/** Lỗi mạng của request (mã lỗi Node, có khi nằm trong `cause`) → một dòng dễ hiểu. */
export function describeFetchError(error: unknown, timeoutSec: number): string {
  const e = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown }
  if (e.name === 'TimeoutError' || e.name === 'AbortError')
    return t('Did not answer within {n} s', { n: timeoutSec })
  const cause = e.cause as { code?: unknown; message?: unknown } | undefined
  const code =
    typeof e.code === 'string' ? e.code : typeof cause?.code === 'string' ? cause.code : ''
  if (code === 'ECONNREFUSED') return t('Connection refused (nothing is listening there)')
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return t('Could not find that host name')
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code))
    return t(
      'The TLS certificate is not trusted ({code}) — if you trust this server, turn on “Skip certificate verification” for this step',
      { code }
    )
  const text =
    typeof cause?.message === 'string'
      ? cause.message
      : typeof e.message === 'string'
        ? e.message
        : String(error)
  return code ? `${text} (${code})` : text
}
