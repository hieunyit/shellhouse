/**
 * Chạy song song có giới hạn — cho các thao tác mạng nhiều bước (duyệt cây thư mục S3 / SFTP, xoá
 * hàng loạt, thống kê). Nhiều request cùng lúc trên một kết nối nhanh hơn hẳn chờ từng cái, nhưng
 * phải có trần để không làm nghẽn server.
 */

/**
 * Bộ giới hạn kiểu p-limit: tối đa `concurrency` hàm chạy cùng lúc, còn lại xếp hàng.
 * Chỉ bọc các thao tác "lá" (một request) — không bọc hàm đang chờ việc con, tránh tự khoá.
 */
export function createLimiter(concurrency: number): <R>(fn: () => Promise<R>) => Promise<R> {
  const max = Math.max(1, Math.floor(concurrency))
  let active = 0
  const waiting: (() => void)[] = []
  const next = (): void => {
    // Trao thẳng chỗ cho việc đang chờ (active giữ nguyên). Giảm rồi để việc chờ tự tăng thì giữa
    // hai bước, một lời gọi mới thấy còn chỗ và chạy luôn → vượt trần.
    const waiter = waiting.shift()
    if (waiter) waiter()
    else active--
  }
  return async <R>(fn: () => Promise<R>): Promise<R> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    else active++
    try {
      return await fn()
    } finally {
      next()
    }
  }
}

/** Như `Promise.all(items.map(fn))` nhưng tối đa `limit` việc cùng lúc; giữ thứ tự kết quả. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && nextIndex < items.length) {
      const i = nextIndex++
      try {
        results[i] = await fn(items[i] as T, i)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return results
}

/**
 * Hàng đợi động (duyệt cây): mỗi việc có thể thêm việc con bằng `push`. Tối đa `limit` việc chạy
 * cùng lúc; xong khi hết việc. Lỗi đầu tiên (hoặc `signal` bị huỷ) → không nhận việc mới, reject.
 */
export function runQueue<T>(
  initial: readonly T[],
  limit: number,
  work: (task: T, push: (task: T) => void) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const queue = [...initial]
  const max = Math.max(1, Math.floor(limit))
  let active = 0
  let settled = false
  return new Promise<void>((resolve, reject) => {
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const onAbort = (): void => {
      fail(signal?.reason ?? new Error('Cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const pump = (): void => {
      if (settled) return
      if (signal?.aborted) {
        onAbort()
        return
      }
      if (queue.length === 0 && active === 0) {
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve()
        return
      }
      while (active < max && queue.length > 0) {
        const task = queue.shift() as T
        active++
        work(task, (child) => {
          if (!settled) queue.push(child)
        }).then(
          () => {
            active--
            pump()
          },
          (error: unknown) => {
            active--
            signal?.removeEventListener('abort', onAbort)
            fail(error)
          }
        )
      }
    }
    pump()
  })
}
