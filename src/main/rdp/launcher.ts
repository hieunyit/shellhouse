import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { t } from '@shared/i18n'
import { mstscFileOnlyOptions, type RdpFileOnlyOption, type RdpStatusEvent } from '@shared/rdp'
import {
  cmdkeyAddArgs,
  cmdkeyDeleteArgs,
  freerdpArgs,
  macOpenArgs,
  mstscArgs,
  remminaArgs
} from './argv'
import type { DetectedClient } from './detect'
import { buildRdpFile, buildRemminaFile, encodeRdpFile, type RdpTarget } from './rdp-file'

/** Phần của ChildProcess launcher dùng (test thay bằng tiến trình giả). */
export interface ChildLike {
  readonly stdin: {
    write(data: string): unknown
    end(): unknown
    on(e: 'error', l: () => void): unknown
  } | null
  readonly stderr: { on(e: 'data', l: (chunk: Buffer) => void): unknown } | null
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  kill(): boolean
}

export interface LauncherDeps {
  platform: NodeJS.Platform
  /** Thư mục tạm riêng của app (0700) — file .rdp / .remmina nằm ở đây. */
  tempDir: string
  home: string
  /** Chạy client: luôn là mảng đối số, không bao giờ qua shell. */
  spawn(file: string, args: string[], io: { stdin: boolean; stderr: boolean }): ChildLike
  /** Chạy lệnh ngắn (cmdkey) và đợi mã thoát; null = không chạy được. */
  run(file: string, args: string[]): Promise<number | null>
  /** Như `run` nhưng đồng bộ — lúc thoát app không còn vòng lặp sự kiện để đợi. */
  runSync?(file: string, args: string[]): void
  /** Ghi file chỉ chủ sở hữu đọc được (0600), không đè file có sẵn. */
  writePrivate(path: string, data: Buffer | string): void
  remove(path: string): void
  log: { info(message: string): void; warn(message: string): void }
  onStatus(event: RdpStatusEvent): void
  /** E2E (client `stub`): ghi lại kế hoạch chạy thay vì mở client thật. */
  recordStub?(summary: Record<string, unknown>): void
  /** Xoá file cấu hình sau chừng này ms dù client còn chạy (client đã đọc xong từ lâu). */
  fileTtlMs?: number
  /** Remmina thoát với mã 0 trong khoảng này = đã giao cho phiên Remmina đang chạy sẵn. */
  handoffMs?: number
  now?: () => number
}

export interface LaunchPlan {
  client: DetectedClient
  target: RdpTarget
  /** Mật khẩu (đã giải mã / người dùng vừa gõ) — chỉ đi qua stdin hoặc cmdkey, không ghi file. */
  password: string | null
}

interface Running {
  id: string
  client: DetectedClient
  child: ChildLike | null
  files: string[]
  /** Host đã thêm mục TERMSRV/<host> bằng cmdkey (xoá khi xong). */
  credential: string | null
  stopping: boolean
  startedAt: number
  stderr: string
  timers: ReturnType<typeof setTimeout>[]
  done: boolean
}

const STDERR_TAIL = 4096

/** Mã thoát của xfreerdp (client/X11/xf_client.h) → thông báo dễ hiểu; null = kết thúc bình thường. */
export function freerdpExitMessage(code: number | null, stderrTail: string): string | null {
  if (code === null || code <= 5 || code === 11 || code === 12) return null
  switch (code) {
    case 128:
      return t('FreeRDP rejected the connection settings')
    case 131:
    case 141:
    case 147:
      return t('Could not reach the Remote Desktop server')
    case 132:
    case 134:
    case 154:
      return t('Sign-in failed — check the username, domain and password')
    case 135:
      return t('The account is locked out')
    case 139:
    case 140:
      return t('The server name could not be resolved')
    case 143:
      return t('The secure (TLS) connection failed')
    case 148:
    case 149:
    case 152:
      return t('The password has expired and must be changed')
    case 151:
      return t('The account is disabled')
    case 155:
    case 158:
      return t('Access denied — the account is not allowed to sign in remotely')
    case 159:
      return t('No credentials were provided')
  }
  const last = stderrTail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  return last
    ? t('The Remote Desktop client exited with code {code}: {detail}', {
        code,
        detail: last.slice(0, 300)
      })
    : t('The Remote Desktop client exited with code {code}', { code })
}

/**
 * Chạy client RDP của hệ điều hành và theo dõi tới khi nó thoát: dọn file tạm, xoá mục
 * Credential Manager đã thêm, báo renderer (đóng tunnel SSH). Một Shellhouse có thể mở nhiều phiên.
 */
export class RdpLauncher {
  private readonly running = new Map<string, Running>()
  /** Số phiên đang dùng mỗi mục TERMSRV/<host> — chỉ xoá khi phiên cuối cùng thoát. */
  private readonly credentialUsers = new Map<string, number>()

