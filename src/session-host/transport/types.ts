import type { ConnectionPhase, PromptRequest } from '@shared/stream-protocol'

export interface TransportExit {
  code: number | null
  signal: number | null
  /** Lý do khi kết nối bị ngắt bất thường (mất mạng, keepalive...). */
  error?: string
}

/** Một nguồn terminal: PTY local hoặc kênh shell SSH. */
export interface Transport {
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  close(): void
}

export interface TransportCallbacks {
  onData(data: Uint8Array): void
  onExit(exit: TransportExit): void
}

export interface PromptReply {
  ok: boolean
  answers: string[]
}

/** Những gì transport cần từ session (UI) và từ main (known_hosts). */
export interface TransportContext {
  status(phase: ConnectionPhase, detail: string): void
  prompt(request: PromptRequest): Promise<PromptReply>
  /** Kiểm tra host key với known_hosts; hỏi người dùng khi cần. true = tin. */
  verifyHostKey(host: string, port: number, key: Buffer): Promise<boolean>
  log(level: 'info' | 'warn' | 'error', message: string): void
}
