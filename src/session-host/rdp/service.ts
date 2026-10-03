import type { Client } from 'ssh2'
import type { RdpViewTarget } from '@shared/rdp-viewer'
import { createDialer } from './dial'
import { PROXY_PATH, RdpProxy } from './proxy'

/** Phần Session Host của trình xem RDP: dò chứng chỉ + cấp token cho proxy RDCleanPath. */
export interface RdpService {
  probe(target: RdpViewTarget): ReturnType<RdpProxy['probe']>
  open(target: RdpViewTarget, pin: string): Promise<{ proxyAddress: string; token: string }>
  close(): void
}

export function createRdpService(deps: {
  /**
   * Kết nối SSH tích hợp của phiên: undefined = không có phiên; null = phiên chưa kết nối xong
   * (chờ tối đa 10 giây).
   */
  sshClient(sessionId: string): Client | null | undefined
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}): RdpService {
  const waitClient = async (sessionId: string): Promise<Client | null> => {
    for (let i = 0; i < 100; i++) {
      const client = deps.sshClient(sessionId)
      if (client) return client
      if (client === undefined) return null
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }
  const proxy = new RdpProxy({ dial: createDialer({ sshClient: waitClient }), log: deps.log })
  return {
    probe: (target) => proxy.probe(target),
    open: async (target, pin) => {
      const { port, token } = await proxy.open(target, pin)
      return { proxyAddress: `ws://127.0.0.1:${port}${PROXY_PATH}`, token }
    },
    close: () => {
      proxy.close()
    }
  }
}
