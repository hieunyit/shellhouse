import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runInSession,
  SessionPool,
  type OneShotClient,
  type OneShotEvents,
  type SessionPrompt
} from '../../src/modules/registry/renderer-session'

afterEach(() => {
  vi.useRealTimers()
})

interface Harness {
  events: OneShotEvents
  client: OneShotClient & { closed: number; answers: unknown[] }
  opened: Promise<void>
}

function harness(openDelay = 0): {
  open: (events: OneShotEvents) => Promise<OneShotClient>
  get: () => Harness
} {
  let h: Harness | null = null
  return {
    open: (events) => {
      const client = {
        closed: 0,
        answers: [] as unknown[],
        request: () => Promise.resolve(undefined as never),
        answer(id: number, ok: boolean, answers: string[]) {
          client.answers.push({ id, ok, answers })
        },
        close() {
          client.closed++
        }
      }
      h = { events, client, opened: Promise.resolve() }
      return openDelay
        ? new Promise((resolve) =>
            setTimeout(() => {
              resolve(client)
            }, openDelay)
          )
        : Promise.resolve(client)
    },
    get: () => {
      if (!h) throw new Error('not opened')
      return h
    }
  }
}

const ctx = (extra: Partial<{ signal: AbortSignal; timeoutMs: number }> = {}) => {
  const prompts: { prompt: SessionPrompt; answer: (ok: boolean, a: string[]) => void }[] = []
  return {
    prompts,
    ctx: {
      signal: new AbortController().signal,
      timeoutMs: 1000,
      onPrompt: (prompt: SessionPrompt, answer: (ok: boolean, a: string[]) => void) => {
        prompts.push({ prompt, answer })
      },
      ...extra
    }
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('runInSession — việc một lần trong phiên module', () => {
  it('đợi "connected" rồi mới làm; trả kết quả và đóng phiên đúng một lần', async () => {
    const h = harness()
    const c = ctx()
    const work = vi.fn(() => Promise.resolve('xong'))
    const result = runInSession(h.open, c.ctx, work)
    await tick()
    h.get().events.onStatus?.('connecting', '')
    h.get().events.onStatus?.('authenticating', '')
    expect(work).not.toHaveBeenCalled()
    h.get().events.onStatus?.('connected', '')
    h.get().events.onStatus?.('connected', '')
    await expect(result).resolves.toBe('xong')
    expect(work).toHaveBeenCalledTimes(1)
    expect(h.get().client.closed).toBe(1)
  })

  it('việc ném lỗi → lỗi, phiên vẫn đóng', async () => {
    const h = harness()
    const result = runInSession(h.open, ctx().ctx, () => Promise.reject(new Error('boom')))
    await tick()
    h.get().events.onStatus?.('connected', '')
    await expect(result).rejects.toThrow('boom')
    expect(h.get().client.closed).toBe(1)
  })

  it('hết giờ trước khi kết nối được → lỗi "Did not finish", phiên đóng', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = runInSession(h.open, ctx({ timeoutMs: 5000 }).ctx, () => Promise.resolve(1))
    const assertion = expect(result).rejects.toThrow(/Did not finish within 5 s/)
    await vi.advanceTimersByTimeAsync(5001)
    await assertion
    expect(h.get().client.closed).toBe(1)
  })

  it('bị huỷ giữa chừng → lỗi "Cancelled"; đã huỷ từ đầu → không mở gì', async () => {
    const controller = new AbortController()
    const h = harness()
    const result = runInSession(h.open, ctx({ signal: controller.signal }).ctx, () =>
      Promise.resolve(1)
    )
    await tick()
    controller.abort()
    await expect(result).rejects.toThrow('Cancelled')
    expect(h.get().client.closed).toBe(1)

    const early = new AbortController()
    early.abort()
    const opened = vi.fn(() => Promise.reject(new Error('should not open')))
    await expect(
      runInSession(opened, ctx({ signal: early.signal }).ctx, () => Promise.resolve(1))
    ).rejects.toThrow('Cancelled')
    expect(opened).not.toHaveBeenCalled()
  })

  it('phiên mở chậm hơn lúc đã lỗi → phiên đến muộn vẫn bị đóng (không rò rỉ)', async () => {
    const h = harness(20)
    const controller = new AbortController()
    const result = runInSession(h.open, ctx({ signal: controller.signal }).ctx, () =>
      Promise.resolve(1)
    )
    controller.abort()
    await expect(result).rejects.toThrow('Cancelled')
    await new Promise((r) => setTimeout(r, 40))
    expect(h.get().client.closed).toBe(1)
  })

  it('lỗi / đứt phiên → lỗi có câu dễ hiểu theo lý do', async () => {
    for (const [reason, text] of [
      ['auth', /Could not sign in/],
      ['hostkey', /host key was not accepted/],
      ['network', /connection was closed/]
    ] as const) {
      const h = harness()
      const result = runInSession(h.open, ctx().ctx, () => Promise.resolve(1))
      await tick()
      h.get().events.onExit?.(reason)
      await expect(result).rejects.toThrow(text)
    }
    const h = harness()
    const result = runInSession(h.open, ctx().ctx, () => Promise.resolve(1))
    await tick()
    h.get().events.onError?.('No route to host')
    await expect(result).rejects.toThrow('No route to host')
  })

  it('hỏi mật khẩu: chuyển cho ctx.onPrompt, trả lời đi tới phiên; xong thì xoá hộp hỏi', async () => {
    const h = harness()
    const c = ctx()
    const result = runInSession(h.open, c.ctx, () => Promise.resolve('ok'))
    await tick()
    const prompt = { id: 7, request: { kind: 'password' } } as unknown as SessionPrompt
    h.get().events.onPrompt?.(prompt)
    expect(c.prompts.at(-1)?.prompt).toBe(prompt)
    c.prompts.at(-1)?.answer(true, ['hunter2'])
    expect(h.get().client.answers).toEqual([{ id: 7, ok: true, answers: ['hunter2'] }])
    h.get().events.onStatus?.('connected', '')
    await result
    // Khi kết thúc, hộp hỏi được gỡ (null).
    expect(c.prompts.at(-1)?.prompt).toBeNull()
  })

  it('remainingMs giảm dần theo thời gian đã dùng', async () => {
    vi.useFakeTimers()
    const h = harness()
    let left = -1
    const result = runInSession(h.open, ctx({ timeoutMs: 10_000 }).ctx, (_c, remaining) => {
      left = remaining()
      return Promise.resolve(1)
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3000)
    h.get().events.onStatus?.('connected', '')
    await result
    expect(left).toBe(7000)
  })
})

describe('SessionPool — dùng chung phiên theo đích trong một lần chạy', () => {
  /** Mở đếm số lần; "kết nối xong" ngay sau khi trả client. */
  function counted(): { open: Parameters<typeof runInSession>[0]; opened: number; closed: number } {
    const state = {
      opened: 0,
      closed: 0,
      open: null as never as Parameters<typeof runInSession>[0]
    }
    state.open = (events) => {
      state.opened++
      setTimeout(() => {
        events.onStatus?.('connected', '')
      }, 0)
      return Promise.resolve({
        request: () => Promise.resolve(undefined as never),
        answer: () => undefined,
        close: () => {
          state.closed++
        }
      })
    }
    return state
  }

  it('cùng khoá: mở một lần, việc sau dùng lại; closeAll đóng một lần', async () => {
    const h = counted()
    const pool = new SessionPool()
    const c = ctx()
    const run = (): Promise<string> =>
      runInSession(h.open, { ...c.ctx, pool }, () => Promise.resolve('ok'), 'ssh:a')
    expect(await run()).toBe('ok')
    expect(await run()).toBe('ok')
    expect(await run()).toBe('ok')
    expect(h.opened).toBe(1)
    expect(h.closed).toBe(0)
    // Khoá khác → phiên khác.
    await runInSession(h.open, { ...c.ctx, pool }, () => Promise.resolve('ok'), 'ssh:b')
    expect(h.opened).toBe(2)
    pool.closeAll()
    await tick()
    expect(h.closed).toBe(2)
  })

  it('việc lỗi → bỏ phiên (đóng thật); việc sau mở phiên mới', async () => {
    const h = counted()
    const pool = new SessionPool()
    const c = ctx()
    await expect(
      runInSession(h.open, { ...c.ctx, pool }, () => Promise.reject(new Error('boom')), 'k')
    ).rejects.toThrow('boom')
    expect(h.closed).toBe(1)
    await runInSession(h.open, { ...c.ctx, pool }, () => Promise.resolve(1), 'k')
    expect(h.opened).toBe(2)
  })

  it('không có pool → mỗi việc một phiên, đóng sau mỗi việc', async () => {
    const h = counted()
    const c = ctx()
    await runInSession(h.open, c.ctx, () => Promise.resolve(1), 'k')
    await runInSession(h.open, c.ctx, () => Promise.resolve(1), 'k')
    expect(h.opened).toBe(2)
    expect(h.closed).toBe(2)
  })

  it('phiên dùng chung bị đứt → bỏ khỏi pool; việc sau kết nối lại', async () => {
    let events: OneShotEvents | null = null
    let opened = 0
    const open: Parameters<typeof runInSession>[0] = (e) => {
      opened++
      events = e
      setTimeout(() => {
        e.onStatus?.('connected', '')
      }, 0)
      return Promise.resolve({
        request: () => Promise.resolve(undefined as never),
        answer: () => undefined,
        close: () => undefined
      })
    }
    const pool = new SessionPool()
    const c = ctx()
    await runInSession(open, { ...c.ctx, pool }, () => Promise.resolve(1), 'k')
    ;(events as OneShotEvents | null)?.onExit?.('closed')
    await runInSession(open, { ...c.ctx, pool }, () => Promise.resolve(1), 'k')
    expect(opened).toBe(2)
  })
})
