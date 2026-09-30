import { create } from 'zustand'
import type { S3AccountSummary } from '../shared/ops'
import { s3Api } from './api'

interface S3Store {
  accounts: S3AccountSummary[]
  reload: () => Promise<void>
}

export const useS3 = create<S3Store>((set) => ({
  accounts: [],
  reload: async () => {
    set({ accounts: await s3Api.accounts() })
  }
}))

s3Api.onChanged(() => {
  void useS3.getState().reload()
})
