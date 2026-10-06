import { createContext, useContext, useEffect, useRef, useState } from 'react'

/**
 * Nhịp làm mới của tab Kubernetes: phần đọc một lần (pod của Deployment / Service / Node, tài
 * nguyên liên quan…) đọc lại mỗi khi nhịp tăng. Tăng mỗi REFRESH_MS khi tab đang hiện và cửa sổ
 * đang mở, và ngay khi quay lại tab. Bảng chính dùng watch nên không cần nhịp này.
 */
export const REFRESH_MS = 10_000
/** Tab bị ẩn lâu hơn chừng này → quay lại thì đọc lại cả bảng (watch có thể đã rơi). */
export const STALE_AFTER_MS = 30_000

export const RefreshContext = createContext(0)

export function useRefreshTick(): number {
  return useContext(RefreshContext)
}

/** Bộ đếm nhịp cho một tab; `onStale` gọi khi quay lại sau thời gian ẩn dài. */
export function useRefreshClock(active: boolean, onStale: () => void): number {
  const [tick, setTick] = useState(0)
  const hiddenAt = useRef<number | null>(null)
  const staleRef = useRef(onStale)
  useEffect(() => {
    staleRef.current = onStale
  }, [onStale])
  useEffect(() => {
    if (!active) {
      hiddenAt.current ??= Date.now()
      return
    }
    // Vừa quay lại tab: làm mới ngay; ẩn lâu → đọc lại cả bảng.
    if (hiddenAt.current !== null) {
      if (Date.now() - hiddenAt.current >= STALE_AFTER_MS) staleRef.current()
      hiddenAt.current = null
      setTick((n) => n + 1)
    }
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1)
    }, REFRESH_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active])
  return tick
}
