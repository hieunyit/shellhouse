import { PORT_MESSAGE_TYPE } from '@shared/constants'
import type { SessionSpec } from '@shared/stream-protocol'
import { t } from '@shared/i18n'

const PORT_TIMEOUT_MS = 5_000

const arrived = new Map<string, MessagePort>()
const waiting = new Map<string, (port: MessagePort) => void>()

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  // Chỉ nhận tin do preload của chính cửa sổ này gửi.
  if (event.source !== window) return
  const data = event.data as { type?: unknown; sessionId?: unknown } | null
  if (data?.type !== PORT_MESSAGE_TYPE || typeof data.sessionId !== 'string') return
  const port = event.ports[0]
  if (!port) return
  const resolve = waiting.get(data.sessionId)
  if (resolve) {
    waiting.delete(data.sessionId)
    resolve(port)
  } else {
    arrived.set(data.sessionId, port)
  }
})

function waitForPort(sessionId: string): Promise<MessagePort> {
  const ready = arrived.get(sessionId)
  if (ready) {
    arrived.delete(sessionId)
    return Promise.resolve(ready)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(sessionId)
      reject(new Error(t('Did not receive the session data channel')))
    }, PORT_TIMEOUT_MS)
    waiting.set(sessionId, (port) => {
      clearTimeout(timer)
      resolve(port)
    })
  })
}

export async function openSession(
  spec: SessionSpec
): Promise<{ sessionId: string; port: MessagePort }> {
  const { sessionId } = await window.shellhouse.openSession(spec)
  return { sessionId, port: await waitForPort(sessionId) }
}
