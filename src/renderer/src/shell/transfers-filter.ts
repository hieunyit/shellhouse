import { create } from 'zustand'
import { t } from '@shared/i18n'
import type { TransferStatus } from '@shared/sftp'
import type { TransferSource } from '../stores/transfers'

export type TransferFilter = 'all' | 'active' | 'queued' | 'failed' | 'done'

export const TRANSFER_FILTERS: readonly { id: TransferFilter; title: () => string }[] = [
  { id: 'all', title: () => t('All') },
  { id: 'active', title: () => t('Active') },
  { id: 'queued', title: () => t('Queued') },
  { id: 'failed', title: () => t('Failed') },
  { id: 'done', title: () => t('Completed') }
]

export function matchesFilter(x: TransferStatus, filter: TransferFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return x.state === 'running'
    case 'queued':
      return x.state === 'queued'
    case 'failed':
      return x.state === 'error' || x.state === 'cancelled'
    case 'done':
      return x.state === 'done'
  }
}

/** Số hàng hiện trong Transfers: mỗi lần tải thư mục (batch) chỉ tính một hàng, không tính từng file. */
export function rowKey(x: TransferStatus): string {
  return x.batch?.id ?? x.id
}

export function transferCounts(
  sources: Record<string, TransferSource>
): Record<TransferFilter, number> {
  const seen: Record<TransferFilter, Set<string>> = {
    all: new Set(),
    active: new Set(),
    queued: new Set(),
    failed: new Set(),
    done: new Set()
  }
  for (const src of Object.values(sources))
    for (const x of src.transfers)
      for (const f of TRANSFER_FILTERS)
        if (matchesFilter(x, f.id)) seen[f.id].add(`${src.id}:${rowKey(x)}`)
  return {
    all: seen.all.size,
    active: seen.active.size,
    queued: seen.queued.size,
    failed: seen.failed.size,
    done: seen.done.size
  }
}

export const useTransfersFilter = create<{
  filter: TransferFilter
  setFilter: (filter: TransferFilter) => void
}>((set) => ({
  filter: 'all',
  setFilter: (filter) => {
    set({ filter })
  }
}))
