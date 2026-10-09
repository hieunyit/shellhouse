import { t } from '@shared/i18n'
import type { PromptRequest } from '@shared/stream-protocol'

/** Hộp hỏi mật khẩu / host key mà một phiên đang chờ (null = không còn gì chờ). */
export type SessionPrompt = { id: number; request: PromptRequest } | null

/** Bối cảnh chạy một việc một lần trong phiên (gồm cả bước runbook). */
export interface OneShotContext {
  /** Huỷ khi người dùng dừng. */
  signal: AbortSignal
  /** Thời gian tối đa (ms), tính cả lúc kết nối. */
  timeoutMs: number
  /** Phiên cần hỏi: hiện hộp hỏi; `answer` trả lời; gọi lại với null khi hết chờ. */
  onPrompt: (prompt: SessionPrompt, answer: (ok: boolean, answers: string[]) => void) => void
  /**
   * Có = dùng chung phiên theo đích giữa các việc (các bước của một lần chạy runbook): cùng host
   * chỉ kết nối / hỏi mật khẩu một lần. Không có = mỗi việc một phiên riêng.
   */
  pool?: SessionPool
}

/**
 * Cái `ModuleSessionClient` cần tối thiểu để chạy một việc một lần (kiểu cấu trúc để test không cần
 * Session Host thật).
 */
export interface OneShotClient {
  request<T = unknown>(op: unknown, signal?: AbortSignal): Promise<T>
  answer(id: number, ok: boolean, answers: string[]): void
  close(): void
  /** Phiên dùng chung: việc lỗi giữa chừng → bỏ hẳn phiên (việc sau mở phiên mới). */
  discard?(): void
}

export interface OneShotEvents {
  onStatus?(phase: string, detail: string): void
  onPrompt?(prompt: SessionPrompt): void
  onError?(message: string): void
  onExit?(reason: string): void
  onHostRestart?(): void
}

export type OpenClient = (events: OneShotEvents) => Promise<OneShotClient>

/**
 * Mở một phiên, đợi kết nối xong, chạy `work`, đóng phiên (luôn) — cho việc một lần như một bước
 * runbook. Hết giờ / bị huỷ / phiên đứt đều làm bước lỗi và đóng phiên. Hỏi mật khẩu / host key được
 * chuyển cho `ctx.onPrompt`.
 */
