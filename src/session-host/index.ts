/**
 * Session Host — chạy trong Electron utilityProcess.
 * Sẽ chứa mọi kết nối SSH, PTY, SFTP, forwarding. Crash ở đây không làm sập UI;
 * main sẽ tự khởi động lại process này.
 */
import type { MessagePortMain } from 'electron'
import {
  HostRequest,
  type HostEvent,
  type HostKeyCheck,
  type NativeModuleStatus
} from '@shared/session-host-protocol'
import { checkSessionHostNativeModules } from './selfcheck'
import { SessionRegistry } from './session/registry'
import type { SessionPort } from './session/session'
import { HostModuleRegistry } from '../modules/registry/session-host'
import { HOST_MODULES } from '../modules/registry/all-host'

const port = process.parentPort
const appVersion =
  process.argv.find((a) => a.startsWith('--app-version='))?.slice('--app-version='.length) ??
  '0.0.0'

function post(event: HostEvent): void {
  port.postMessage(event)
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'log', level, message })
}

process.on('uncaughtException', (error) => {
  // Lỗi không bắt được thì trạng thái không còn tin cậy: báo lại rồi thoát để main restart.
  log('error', `uncaughtException: ${error.stack ?? error.message}`)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log('error', `unhandledRejection: ${String(reason)}`)
})

// Yêu cầu kiểm tra host key gửi sang main (nơi giữ known_hosts), chờ kết quả theo requestId.
let nextHostKeyRequest = 1
const hostKeyRequests = new Map<number, (result: HostKeyCheck) => void>()

// Module muốn chạy chương trình trên máy → hỏi main (người dùng), chờ theo requestId.
let nextGrantRequest = 1
const grantRequests = new Map<number, (allowed: boolean) => void>()

const modules = new HostModuleRegistry(HOST_MODULES, {
  log,
  requestProgramGrant: (module, binary, path, sha256) =>
    new Promise((resolve) => {
      const requestId = nextGrantRequest++
      grantRequests.set(requestId, resolve)
      post({ type: 'module:grant', requestId, module, binary, path, sha256 })
    })
})

const sessions = new SessionRegistry({
  log,
  appVersion,
  modules,
  hostKeys: {
    check: (host, portNumber, key) =>
      new Promise((resolve) => {
        const requestId = nextHostKeyRequest++
        hostKeyRequests.set(requestId, resolve)
        post({
          type: 'hostkey:check',
          requestId,
          host,
          port: portNumber,
          key: key.toString('base64')
        })
      }),
    trust: (host, portNumber, key) => {
      post({ type: 'hostkey:trust', host, port: portNumber, key: key.toString('base64') })
    }
  }
})

function adaptPort(p: MessagePortMain): SessionPort {
  return {
    postMessage: (message) => {
      p.postMessage(message)
    },
    onMessage: (listener) => {
      p.on('message', (e) => {
        listener(e.data)
      })
    },
    onClose: (listener) => {
      p.on('close', listener)
    },
    start: () => {
      p.start()
    },
    close: () => {
      p.close()
    }
  }
}

port.on('message', (event) => {
  const parsed = HostRequest.safeParse(event.data)
  if (!parsed.success) {
    log('warn', `Ignoring invalid message: ${parsed.error.message}`)
    return
  }
  const request = parsed.data
  switch (request.type) {
    case 'ping':
      post({ type: 'pong', id: request.id })
      break
    case 'selfcheck':
      void checkSessionHostNativeModules().then((modules: NativeModuleStatus[]) => {
        post({ type: 'selfcheck:result', id: request.id, modules })
      })
      break
    case 'session:open': {
      const sessionPort = event.ports[0]
      if (!sessionPort || event.ports.length !== 1) {
        log('warn', `session:open ${request.sessionId} is missing its MessagePort`)
        return
      }
      sessions.open(request.sessionId, request.spec, adaptPort(sessionPort), {
        ...(request.ssh
          ? {
              knownKeyTypes: request.ssh.knownKeyTypes,
              ...(request.ssh.credentials ? { credentials: request.ssh.credentials } : {}),
              ...(request.ssh.keyFiles ? { keyFiles: request.ssh.keyFiles } : {}),
              ...(request.ssh.jumps ? { jumps: request.ssh.jumps } : {}),
              ...(request.ssh.legacyAlgorithms ? { legacyAlgorithms: true } : {}),
              ...(request.ssh.storedOnly ? { storedOnly: true } : {}),
              ...(request.ssh.autoForwards ? { autoForwards: request.ssh.autoForwards } : {})
            }
          : {}),
        ...(request.log ? { log: request.log } : {})
      })
      break
    }
    case 'hostkey:result': {
      const resolve = hostKeyRequests.get(request.requestId)
      hostKeyRequests.delete(request.requestId)
      resolve?.(request.result)
      break
    }
    case 'session:close':
      sessions.close(request.sessionId)
      break
    case 'modules:enabled':
      modules.setEnabled(request.ids)
      break
    case 'module:grant-result': {
      const resolve = grantRequests.get(request.requestId)
      grantRequests.delete(request.requestId)
      resolve?.(request.allowed)
      break
    }
    case 'crash':
      log('warn', 'Received crash command (test)')
      process.exit(70)
  }
})

post({ type: 'ready', pid: process.pid })
