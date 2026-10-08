import type { TransferStatus } from '@shared/sftp'

/**
 * Lần tải thư mục = hàng trăm lượt truyền nhỏ. Trung tâm Transfers gộp chúng thành MỘT dòng
 * (mở ra mới thấy từng file) — không để một thư mục 5.000 file nhấn chìm mọi lượt khác.
 */
export interface BatchItem<S extends { id: string }> {
  src: S
  x: TransferStatus
}

export type TransferEntry<S extends { id: string }> =
  | { kind: 'one'; key: string; item: BatchItem<S> }
  | {
      kind: 'batch'
      key: string
      src: S
      label: string
      members: BatchItem<S>[]
      summary: BatchSummary
    }

export interface BatchSummary {
  count: number
  done: number
  /** Lỗi hoặc đã huỷ. */
  failed: number
  running: number
  queued: number
  /** Tổng dung lượng các file đã biết kích thước. */
  size: number
  transferred: number
  bytesPerSecond: number
  /** 0..1 theo số file: file xong tính 1, file đang chạy tính theo byte. */
  ratio: number
}

export type TransferSection = 'failed' | 'active' | 'queued' | 'done'

export function summarize(list: readonly TransferStatus[]): BatchSummary {
  const s: BatchSummary = {
    count: list.length,
    done: 0,
    failed: 0,
    running: 0,
    queued: 0,
    size: 0,
    transferred: 0,
    bytesPerSecond: 0,
    ratio: 0
  }
  let progress = 0
  for (const x of list) {
    s.size += x.size
    s.transferred += x.transferred
    if (x.state === 'done') {
      s.done++
      progress += 1
    } else if (x.state === 'running') {
      s.running++
      s.bytesPerSecond += x.bytesPerSecond
      progress += x.size > 0 ? Math.min(1, x.transferred / x.size) : 0
    } else if (x.state === 'queued') s.queued++
    else {
      s.failed++
      progress += x.size > 0 ? Math.min(1, x.transferred / x.size) : 0
    }
  }
  s.ratio = list.length > 0 ? progress / list.length : 0
  return s
}

/** Nhóm hiển thị của cả lần tải: lỗi trước, rồi đang chạy, chờ, xong. */
export function sectionOf(s: BatchSummary): TransferSection {
  if (s.failed > 0) return 'failed'
  if (s.running > 0) return 'active'
  if (s.queued > 0) return 'queued'
  return 'done'
}

/**
 * Gộp các lượt cùng một nguồn + cùng `batch` (từ `minMembers` lượt trở lên) thành một mục; còn lại
 * giữ riêng. Thứ tự theo lần xuất hiện đầu tiên.
 */
export function collapseBatches<S extends { id: string }>(
  items: readonly BatchItem<S>[],
  minMembers = 2
): TransferEntry<S>[] {
  const byBatch = new Map<string, BatchItem<S>[]>()
  for (const item of items) {
    const batch = item.x.batch
    if (!batch) continue
    const key = `${item.src.id}:${batch.id}`
    const list = byBatch.get(key)
    if (list) list.push(item)
    else byBatch.set(key, [item])
  }
  const out: TransferEntry<S>[] = []
  const emitted = new Set<string>()
  for (const item of items) {
    const batch = item.x.batch
    const key = batch ? `${item.src.id}:${batch.id}` : ''
    const members = key ? byBatch.get(key) : undefined
    if (batch && members && members.length >= minMembers) {
      if (emitted.has(key)) continue
      emitted.add(key)
      out.push({
        kind: 'batch',
        key: `batch:${key}`,
        src: item.src,
        label: batch.label,
        members,
        summary: summarize(members.map((m) => m.x))
      })
    } else out.push({ kind: 'one', key: `${item.src.id}:${item.x.id}`, item })
  }
  return out
}
