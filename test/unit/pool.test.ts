import { describe, expect, it } from 'vitest'
import { createLimiter, mapLimit, runQueue } from '../../src/node-shared/pool'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('pool', () => {
  it('createLimiter: không vượt trần, chạy hết mọi việc', async () => {
    const limit = createLimiter(3)
    let active = 0
    let peak = 0
    const out = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limit(async () => {
          active++
          peak = Math.max(peak, active)
          await sleep(5)
          active--
          return i
        })
      )
    )
    expect(peak).toBe(3)
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('createLimiter: việc mới đến đúng lúc một việc xong không chen vượt trần', async () => {
    // Lời gọi mới rơi vào khe giữa "trả chỗ" và "việc đang chờ chạy" (vài microtask sau khi xong).
    for (let ticks = 0; ticks < 5; ticks++) {
      const limit = createLimiter(1)
      let active = 0
      let peak = 0
      const late: Promise<void>[] = []
      const job = (hook: boolean): Promise<void> =>
        limit(async () => {
          active++
          peak = Math.max(peak, active)
          await sleep(1)
          active--
          if (!hook) return
          let p = Promise.resolve()
          for (let i = 0; i < ticks; i++) p = p.then(() => undefined)
          void p.then(() => late.push(job(false)))
        })
      await Promise.all([job(true), job(false)])
      await sleep(10)
      await Promise.all(late)
      expect(peak).toBe(1)
    }
  })

  it('mapLimit: giữ thứ tự, song song thật (đúng trần), lỗi → reject', async () => {
    // Đếm số việc chạy cùng lúc thay vì đo đồng hồ (không phụ thuộc máy nhanh / chậm).
    let active = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3, 1, 2, 5], 3, async (ms, i) => {
      active++
      peak = Math.max(peak, active)
      await sleep(ms)
      active--
      return i * 2
    })
    expect(out).toEqual([0, 2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBe(3)
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('hỏng')
        await sleep(1)
        return n
      })
    ).rejects.toThrow('hỏng')
    expect(await mapLimit([], 4, () => Promise.resolve(1))).toEqual([])
  })

  it('runQueue: duyệt cây với việc con, trần song song, lỗi và huỷ', async () => {
    // Cây: 1 → 2 con → mỗi con 3 cháu = 1 + 2 + 6 = 9 việc.
    const seen: number[] = []
    let active = 0
    let peak = 0
    await runQueue([0], 4, async (depth, push) => {
      active++
      peak = Math.max(peak, active)
      seen.push(depth)
      await sleep(3)
      if (depth === 0) for (let i = 0; i < 2; i++) push(1)
      if (depth === 1) for (let i = 0; i < 3; i++) push(2)
      active--
    })
    expect(seen.sort()).toEqual([0, 1, 1, 2, 2, 2, 2, 2, 2])
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)

    await expect(
      runQueue([1, 2, 3], 2, async (n) => {
        await sleep(1)
        if (n === 2) throw new Error('lỗi con')
      })
    ).rejects.toThrow('lỗi con')

    const abort = new AbortController()
    const running = runQueue(
      [0],
      2,
      async (_n, push) => {
        await sleep(5)
        push(0) // vô tận nếu không huỷ
      },
      abort.signal
    )
    setTimeout(() => {
      abort.abort(new Error('Cancelled'))
    }, 30)
    await expect(running).rejects.toThrow('Cancelled')
    await runQueue([], 3, () => Promise.resolve())
  })
})
