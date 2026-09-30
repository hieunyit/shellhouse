import { create } from 'zustand'
import type { S3AccountSummary } from '@shared/s3'

interface S3Store {
  accounts: S3AccountSummary[]
  reload: () => Promise<void>
}

export const useS3 = create<S3Store>((set) => ({
  accounts: [],
  reload: async () => {
    set({ accounts: await window.shellhouse.s3Accounts() })
  }
}))

window.shellhouse.onS3Changed(() => {
  void useS3.getState().reload()
})
