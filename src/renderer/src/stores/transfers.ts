import { useEffect, useLayoutEffect, useRef } from 'react'
import { create } from 'zustand'
import type { TransferStatus } from '@shared/sftp'

/**
 * Trung tâm truyền file (khu vực Transfers + status bar): gom danh sách truyền của mọi nguồn — mỗi
 * panel SFTP, mỗi tab S3 — vào một chỗ. Nguồn tự đăng ký khi có lượt truyền và tự gỡ khi đóng; thao
 * tác (huỷ, thử lại, bỏ, dọn) gọi ngược về nguồn.
 */
export interface TransferSource {
  id: string
  /** Tên hiển thị: host / bucket. */
  label: string
  kind: 'sftp' | 's3'
  transfers: TransferStatus[]
  cancel: (id: string) => void
  clear: (keepParts?: boolean) => void
  retry?: (id: string) => void
  discard?: (id: string) => void
  /** Chuyển tới nơi đang truyền (tab của nguồn). */
  reveal?: () => void
}

interface TransfersState {
  sources: Record<string, TransferSource>
  publish: (source: TransferSource) => void
  remove: (id: string) => void
  /** Số lượt đang chạy / chờ trên mọi nguồn. */
  activeCount: () => number
}

const isActive = (x: TransferStatus): boolean => x.state === 'running' || x.state === 'queued'

export const useTransfers = create<TransfersState>((set, get) => ({
  sources: {},
  publish: (source) => {
    if (source.transfers.length === 0) {
      get().remove(source.id)
      return
    }
    set((s) => ({ sources: { ...s.sources, [source.id]: source } }))
  },
  remove: (id) => {
    if (!(id in get().sources)) return
    set((s) => ({
      sources: Object.fromEntries(Object.entries(s.sources).filter(([key]) => key !== id))
    }))
  },
  activeCount: () =>
    Object.values(get().sources).reduce((n, src) => n + src.transfers.filter(isActive).length, 0)
}))

/** Tổng hợp cho status bar: số lượt đang chạy và phần trăm đã xong (theo byte). */
export function transferSummary(sources: Record<string, TransferSource>): {
  active: number
  failed: number
  progress: number | null
} {
  let active = 0
  let failed = 0
  let total = 0
  let moved = 0
  for (const src of Object.values(sources))
    for (const x of src.transfers) {
      if (x.state === 'error') failed++
      if (!isActive(x)) continue
      active++
      total += x.size
      moved += x.transferred
    }
  return { active, failed, progress: total > 0 ? Math.min(1, moved / total) : null }
}

/**
 * Đăng ký danh sách truyền của một nguồn (gọi trong component sở hữu lượt truyền). Thao tác đọc
 * qua ref → không đăng ký lại mỗi lần vẽ; gỡ khi component gỡ.
 */
export function usePublishTransfers(source: TransferSource): void {
  const ref = useRef(source)
  useLayoutEffect(() => {
    ref.current = source
  })
  const { id, label, kind, transfers } = source
  useEffect(() => {
    useTransfers.getState().publish({
      id,
      label,
      kind,
      transfers,
      cancel: (x) => {
        ref.current.cancel(x)
      },
      clear: (keep) => {
        ref.current.clear(keep)
      },
      ...(ref.current.retry
        ? {
            retry: (x: string) => {
              ref.current.retry?.(x)
            }
          }
        : {}),
      ...(ref.current.discard
        ? {
            discard: (x: string) => {
              ref.current.discard?.(x)
            }
          }
        : {}),
      reveal: () => {
        ref.current.reveal?.()
      }
    })
  }, [id, label, kind, transfers])
  useEffect(
    () => () => {
      useTransfers.getState().remove(id)
    },
    [id]
  )
}
