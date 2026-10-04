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

export function transferCounts(
  sources: Record<string, TransferSource>
): Record<TransferFilter, number> {
  const counts: Record<TransferFilter, number> = {
    all: 0,
    active: 0,
    queued: 0,
    failed: 0,
    done: 0
  }
  for (const src of Object.values(sources))
    for (const x of src.transfers)
      for (const f of TRANSFER_FILTERS) if (matchesFilter(x, f.id)) counts[f.id]++
  return counts
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
