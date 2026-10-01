import { useCallback, useEffect, useRef, useState } from 'react'
import type { PromptRequest } from '@shared/stream-protocol'
import { ModuleSessionClient, whenHostRunning, setTabState } from '../../registry/renderer-kit'
import type { ContextRef, K8sOp } from '../shared/ops'

export interface K8sSession {
  ready: boolean
  error: string | null
  status: string
  /** Phiên bản Kubernetes + namespace mặc định của context. */
  cluster: { version: string; namespace: string } | null
  prompt: { id: number; request: PromptRequest } | null
  answer: (ok: boolean, answers: string[]) => void
  request: <T>(op: K8sOp, signal?: AbortSignal) => Promise<T>
  retry: () => void
}

/**
 * Phiên Kubernetes của một tab: phiên module (API server tới thẳng được) hoặc gắn vào kết nối SSH
 * tới host bastion; sau đó `connect` tới context (thông tin xác thực đi main → Session Host).
 */
export function useK8sSession(
  tabId: string,
  ref: ContextRef,
  bastionHostId: string | undefined,
  readOnly: boolean,
  onEvent: (event: string, data: unknown) => void
): K8sSession {
  const clientRef = useRef<ModuleSessionClient | null>(null)
  const [transportReady, setTransportReady] = useState(false)
  const [cluster, setCluster] = useState<K8sSession['cluster']>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState(bastionHostId ? 'Connecting to the bastion…' : 'Connecting…')
  const [prompt, setPrompt] = useState<K8sSession['prompt']>(null)
  const [attempt, setAttempt] = useState(0)
  const onEventRef = useRef(onEvent)
  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])
  const refKey = `${ref.source}#${ref.context}`

  useEffect(() => {
    let cancelled = false
    setTabState(tabId, 'connecting')
    const fail = (message: string): void => {
      if (cancelled) return
      setError(message)
      setTransportReady(false)
      setTabState(tabId, 'disconnected')
    }
    void ModuleSessionClient.open(
      'k8s',
      bastionHostId
        ? { kind: 'ssh', hostId: bastionHostId }
        : { kind: 'module', sessionKind: 'cluster', params: {} },
      {
        onStatus: (phase, detail) => {
          if (cancelled) return
          setStatus(detail)
          if (phase === 'connected') setTransportReady(true)
        },
        onPrompt: (p) => {
          if (!cancelled) setPrompt(p)
        },
        onError: fail,
        onExit: (reason) => {
          fail(
            reason === 'auth'
              ? 'Could not log in to the bastion host.'
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
            setCluster(null)
            setTransportReady(false)
            setAttempt((a) => a + 1)
          })
        }
      }
    ).then(
      (client) => {
        if (cancelled) client.close()
        else clientRef.current = client
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
  }, [tabId, bastionHostId, attempt])

  // Kết nối tới context (và lại khi đổi chế độ chỉ đọc — Session Host cũng chặn thao tác thay đổi).
  useEffect(() => {
    if (!transportReady) return
    let cancelled = false
    const client = clientRef.current
    if (!client) return
    client
      .request<{ version: string; namespace: string }>({
        op: 'connect',
        ref: { source: ref.source, context: ref.context },
        readOnly
      })
      .then(
        (info) => {
          if (cancelled) return
          setCluster(info)
          setTabState(tabId, 'connected')
        },
        (e: unknown) => {
          if (cancelled) return
          setError(e instanceof Error ? e.message : String(e))
          setTabState(tabId, 'disconnected')
        }
      )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refKey đại diện cho ref
  }, [transportReady, refKey, readOnly, tabId])

  const request = useCallback(<T>(op: K8sOp, signal?: AbortSignal): Promise<T> => {
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
    setError(null)
    setCluster(null)
    setTransportReady(false)
    setAttempt((a) => a + 1)
  }, [])

  return {
    ready: transportReady && cluster !== null,
    error,
    status: cluster || !transportReady ? status : 'Connecting to the cluster…',
    cluster,
    prompt,
    answer,
    request,
    retry
  }
}
