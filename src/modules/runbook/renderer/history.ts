import type { StepResult } from '../shared/runbook'

/** Một lần chạy đã xong (kết quả đã che bí mật — xem runner). */
export interface RunRecord {
  at: number
  ok: boolean
  durationMs: number
  results: StepResult[]
}

const KEEP = 5
const key = (id: string): string => `runbook-history:${id}`

/** Lịch sử vài lần chạy gần nhất của một runbook (chỉ ở máy này, trong localStorage). */
export function loadHistory(id: string): RunRecord[] {
  try {
    const raw = localStorage.getItem(key(id))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as RunRecord[]).slice(0, KEEP) : []
  } catch {
    return []
  }
}

export function recordRun(id: string, record: RunRecord): RunRecord[] {
  const next = [record, ...loadHistory(id)].slice(0, KEEP)
  try {
    localStorage.setItem(key(id), JSON.stringify(next))
  } catch {
    // Hết chỗ / bị chặn — lịch sử chỉ là tiện ích.
  }
  return next
}

export function clearHistory(id: string): void {
  try {
    localStorage.removeItem(key(id))
  } catch {
    // Bỏ qua.
  }
}
