import type { TerminalController } from './controller'

/** Controller của các tab đang mở, theo tabId. */
export const controllers = new Map<string, TerminalController>()
