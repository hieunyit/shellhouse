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

const panicListeners = new Set<(message: string) => void>()

/**
 * Báo khi phần Rust của IronRDP panic (hook panic của WASM in ra console.error "panicked at …").
 * Sau panic, vòng xử lý của phiên đứng im — màn hình đóng băng trong khi vẫn "đã kết nối".
 */
export function onIronRdpPanic(listener: (message: string) => void): () => void {
  panicListeners.add(listener)
  return () => {
    panicListeners.delete(listener)
  }
}

let consoleHooked = false

function hookPanics(): void {
  if (consoleHooked) return
  consoleHooked = true
  // Hook panic của WASM chỉ in ra console.error — bọc lại để nghe (vẫn in như cũ).
  // eslint-disable-next-line no-console -- bọc chính console.error
  const original = console.error.bind(console)
  // eslint-disable-next-line no-console -- bọc chính console.error
  console.error = (...args: unknown[]) => {
    original(...args)
    const first = args[0]
    if (typeof first === 'string' && first.startsWith('panicked at '))
      for (const listener of panicListeners) listener(first.split('\n')[0] ?? first)
  }
}

async function load(): Promise<IronRdpModule> {
  hookPanics()
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
