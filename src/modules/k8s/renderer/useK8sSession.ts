import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PromptRequest } from '@shared/stream-protocol'
import { ModuleSessionClient, whenHostRunning, setTabState, t } from '../../registry/renderer-kit'
import type { ContextRef, K8sOp } from '../shared/ops'

export interface K8sSession {
  ready: boolean
  error: string | null
  status: string
  /** Phiên bản Kubernetes + namespace mặc định của context. */
  /** readOnly: chỉ đọc thật sự (Session Host gộp cả cài đặt trong DB) — bản cũ không có. */
  cluster: { version: string; namespace: string; readOnly?: boolean } | null
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
  /**
   * Id của kết nối phiên đang dùng (null = chưa sẵn sàng). Mỗi lần mở phiên một id mới — đổi sang
   * context qua bastion khác mở phiên mới, effect `connect` chạy lại kể cả khi phiên cũ vẫn "sẵn sàng".
   */
  const [transportId, setTransportId] = useState<number | null>(null)
  const transportSeq = useRef(0)
  const transportReady = transportId !== null
  // Thông tin cluster gắn với context đã tạo ra nó: đổi context trong tab → null ngay (không gửi
  // yêu cầu tới context cũ trong lúc đang kết nối context mới).
  const [connected, setCluster] = useState<{
    key: string
    transport: number
    info: { version: string; namespace: string; readOnly?: boolean }
    /** Lần kết nối (mỗi lần một `request` mới → hook dùng chung theo `request` không lẫn dữ liệu). */
    seq: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState(() =>
    bastionHostId ? t('Connecting to the bastion…') : t('Connecting…')
  )
  const [prompt, setPrompt] = useState<K8sSession['prompt']>(null)
  const [attempt, setAttempt] = useState(0)
  const onEventRef = useRef(onEvent)
  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])
  const refKey = `${ref.source}#${ref.context}`
  const cluster =
    connected?.key === refKey && connected.transport === transportId ? connected.info : null
  const connSeq = useRef(0)
  /** seq của lần kết nối đang dùng (đặt ngay khi connect xong, trước khi render). */
  const liveSeq = useRef(0)
  /** (context, phiên) của seq đang dùng — chỉ đổi một trong hai mới cần seq mới. */
  const liveFor = useRef('')

  useEffect(() => {
    let cancelled = false
    setTabState(tabId, 'connecting')
    const fail = (message: string): void => {
      if (cancelled) return
      setError(message)
      setTransportId(null)
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
          if (phase === 'connected') {
            transportSeq.current += 1
            setTransportId(transportSeq.current)
          }
        },
        onPrompt: (p) => {
          if (!cancelled) setPrompt(p)
        },
        onError: fail,
        onExit: (reason) => {
          fail(
            reason === 'auth'
              ? t('Could not log in to the bastion host.')
              : reason === 'hostkey'
                ? t('The host key was not accepted.')
                : t('The connection was closed.')
          )
        },
        onEvent: (event, data) => {
          onEventRef.current(event, data)
        },
        onHostRestart: () => {
          if (cancelled) return
          // Session Host vừa khởi động lại: đợi nó chạy rồi mở phiên mới (kết nối lại) thay vì treo.
          setStatus(t('The session host restarted — reconnecting…'))
          void whenHostRunning().then(() => {
            if (cancelled) return
            setCluster(null)
            setTransportId(null)
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
    if (transportId === null) return
    let cancelled = false
    const client = clientRef.current
    if (!client) return
    client
      .request<{ version: string; namespace: string; readOnly?: boolean }>({
        op: 'connect',
        ref: { source: ref.source, context: ref.context },
        readOnly
      })
      .then(
        (info) => {
          if (cancelled) return
          // Kết nối lại cùng context, cùng phiên (chỉ đổi chế độ chỉ đọc): giữ seq → `request` giữ
          // nguyên, danh sách đang xem không bị xoá rồi tải lại (watch giữ kết nối riêng, vẫn chạy).
          const conn = `${String(transportId)}|${refKey}`
          if (liveFor.current !== conn) {
            liveFor.current = conn
            connSeq.current += 1
            liveSeq.current = connSeq.current
          }
          setCluster({ key: refKey, transport: transportId, info, seq: connSeq.current })
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
  }, [transportId, refKey, readOnly, tabId])

  // Mỗi lần kết nối (đổi context, mở phiên mới) một hàm mới: effect phụ thuộc `request` chạy lại,
  // bộ nhớ dùng chung theo `request` (traffic, số liệu) không lẫn giữa hai cluster.
  const seq = cluster ? (connected?.seq ?? 0) : 0
  const request = useMemo(
    () =>
      <T>(op: K8sOp, signal?: AbortSignal): Promise<T> => {
        const client = clientRef.current
        if (!client) return Promise.reject(new Error(t('Not connected')))
        // Hàm của lần kết nối trước (context cũ): không gửi yêu cầu mới sang context mới — trừ
        // huỷ đăng ký (dọn watch / log của effect cũ).
        if (seq !== liveSeq.current && op.op !== 'unsubscribe')
          return Promise.reject(new Error(t('The connection changed')))
        return client.request<T>(op, signal)
      },
    [seq]
  )

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
    setTransportId(null)
    setAttempt((a) => a + 1)
  }, [])

  return {
    ready: transportReady && cluster !== null,
    error,
    status: cluster || !transportReady ? status : t('Connecting to the cluster…'),
    cluster,
    prompt,
    answer,
    request,
    retry
  }
}
