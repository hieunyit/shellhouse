import { join } from 'node:path'
import { app, utilityProcess } from 'electron'
import log from 'electron-log/main'
import type { HostProcess } from './supervisor'

/** Chạy Session Host trong Electron utilityProcess (giống pty host của VS Code). */
export function spawnElectronHost(): HostProcess {
  const child = utilityProcess.fork(
    join(__dirname, 'session-host.js'),
    [`--app-version=${app.getVersion()}`],
    {
      serviceName: 'Shellhouse Session Host',
      stdio: 'pipe'
    }
  )
  const hostLog = log.scope('session-host')
  child.stdout?.on('data', (chunk: Buffer) => {
    hostLog.info(chunk.toString().trimEnd())
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    hostLog.error(chunk.toString().trimEnd())
  })

  return {
    get pid() {
      return child.pid
    },
    postMessage: (message, transfer) => {
      child.postMessage(message, transfer)
    },
    kill: () => {
      child.kill()
    },
    onMessage: (listener) => {
      child.on('message', listener)
    },
    onExit: (listener) => {
      child.on('exit', (code: number) => {
        listener(code)
      })
    }
  }
}
