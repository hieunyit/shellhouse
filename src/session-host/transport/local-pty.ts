import { homedir, userInfo } from 'node:os'
import type { IPty } from 'node-pty'
import { loadNative } from '../native'
import { defaultShell, type ShellLaunch } from './shell'
import type { Transport } from './types'

export interface PtyExit {
  code: number | null
  signal: number | null
}

export interface LocalPtyHandlers {
  onData(data: Uint8Array): void
  onExit(exit: PtyExit): void
}

function currentUserShell(): string | null {
  try {
    return userInfo().shell
  } catch {
    return null
  }
}

export function resolveLocalShell(appVersion: string): ShellLaunch {
  return defaultShell({
    platform: process.platform,
    env: process.env,
    homedir: homedir(),
    userShell: currentUserShell(),
    appVersion
  })
}

/** Shell local chạy trong PTY (forkpty trên Unix, ConPTY trên Windows). */
export class LocalPty implements Transport {
  private readonly pty: IPty
  private readonly encoder = new TextEncoder()
  private exited = false

  constructor(launch: ShellLaunch, cols: number, rows: number, handlers: LocalPtyHandlers) {
    const nodePty = loadNative('node-pty') as typeof import('node-pty')
    this.pty = nodePty.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: launch.cwd,
      env: launch.env,
      useConpty: true
    })
    this.pty.onData((data) => {
      handlers.onData(this.encoder.encode(data))
    })
    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true
      handlers.onExit({ code: exitCode, signal: signal ?? null })
    })
  }

  get pid(): number {
    return this.pty.pid
  }

  write(data: string): void {
    if (!this.exited) this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.pty.resize(cols, rows)
  }

  pause(): void {
    if (!this.exited) this.pty.pause()
  }

  resume(): void {
    if (!this.exited) this.pty.resume()
  }

  close(): void {
    if (this.exited) return
    try {
      this.pty.kill()
    } catch {
      // Tiến trình có thể đã thoát giữa chừng.
    }
  }
}
