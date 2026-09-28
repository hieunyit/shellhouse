import { create } from 'zustand'
import type { SessionHostStatus } from '@shared/ipc'

interface HostStatusState {
  status: SessionHostStatus | null
}

export const useHostStatus = create<HostStatusState>(() => ({ status: null }))

void window.shellhouse.getSessionHostStatus().then((status) => {
  useHostStatus.setState({ status })
})
window.shellhouse.onSessionHostStatus((status) => {
  useHostStatus.setState({ status })
})
