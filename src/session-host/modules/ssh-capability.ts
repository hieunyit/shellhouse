import { t } from '@shared/i18n'
import type { Duplex } from 'node:stream'
import type { Client, ClientChannel } from 'ssh2'
import { shellQuote } from '../../node-shared/shell-quote'
import type {
  ExecOptions,
  ExecResult,
  RunningProgram,
  SshCapability,
  TerminalSize
} from '../../modules/registry/host-types'
import type { Transport, TransportCallbacks } from '../transport/types'

const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024

function execChannel(client: Client, command: string, pty?: TerminalSize): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const cb = (error: Error | undefined, stream: ClientChannel): void => {
      if (error) reject(error)
      else resolve(stream)
    }
    if (pty)
      client.exec(
        command,
        { pty: { term: 'xterm-256color', cols: pty.cols, rows: pty.rows, width: 0, height: 0 } },
        cb
      )
    else client.exec(command, cb)
  })
}

export function collect(
  program: RunningProgram,
  options: ExecOptions,
  write?: (input: string | Buffer) => void
): Promise<ExecResult> {
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  return new Promise((resolve, reject) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let settled = false
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            fail(
              new Error(
                t('Timed out after {n} s', { n: Math.round((options.timeoutMs ?? 0) / 1000) })
              )
            )
          }, options.timeoutMs)
        : null
    const onAbort = (): void => {
      fail(new Error('Cancelled'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    function fail(error: Error): void {
      if (settled) return
      settled = true
      cleanup()
      program.kill()
      reject(error)
    }
    program.onStdout((chunk) => {
      outBytes += chunk.length
      if (outBytes > max) fail(new Error(t('The command printed too much output')))
      else out.push(chunk)
    })
    program.onStderr((chunk) => {
      // stderr chỉ để báo lỗi — giữ 64 KB đầu.
      if (errBytes < 64 * 1024) err.push(chunk)
      errBytes += chunk.length
    })
    program.onExit((code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      })
    })
    if (options.signal?.aborted) onAbort()
    else if (options.input !== undefined) write?.(options.input)
  })
}

function wrapChannel(stream: ClientChannel): RunningProgram {
  let exitCode: number | null = null
  const exitListeners: ((code: number | null) => void)[] = []
  let exited = false
  stream.on('exit', (code: unknown) => {
    exitCode = typeof code === 'number' ? code : null
  })
  stream.on('close', () => {
    if (exited) return
    exited = true
    for (const l of exitListeners) l(exitCode)
  })
  return {
    onStdout: (l) => stream.on('data', l),
    onStderr: (l) => stream.stderr.on('data', l),
    onExit: (l) => {
      if (exited) l(exitCode)
      else exitListeners.push(l)
    },
    kill: () => {
      if (exited) return
      // Đóng kênh thôi thì lệnh không có PTY (`docker logs -f`, `kubectl get -w`…) vẫn chạy tiếp
      // trên server tới lần ghi sau → gửi SIGTERM trước (OpenSSH ≥ 7.9 hỗ trợ; không thì bỏ qua).
      try {
        stream.signal('TERM')
      } catch {
        // Kênh vừa đóng.
      }
      stream.close()
    }
  }
}

/** Transport terminal trên một kênh exec có PTY. */
class PtyChannelTransport implements Transport {
  private exited = false

  constructor(
    private readonly stream: ClientChannel,
    cb: TransportCallbacks
  ) {
    let code: number | null = null
    const onData = (chunk: Buffer): void => {
      cb.onData(chunk)
    }
    stream.on('data', onData)
    stream.stderr.on('data', onData)
    stream.on('exit', (c: unknown) => {
      code = typeof c === 'number' ? c : null
    })
    stream.on('close', () => {
      if (this.exited) return
      this.exited = true
      cb.onExit({ code, signal: null })
    })
  }

  write(data: string): void {
    if (!this.exited) this.stream.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.stream.setWindow(rows, cols, 0, 0)
  }

  pause(): void {
    this.stream.pause()
    this.stream.stderr.pause()
  }

  resume(): void {
    this.stream.resume()
    this.stream.stderr.resume()
  }

  close(): void {
    if (this.exited) return
    this.stream.close()
  }
}

/** Năng lực SSH thô trên một client đã xác thực. Registry bọc thêm kiểm quyền. */
export function createSshCapability(client: Client, label: string): SshCapability {
  const spawn = async (argv: readonly string[], signal?: AbortSignal): Promise<RunningProgram> => {
    const stream = await execChannel(client, shellQuote(argv))
    const program = wrapChannel(stream)
    if (signal?.aborted) program.kill()
    else
      signal?.addEventListener(
        'abort',
        () => {
          program.kill()
        },
        { once: true }
      )
    return program
  }
  return {
    label,
    exec: async (argv, options = {}) => {
      const stream = await execChannel(client, shellQuote(argv))
      const program = wrapChannel(stream)
      const result = collect(program, options, (input) => {
        stream.end(input)
      })
      // Không có input: đóng stdin để lệnh đọc stdin không treo.
      if (options.input === undefined) stream.end()
      return result
    },
    spawn,
    openPty: async (argv, size, cb) =>
      new PtyChannelTransport(await execChannel(client, shellQuote(argv), size), cb),
    openUnixSocket: (path) =>
      new Promise<Duplex>((resolve, reject) => {
        client.openssh_forwardOutStreamLocal(path, (error, stream) => {
          if (error) reject(error)
          else resolve(stream)
        })
      }),
    openTcp: (host, port) =>
      new Promise<Duplex>((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
          if (error) reject(error)
          else resolve(stream)
        })
      })
  }
}
