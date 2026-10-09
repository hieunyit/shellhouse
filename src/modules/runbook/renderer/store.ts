import { create } from 'zustand'
import type { Runbook } from '../shared/runbook'
import { runbookApi } from './api'

interface RunbookStore {
  runbooks: Runbook[]
  loaded: boolean
  reload: () => Promise<void>
}

export const useRunbooks = create<RunbookStore>((set) => ({
  runbooks: [],
  loaded: false,
  reload: async () => {
    set({ runbooks: await runbookApi.list(), loaded: true })
  }
}))

runbookApi.onChanged(() => {
  void useRunbooks.getState().reload()
})
