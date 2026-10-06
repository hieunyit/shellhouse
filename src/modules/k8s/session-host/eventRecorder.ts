import { slimEvent, type RecordedEvent } from '../shared/timeline'
import type { K8sObject } from '../shared/resources'
import { KubeError, type KubeClient } from './client'

/** Gom event chừng này rồi gửi một lô (event dồn dập lúc rollout / crash loop). */
const FLUSH_MS = 5_000
/** List ban đầu tối đa chừng này event (cluster lớn: phần cũ hơn đã hết hạn trên cluster sớm). */
const MAX_LIST = 5_000
/** Luồng watch hỏng → nối lại sau chừng này (tăng dần tới RETRY_MAX_MS). */
const RETRY_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000
/** Luồng watch không có byte nào quá lâu (kết nối chết im lặng) → nối lại. */
const IDLE_MS = 360_000
/** Báo main "vẫn đang ghi" (lô rỗng) chừng này một lần — tab Timeline biết có bản ghi 7 ngày. */
const HEARTBEAT_MS = 5 * 60_000

/**
 * Ghi event của cả cluster về máy (cho tab Timeline — cluster chỉ giữ event ~1 giờ): list một lần
 * rồi watch từ resourceVersion; 410 Gone → list lại. Gửi theo lô qua `sink` (main lưu SQLite, giữ 7
 * ngày). Chạy tới khi `signal` huỷ.
 */
export async function recordEvents(
  client: KubeClient,
  sink: (events: RecordedEvent[]) => Promise<void>,
  signal: AbortSignal
): Promise<void> {
  let pending: RecordedEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!pending.length) return
    const batch = pending
    pending = []
    void sink(batch).catch(() => undefined)
  }
  const push = (o: K8sObject): void => {
    const e = slimEvent(o)
    if (!e) return
    pending.push(e)
    if (pending.length >= 1000) flush()
    else timer ??= setTimeout(flush, FLUSH_MS)
  }
  const aborted = (): boolean => signal.aborted
  const beat = (): void => {
    void sink([]).catch(() => undefined)
  }
  beat()
  const heartbeat = setInterval(beat, HEARTBEAT_MS)
  let delay = RETRY_MS
  let rv = ''
  try {
    while (!aborted()) {
      try {
        if (!rv) rv = await listAll(client, push, signal)
        flush()
        // Đổi trong callback (eslint không theo được biến let qua closure).
        const state = { gone: false }
        let pendingText = ''
        await client.stream(
          'GET',
          '/api/v1/events',
          {
            query: {
              watch: true,
              resourceVersion: rv,
              allowWatchBookmarks: true,
              timeoutSeconds: 300
            },
            idleMs: IDLE_MS,
            signal
          },
          (chunk) => {
            pendingText += chunk.toString('utf8')
            let nl = pendingText.indexOf('\n')
            while (nl >= 0) {
              const line = pendingText.slice(0, nl).trim()
              pendingText = pendingText.slice(nl + 1)
              nl = pendingText.indexOf('\n')
              if (!line) continue
              let e: { type: string; object: K8sObject & { code?: number } }
              try {
                e = JSON.parse(line) as typeof e
              } catch {
                continue
              }
              if (e.type === 'ERROR') {
                if (e.object.code === 410) state.gone = true
                continue
              }
              if (e.object.metadata.resourceVersion) rv = e.object.metadata.resourceVersion
              if (e.type === 'ADDED' || e.type === 'MODIFIED') push(e.object)
            }
          }
        )
        delay = RETRY_MS
        // Hết hạn resourceVersion → list lại (bỏ qua phần đã mất — chỉ là event cũ).
        if (state.gone) rv = ''
      } catch (error) {
        if (aborted()) return
        if (error instanceof KubeError && error.status === 410) rv = ''
        else if (error instanceof KubeError && error.status === 403) return
        await sleep(delay, signal)
        delay = Math.min(delay * 2, RETRY_MAX_MS)
      }
    }
  } finally {
    clearInterval(heartbeat)
    flush()
  }
}

/** List mọi event (phân trang) → resourceVersion để watch tiếp. */
async function listAll(
  client: KubeClient,
  push: (o: K8sObject) => void,
  signal: AbortSignal
): Promise<string> {
  let cont: string | undefined
  let rv = ''
  let n = 0
  do {
    const r = await client.json<{
      items: K8sObject[] | null
      metadata?: { continue?: string; resourceVersion?: string }
    }>('GET', '/api/v1/events', { query: { limit: 500, continue: cont }, signal })
    for (const it of r.items ?? []) push(it)
    n += r.items?.length ?? 0
    rv = r.metadata?.resourceVersion ?? rv
    cont = r.metadata?.continue || undefined
  } while (cont && n < MAX_LIST)
  return rv
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