export function runInSession<T>(
  open: OpenClient,
  ctx: OneShotContext,
  work: (client: OneShotClient, remainingMs: () => number) => Promise<T>,
  /** Khoá của đích (module + tham số phiên) — dùng chung phiên khi `ctx.pool` có. */
  poolKey?: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const startedAt = Date.now()
    let client: OneShotClient | null = null
    let settled = false
    let started = false
    const finish = (run: () => void, failed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      ctx.onPrompt(null, () => undefined)
      // Lỗi / hết giờ / huỷ giữa chừng: phiên có thể còn việc dở → không cho việc sau dùng lại.
      if (failed) client?.discard?.()
      client?.close()
      run()
    }
    const fail = (error: Error): void => {
      finish(() => {
        reject(error)
      }, true)
    }
    const timer = setTimeout(() => {
      fail(new Error(t('Did not finish within {n} s', { n: Math.round(ctx.timeoutMs / 1000) })))
    }, ctx.timeoutMs)
    const onAbort = (): void => {
      fail(new Error('Cancelled'))
    }
    if (ctx.signal.aborted) {
      onAbort()
      return
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const remaining = (): number => Math.max(0, ctx.timeoutMs - (Date.now() - startedAt))
    const opener = ctx.pool && poolKey !== undefined ? ctx.pool.opener(poolKey, open) : open
    opener({
      onStatus: (phase) => {
        if (phase !== 'connected' || started || !client) return
        started = true
        work(client, remaining).then(
          (value) => {
            finish(() => {
              resolve(value)
            }, false)
          },
          (e: unknown) => {
            fail(e instanceof Error ? e : new Error(String(e)))
          }
        )
      },
      onPrompt: (prompt) => {
        ctx.onPrompt(prompt, (ok, answers) => {
          if (prompt) client?.answer(prompt.id, ok, answers)
        })
      },
      onError: (message) => {
        fail(new Error(message))
      },
      onExit: (reason) => {
        fail(
          new Error(
            reason === 'auth'
              ? t('Could not sign in.')
              : reason === 'hostkey'
                ? t('The host key was not accepted.')
                : t('The connection was closed.')
          )
        )
      },
      onHostRestart: () => {
        fail(new Error(t('The session host restarted.')))
      }
    }).then(
      (c) => {
        if (settled) {
          // Chỉ tới đây khi đã lỗi (thành công cần có client).
          c.discard?.()
          c.close()
          return
        }
        client = c
      },
      (e: unknown) => {
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

interface PoolEntry {
  client: Promise<OneShotClient>
  connected: boolean
  /** Sự kiện của việc đang dùng phiên (null = không ai dùng). */
  current: OneShotEvents | null
}

/**
 * Phiên dùng chung theo đích trong một lần chạy (ADR-016): bước sau trên cùng host / cluster / engine
 * dùng lại phiên đã kết nối — không hỏi mật khẩu / host key lại. Các việc chạy TUẦN TỰ (mỗi lúc một
 * việc dùng một phiên). Phiên đứt / lỗi → bỏ khỏi pool, việc sau mở phiên mới. `closeAll` khi xong.
 */
export class SessionPool {
  private readonly entries = new Map<string, PoolEntry>()

  /** `OpenClient` cho đích `key`: mở thật lần đầu, các lần sau trả phiên đã có. */
  opener(key: string, open: OpenClient): OpenClient {
    return (events) => {
      const have = this.entries.get(key)
      if (have) {
        have.current = events
        return have.client.then((client) => {
          if (have.connected)
            // Như phiên mới vừa kết nối xong — báo SAU khi runInSession đã giữ client (macrotask).
            setTimeout(() => {
              if (have.current === events) events.onStatus?.('connected', '')
            }, 0)
          return this.lease(key, have, client, events)
        })
      }
      const entry: PoolEntry = {
        client: Promise.resolve(null as never),
        connected: false,
        current: events
      }
      const drop = (): void => {
        if (this.entries.get(key) === entry) this.entries.delete(key)
      }
      entry.client = open({
        onStatus: (phase, detail) => {
          if (phase === 'connected') entry.connected = true
          entry.current?.onStatus?.(phase, detail)
        },
        onPrompt: (prompt) => entry.current?.onPrompt?.(prompt),
        onError: (message) => {
          drop()
          entry.current?.onError?.(message)
        },
        onExit: (reason) => {
          drop()
          entry.current?.onExit?.(reason)
        },
        onHostRestart: () => {
          drop()
          entry.current?.onHostRestart?.()
        }
      })
      this.entries.set(key, entry)
      entry.client.catch(drop)
      return entry.client.then((client) => this.lease(key, entry, client, events))
    }
  }

  /** Client cho một việc: `close` chỉ trả phiên về pool; `discard` đóng thật và bỏ khỏi pool. */
  private lease(
    key: string,
    entry: PoolEntry,
    client: OneShotClient,
    events: OneShotEvents
  ): OneShotClient {
    return {
      request: (op, signal) => client.request(op, signal),
      answer: (id, ok, answers) => {
        client.answer(id, ok, answers)
      },
      close: () => {
        if (entry.current === events) entry.current = null
      },
      discard: () => {
        if (this.entries.get(key) === entry) this.entries.delete(key)
        if (entry.current === events) entry.current = null
        client.close()
      }
    }
  }

  /** Đóng mọi phiên (hết lần chạy). */
  closeAll(): void {
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const e of entries) {
      e.current = null
      void e.client.then(
        (c) => {
          c.close()
        },
        () => undefined
      )
    }
  }
}
