import type { NativeModuleStatus } from '@shared/session-host-protocol'
import { loadNative } from './native'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Mở một PTY thật chạy lệnh thoát ngay, để xác nhận node-pty dùng được trên máy này. */
async function checkNodePty(): Promise<NativeModuleStatus> {
  try {
    const pty = loadNative('node-pty') as typeof import('node-pty')
    const isWindows = process.platform === 'win32'
    const file = isWindows ? 'cmd.exe' : '/bin/sh'
    const args = isWindows ? ['/c', 'exit 0'] : ['-c', 'exit 0']
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = pty.spawn(file, args, { cols: 80, rows: 24, env: process.env })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('PTY did not exit within 5 s'))
      }, 5_000)
      child.onExit(({ exitCode: code }) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    return {
      name: 'node-pty',
      process: 'session-host',
      ok: exitCode === 0,
      detail: `spawn ${file} → exit ${exitCode}`
    }
  } catch (error) {
    return { name: 'node-pty', process: 'session-host', ok: false, detail: errorText(error) }
  }
}

function checkSsh2(): NativeModuleStatus {
  try {
    const { Client } = loadNative('ssh2') as typeof import('ssh2')
    const ok = typeof Client === 'function'
    return {
      name: 'ssh2',
      process: 'session-host',
      ok,
      detail: ok ? 'Loaded (pure JS)' : 'Client not found'
    }
  } catch (error) {
    return { name: 'ssh2', process: 'session-host', ok: false, detail: errorText(error) }
  }
}

export async function checkSessionHostNativeModules(): Promise<NativeModuleStatus[]> {
  return [await checkNodePty(), checkSsh2()]
}