  constructor(private readonly deps: LauncherDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Client có được Shellhouse giữ tiến trình hay không (biết khi nào nó thoát). */
  static tracked(client: DetectedClient): boolean {
    return client.kind !== 'windows-app'
  }

  /**
   * `unsignedFile` = tuỳ chọn buộc mstsc mở bằng file .rdp tạm (Windows sẽ cảnh báo "Unknown
   * publisher"); rỗng = không dùng file chưa ký.
   */
  async launch(
    plan: LaunchPlan
  ): Promise<{ launchId: string; tracked: boolean; unsignedFile: RdpFileOnlyOption[] }> {
    const id = randomUUID()
    const entry: Running = {
      id,
      client: plan.client,
      child: null,
      files: [],
      credential: null,
      stopping: false,
      startedAt: this.now(),
      stderr: '',
      timers: [],
      done: false
    }
    this.running.set(id, entry)
    let unsignedFile: RdpFileOnlyOption[]
    try {
      unsignedFile = await this.start(entry, plan)
    } catch (error) {
      this.running.delete(id)
      await this.cleanup(entry)
      throw error
    }
    this.deps.log.info(
      `RDP ${id}: ${plan.client.name} → ${plan.target.host}:${plan.target.port}` +
        (plan.password ? ' (password provided)' : '')
    )
    return { launchId: id, tracked: RdpLauncher.tracked(plan.client), unsignedFile }
  }

  private file(entry: Running, extension: string, data: Buffer | string): string {
    const path = join(this.deps.tempDir, `${randomUUID()}${extension}`)
    this.deps.writePrivate(path, data)
    entry.files.push(path)
    // Client đọc file ngay lúc khởi động; không để file nằm lại lâu hơn cần thiết.
    const timer = setTimeout(() => {
      this.removeFiles(entry)
    }, this.deps.fileTtlMs ?? 60_000)
    timer.unref()
    entry.timers.push(timer)
    return path
  }

  /** Chạy client; trả các tuỳ chọn buộc mstsc dùng file .rdp chưa ký (khác mstsc: rỗng). */
  private async start(entry: Running, plan: LaunchPlan): Promise<RdpFileOnlyOption[]> {
    const { client, target, password } = plan
    const fileOnly = mstscFileOnlyOptions(target.settings)
    const credential = password !== null && target.username !== ''
    switch (client.kind) {
      case 'stub': {
        this.deps.recordStub?.({
          client: client.name,
          host: target.host,
          port: target.port,
          username: target.username,
          domain: target.domain,
          fullScreen: target.settings.fullScreen,
          passwordProvided: password !== null,
          rdpFile: buildRdpFile(target),
          // Như mstsc: tham số dòng lệnh nếu được, không thì file .rdp.
          mstscArgs: fileOnly.length === 0 ? mstscArgs(target, { prompt: !credential }) : null
        })
        return fileOnly
      }
      case 'mstsc': {
        // Tham số dòng lệnh khi đủ diễn đạt cài đặt của host: file .rdp tạm không ký được, Windows
        // cảnh báo "Unknown publisher" mỗi lần mở.
        const args =
          fileOnly.length > 0
            ? [this.file(entry, '.rdp', encodeRdpFile(buildRdpFile(target)))]
            : mstscArgs(target, { prompt: !credential })
        if (password && target.username) {
          if (!client.cmdkey)
            throw new Error(t('cmdkey.exe was not found — cannot pass the saved password to mstsc'))
          const code = await this.deps.run(
            client.cmdkey,
            cmdkeyAddArgs(target.host, target.username, target.domain, password)
          )
          if (code !== 0)
            throw new Error(t('Could not store the credentials for mstsc (cmdkey failed)'))
          entry.credential = target.host
          this.credentialUsers.set(target.host, (this.credentialUsers.get(target.host) ?? 0) + 1)
        }
        await this.spawnTracked(entry, client.path, args, null)
        return fileOnly
      }
      case 'windows-app': {
        const file = this.file(entry, '.rdp', encodeRdpFile(buildRdpFile(target)))
        const child = await this.spawnChild(
          entry,
          '/usr/bin/open',
          macOpenArgs(client.path, file),
          null
        )
        const code = await new Promise<number | null>((resolve) => {
          child.once('exit', (c) => {
            resolve(c)
          })
        })
        entry.child = null
        if (code !== 0) throw new Error(t('Could not open {app}', { app: client.name }))
        return []
      }
      case 'xfreerdp': {
        const args = freerdpArgs(target, {
          major: client.freerdpMajor ?? 3,
          passwordOnStdin: password !== null
        })
        await this.spawnTracked(entry, client.path, args, password)
        return []
      }
      case 'remmina': {
        const file = this.file(entry, '.remmina', buildRemminaFile(target, this.deps.home))
        await this.spawnTracked(entry, client.path, remminaArgs(file), null)
        return []
      }
    }
  }

  /** spawn + đợi tới khi tiến trình thật sự chạy (ENOENT… → lỗi ngay, không treo). */
  private spawnChild(
    entry: Running,
    file: string,
    args: string[],
    password: string | null
  ): Promise<ChildLike> {
    const child = this.deps.spawn(file, args, { stdin: password !== null, stderr: true })
    entry.child = child
    child.stderr?.on('data', (chunk: Buffer) => {
      entry.stderr = (entry.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL)
    })
    return new Promise((resolve, reject) => {
      child.once('error', (error) => {
        reject(
          new Error(
            t('Could not start {client}: {error}', {
              client: entry.client.name,
              error: error.message
            })
          )
        )
      })
      child.once('spawn', () => {
        if (password !== null && child.stdin) {
          // Client thoát sớm → EPIPE; không để lỗi ghi stdin làm sập main.
          child.stdin.on('error', () => undefined)
          child.stdin.write(`${password}\n`)
          child.stdin.end()
        }
        resolve(child)
      })
    })
  }

  private async spawnTracked(
    entry: Running,
    file: string,
    args: string[],
    password: string | null
  ): Promise<void> {
    const child = await this.spawnChild(entry, file, args, password)
    child.once('exit', (code) => {
      void this.exited(entry, code)
    })
  }

  private async exited(entry: Running, code: number | null): Promise<void> {
    entry.child = null
    const quick = this.now() - entry.startedAt < (this.deps.handoffMs ?? 5_000)
    if (entry.client.kind === 'remmina' && code === 0 && quick && !entry.stopping) {
      // Remmina đã chạy sẵn: lệnh vừa rồi chỉ chuyển kết nối cho nó rồi thoát.
      this.deps.onStatus({ launchId: entry.id, state: 'detached', code, message: null })
      return
    }
    this.running.delete(entry.id)
    await this.cleanup(entry)
    const message =
      entry.stopping || entry.client.kind !== 'xfreerdp'
        ? null
        : freerdpExitMessage(code, entry.stderr)
    this.deps.log.info(`RDP ${entry.id}: exited (${String(code)})`)
    this.deps.onStatus({ launchId: entry.id, state: 'exited', code, message })
  }

  /** Disconnect: đóng client nếu Shellhouse giữ tiến trình, dọn file / mục cmdkey. */
  async stop(launchId: string): Promise<void> {
    const entry = this.running.get(launchId)
    if (!entry) return
    entry.stopping = true
    if (entry.child) {
      entry.child.kill()
      return // dọn khi tiến trình thoát (sự kiện 'exit')
    }
    this.running.delete(launchId)
    await this.cleanup(entry)
    this.deps.onStatus({ launchId, state: 'exited', code: null, message: null })
  }

  /**
   * Thoát app: đóng mọi client đang giữ (tunnel SSH cũng sắp đóng theo app), xoá file tạm và mục
   * Credential Manager — đồng bộ, vì app thoát ngay sau đó.
   */
  disposeAll(): void {
    const entries = [...this.running.values()]
    this.running.clear()
    for (const entry of entries) {
      entry.stopping = true
      entry.done = true
      entry.child?.kill()
      for (const timer of entry.timers) clearTimeout(timer)
      this.removeFiles(entry)
      if (entry.credential && entry.client.cmdkey)
        this.deps.runSync?.(entry.client.cmdkey, cmdkeyDeleteArgs(entry.credential))
      entry.credential = null
    }
    this.credentialUsers.clear()
  }

  get size(): number {
    return this.running.size
  }

  private removeFiles(entry: Running): void {
    for (const f of entry.files.splice(0)) {
      try {
        this.deps.remove(f)
      } catch (error) {
        this.deps.log.warn(`RDP: could not remove ${f}: ${String(error)}`)
      }
    }
  }

  private async cleanup(entry: Running): Promise<void> {
    if (entry.done) return
    entry.done = true
    for (const timer of entry.timers) clearTimeout(timer)
    this.removeFiles(entry)
    const host = entry.credential
    entry.credential = null
    if (!host || !entry.client.cmdkey) return
    const users = (this.credentialUsers.get(host) ?? 1) - 1
    if (users > 0) {
      this.credentialUsers.set(host, users)
      return
    }
    this.credentialUsers.delete(host)
    const code = await this.deps.run(entry.client.cmdkey, cmdkeyDeleteArgs(host))
    if (code !== 0) this.deps.log.warn(`RDP: cmdkey /delete failed for ${host}`)
  }
}
