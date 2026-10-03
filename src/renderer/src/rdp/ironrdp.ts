/**
 * Nạp backend RDP của IronRDP (WASM, ~6 MB — chỉ nạp khi mở tab Remote Desktop đầu tiên).
 *
 * Gói nhúng file .wasm dưới dạng data: URL và tự `fetch()` nó. CSP của app không cho fetch data:
 * (connect-src chỉ 'self' + ws://127.0.0.1) → trong lúc khởi tạo, thay tạm `fetch` để giải data URL
 * đúng loại application/wasm ngay tại chỗ (không mở rộng CSP). WASM cần 'wasm-unsafe-eval'.
 */
import type * as IronRdp from '@devolutions/iron-remote-desktop-rdp'

export type IronRdpModule = typeof IronRdp

let loading: Promise<IronRdpModule> | null = null

const WASM_DATA_URL = 'data:application/wasm;base64,'

/** Giải data:application/wasm;base64,… thành Response (null = không phải URL đó). */
export function wasmDataResponse(input: unknown): Response | null {
  if (typeof input !== 'string' || !input.startsWith(WASM_DATA_URL)) return null
  const binary = atob(input.slice(WASM_DATA_URL.length))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } })
}

async function load(): Promise<IronRdpModule> {
  const mod = await import('@devolutions/iron-remote-desktop-rdp')
  // Giữ đúng hàm gốc để trả lại nguyên vẹn sau khi khởi tạo.
  const original = Reflect.get(window, 'fetch')
  const passthrough = original.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const local = wasmDataResponse(input)
    return local ? Promise.resolve(local) : passthrough(input, init)
  }
  try {
    await mod.init(import.meta.env.DEV ? 'INFO' : 'WARN')
  } finally {
    window.fetch = original
  }
  return mod
}

export function loadIronRdp(): Promise<IronRdpModule> {
  loading ??= load().catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}
