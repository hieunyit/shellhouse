import { create } from 'zustand'
import type { VaultState } from '@shared/ipc'

interface VaultStore {
  state: VaultState | null
  /** Đã mở khoá ít nhất một lần trong phiên chạy này (để giữ các tab khi khoá lại). */
  everUnlocked: boolean
}

export const useVault = create<VaultStore>(() => ({ state: null, everUnlocked: false }))

function apply(state: VaultState): void {
  useVault.setState((s) => ({ state, everUnlocked: s.everUnlocked || state === 'unlocked' }))
}

void window.shellhouse.vaultState().then(apply)
window.shellhouse.onVaultState(apply)
