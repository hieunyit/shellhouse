import { create } from 'zustand'
import type { InvokeResult } from '@shared/ipc'

export type ShellInfo = InvokeResult<'shells:list'>['shells'][number]

/** Shell local có trên máy (main dò: PowerShell, cmd, WSL, Git Bash, zsh…). */
interface ShellsStore {
  shells: readonly ShellInfo[]
  defaultId: string | null
  load: (refresh?: boolean) => Promise<void>
}

export const useShells = create<ShellsStore>((set) => ({
  shells: [],
  defaultId: null,
  load: async (refresh = false) => {
    const r = await window.shellhouse.listShells(refresh)
    set({ shells: r.shells, defaultId: r.defaultId })
  }
}))

export function shellName(id: string | undefined): string | undefined {
  const { shells, defaultId } = useShells.getState()
  return shells.find((s) => s.id === (id ?? defaultId))?.name
}
