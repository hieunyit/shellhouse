import type { ShellhouseApi } from '../shared/ipc'

declare global {
  interface Window {
    shellhouse: ShellhouseApi
  }
}

export {}
