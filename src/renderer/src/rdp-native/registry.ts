import type { NativeRdpController } from './controller'

/** Phiên RDP (control gốc Windows) của các tab đang mở, theo tabId (menu tab "Reconnect"…). */
export const nativeRdpControllers = new Map<string, NativeRdpController>()
