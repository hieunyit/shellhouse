import { create } from 'zustand'
import type { S3AccountSummary } from '../shared/ops'
import { s3Api } from './api'
import { S3SessionClient } from './s3-client'

/** Danh sách bucket của một tài khoản cho Explorer: đang tải / đã có / lỗi. */
export type BucketList =
  { state: 'loading' } | { state: 'ready'; names: string[] } | { state: 'error'; message: string }

interface S3Store {
  accounts: S3AccountSummary[]
  reload: () => Promise<void>
  /** Bucket theo tài khoản (Explorer mở rộng account; tab S3 đang mở cũng cập nhật). */
  buckets: Readonly<Record<string, BucketList>>
  setBuckets: (accountId: string, names: string[]) => void
  /** Đọc danh sách bucket bằng một phiên ngắn (mở → listBuckets → đóng); `force` = đọc lại. */
  loadBuckets: (accountId: string, force?: boolean) => Promise<void>
}

export const useS3 = create<S3Store>((set, get) => ({
  accounts: [],
  reload: async () => {
    set({ accounts: await s3Api.accounts() })
  },
  buckets: {},
  setBuckets: (accountId, names) => {
    const prev = get().buckets[accountId]
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    if (prev?.state === 'ready' && prev.names.join('\n') === sorted.join('\n')) return
    set((s) => ({ buckets: { ...s.buckets, [accountId]: { state: 'ready', names: sorted } } }))
  },
  loadBuckets: async (accountId, force = false) => {
    const prev = get().buckets[accountId]
    if (prev && !force && prev.state !== 'error') return
    set((s) => ({ buckets: { ...s.buckets, [accountId]: { state: 'loading' } } }))
    let client: S3SessionClient | null = null
    try {
      client = await S3SessionClient.open(accountId, () => undefined)
      const list = (await client.request({ op: 'listBuckets' })) as { name: string }[]
      get().setBuckets(
        accountId,
        list.map((b) => b.name)
      )
    } catch (error) {
      set((s) => ({
        buckets: {
          ...s.buckets,
          [accountId]: {
            state: 'error',
            message: error instanceof Error ? error.message : String(error)
          }
        }
      }))
    } finally {
      client?.close()
    }
  }
}))

s3Api.onChanged(() => {
  void useS3.getState().reload()
})
