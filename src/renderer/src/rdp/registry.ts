import type { RdpController } from './controller'

/** Phiên Remote Desktop của các tab đang mở, theo tabId (menu tab "Reconnect", phím tắt…). */
export const rdpControllers = new Map<string, RdpController>()
