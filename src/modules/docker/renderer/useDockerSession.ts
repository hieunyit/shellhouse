import { useCallback, useEffect, useRef, useState } from 'react'
import type { PromptRequest } from '@shared/stream-protocol'
import { ModuleSessionClient, whenHostRunning, setTabState } from '../../registry/renderer-kit'
import type { DockerOp } from '../shared/ops'
import { wslDistroOf } from '../shared/ipc'
import { useDocker } from './store'

export interface DockerSession {
  /** null = đang kết nối. */
  ready: boolean
  /** Lỗi kết nối (phiên đã đóng). */
  error: string | null
  /** Dòng trạng thái khi đang kết nối SSH. */
  status: string
  prompt: { id: number; request: PromptRequest } | null
  answer: (ok: boolean, answers: string[]) => void
  request: <T>(op: DockerOp, signal?: AbortSignal) => Promise<T>
  readOnly: boolean
  /** Kết nối lại (sau lỗi / mất kết nối). */
  retry: () => void
}

/**
 * Phiên Docker của một tab: trên máy này (phiên module `docker/engine`) hoặc gắn vào kết nối SSH
 * tới host đã lưu (tab tự mở kết nối, hỏi mật khẩu / host key như tab terminal).
 */
export function useDockerSession(
  tabId: string,
  hostId: string | undefined,
  onEvent: (event: string, data: unknown) => void
): DockerSession {
  const clientRef = useRef<ModuleSessionClient | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState(
    wslDistroOf(hostId)
      ? `Connecting to Docker in ${wslDistroOf(hostId) ?? ''} (WSL)…`
      : hostId
        ? 'Connecting…'
        : 'Looking for Docker on this computer…'
  )
  const [prompt, setPrompt] = useState<DockerSession['prompt']>(null)
  const [attempt, setAttempt] = useState(0)
  const onEventRef = useRef(onEvent)
  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])
  const readOnly = useDocker((s) =>
    s.endpoints.some((e) => e.hostId === (hostId ?? null) && e.readOnly)
  )

  useEffect(() => {
    let cancelled = false
    setTabState(tabId, 'connecting')
    const fail = (message: string): void => {
      if (cancelled) return
      setError(message)
      setReady(false)
      setTabState(tabId, 'disconnected')
    }
    void ModuleSessionClient.open(
      'docker',
      wslDistroOf(hostId)
        ? { kind: 'module', sessionKind: 'engine', params: { wsl: wslDistroOf(hostId) } }
        : hostId
          ? { kind: 'ssh', hostId }
          : { kind: 'module', sessionKind: 'engine', params: {} },
      {
        onStatus: (phase, detail) => {
          if (cancelled) return
          setStatus(detail)
          if (phase === 'connected') {
            setReady(true)
            setTabState(tabId, 'connected')
          }
        },
        onPrompt: (p) => {
          if (!cancelled) setPrompt(p)
        },
        onError: (message) => {
          fail(message)
        },
        onExit: (reason) => {
          fail(
            reason === 'auth'
              ? 'Could not log in to the server.'
              : reason === 'hostkey'
                ? 'The host key was not accepted.'
                : 'The connection was closed.'
          )
        },
        onEvent: (event, data) => {
          onEventRef.current(event, data)
        },
        onHostRestart: () => {
          if (cancelled) return
          // Session Host vừa khởi động lại: đợi nó chạy rồi mở phiên mới (kết nối lại) thay vì treo.
          setStatus('The session host restarted — reconnecting…')
          void whenHostRunning().then(() => {
            if (cancelled) return
            setReady(false)
            setAttempt((a) => a + 1)
          })
        }
      }
    ).then(
      (client) => {
        if (cancelled) {
          client.close()
          return
        }
        clientRef.current = client
      },
      (e: unknown) => {
        fail(e instanceof Error ? e.message : String(e))
      }
    )
    return () => {
      cancelled = true
      clientRef.current?.close()
      clientRef.current = null
      setTabState(tabId, null)
    }
  }, [tabId, hostId, attempt])

  // Chế độ chỉ đọc cũng được Session Host kiểm (thao tác thay đổi bị từ chối).
  useEffect(() => {
    if (ready) void clientRef.current?.request({ op: 'configure', readOnly }).catch(() => undefined)
  }, [ready, readOnly])

  const request = useCallback(<T>(op: DockerOp, signal?: AbortSignal): Promise<T> => {
    const client = clientRef.current
    if (!client) return Promise.reject(new Error('Not connected'))
    return client.request<T>(op, signal)
  }, [])

  const answer = useCallback(
    (ok: boolean, answers: string[]) => {
      if (prompt) clientRef.current?.answer(prompt.id, ok, answers)
      setPrompt(null)
    },
    [prompt]
  )

  const retry = useCallback(() => {
    setReady(false)
    setError(null)
    setStatus('Connecting…')
    setAttempt((a) => a + 1)
  }, [])

  return { ready, error, status, prompt, answer, request, readOnly, retry }
}
