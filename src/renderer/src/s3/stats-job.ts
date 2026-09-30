import { EMPTY_STATS, type S3Op, type S3StatsProgress } from '@shared/s3'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Một lượt thống kê chạy nền trong Session Host (quét song song nhiều request); renderer chỉ hỏi
 * tiến độ định kỳ. `isStopped()` = true → dừng lượt đó và trả về con số đã đếm được.
 */
export async function runStatsJob(
  run: (op: S3Op) => Promise<unknown>,
  bucket: string,
  prefix: string,
  onProgress: (progress: S3StatsProgress) => void,
  isStopped: () => boolean
): Promise<{ result: S3StatsProgress; stopped: boolean }> {
  const id = (await run({ op: 'statsStart', bucket, prefix })) as string
  // Hỏi sớm (bucket nhỏ xong gần như ngay), sau đó giãn ra.
  for (let wait = 60; ; wait = Math.min(300, wait * 2)) {
    await sleep(wait)
    if (isStopped()) {
      const last = (await run({ op: 'statsStop', id }).catch(() => null)) as S3StatsProgress | null
      return { result: last ?? { ...EMPTY_STATS, done: true, error: null }, stopped: true }
    }
    const progress = (await run({ op: 'statsPoll', id })) as S3StatsProgress
    onProgress(progress)
    if (progress.done) return { result: progress, stopped: false }
  }
}

/** Chạy `fn` cho từng phần tử, tối đa `limit` cùng lúc (lỗi của từng việc do `fn` tự xử lý). */
export async function eachLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
