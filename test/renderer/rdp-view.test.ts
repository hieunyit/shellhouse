import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RdpViewPrepare, RdpViewProbeResult } from '@shared/rdp-viewer'

/**
 * Trình xem Remote Desktop trong tab (rdp/controller): luồng chuẩn bị → chứng chỉ (TOFU) → đăng
 * nhập → IronRDP; lỗi sai mật khẩu hỏi lại; bảng phím, kích thước desktop, data URL của WASM.
 */

const calls: string[] = []
let prepare: RdpViewPrepare
let probe: RdpViewProbeResult
let connectResult: () => Promise<unknown>
const saved: [string, string][] = []
const pasted: string[] = []

const fakeSession = {
  run: () => new Promise(() => undefined),
  desktopSize: () => ({ width: 1280, height: 720 }),
  applyInputs: () => undefined,
  releaseAllInputs: () => undefined,
  synchronizeLockKeys: () => undefined,
  shutdown: () => {
    calls.push('shutdown')
  },
  onClipboardPaste: (data: { text?: string }) => {
    pasted.push(data.text ?? '')
    return Promise.resolve()
  },
  resize: () => undefined
}

/** SessionBuilder giả: mọi hàm cấu hình ghi lại giá trị và trả chính nó (chuỗi gọi). */
function makeBuilder(): object {
  const opts: Record<string, unknown> = {}
  const proxy: object = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'connect')
          return () => {
            calls.push(`connect ${String(opts['username'])}/${String(opts['password'])}`)
            return connectResult()
          }
        return (value: unknown) => {
          opts[prop] = value
          return proxy
        }
      }
    }
  )
  return proxy
}
// `new SessionBuilder()` — hàm trả object dùng được với new.
const Builder = makeBuilder as unknown as new () => object

vi.mock('../../src/renderer/src/rdp/ironrdp', () => ({
  loadIronRdp: () =>
    Promise.resolve({
      Backend: {
        SessionBuilder: Builder,
        DesktopSize: class {
          constructor(
            readonly width: number,
            readonly height: number
          ) {}
        },
        InputTransaction: class {
          addEvent(): void {}
        },
        DeviceEvent: {
          keyPressed: (c: number) => ({ c }),
          keyReleased: (c: number) => ({ c })
        },
        ClipboardData: class {
          text?: string
          addText(_m: string, text: string): void {
            this.text = text
          }
        }
      },
      displayControl: () => ({})
    })
}))

function element(): HTMLElement & HTMLCanvasElement {
  return {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    focus: () => undefined,
    style: {},
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 })
  } as unknown as HTMLElement & HTMLCanvasElement
}

beforeEach(() => {
  calls.length = 0
  saved.length = 0
  pasted.length = 0
  prepare = {
    ok: true,
    label: 'win',
    address: 'win.corp:3389',
    username: '',
    domain: 'CORP',
    hasPassword: false,
    via: null,
    clipboard: true,
    dynamicResolution: true,
    width: 1920,
    height: 1080
  }
  probe = {
    cert: {
      fingerprint: Array(32).fill('AB').join(':'),
      subject: 'CN=win',
      issuer: 'CN=win',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
      selfSigned: true
    },
    status: 'unknown',
    known: null
  }
  connectResult = () => Promise.resolve(fakeSession)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => {
      clearTimeout(id)
    },
    devicePixelRatio: 1,
    shellhouse: {
      rdpViewPrepare: () => Promise.resolve(prepare),
      rdpViewProbe: () => {
        calls.push('probe')
        return Promise.resolve(probe)
      },
      rdpViewTrust: (_id: string, fp: string) => {
        calls.push(`trust ${fp.slice(0, 5)}`)
        return Promise.resolve()
      },
      rdpViewOpen: (req: { username?: string; password?: string; domain?: string }) => {
        calls.push(`open ${req.username ?? '-'} ${req.domain ?? '-'}`)
        return Promise.resolve({
          proxyAddress: 'ws://127.0.0.1:1/rdcleanpath',
          authToken: 'tok',
          destination: 'win.corp:3389',
          username: req.username ?? 'saved',
          domain: req.domain ?? 'CORP',
          password: req.password ?? 'stored'
        })
      },
      setHostPassword: (id: string, pw: string) => {
        saved.push([id, pw])
        return Promise.resolve({ ok: true, id })
      },
      readClipboard: () => Promise.resolve('local text'),
      writeClipboard: () => Promise.resolve()
    }
  })
})

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('RdpController', () => {
  it('chứng chỉ lần đầu → tin → đăng nhập → kết nối, lưu mật khẩu khi thành công', async () => {
    const { RdpController } = await import('../../src/renderer/src/rdp/controller')
    const c = new RdpController('h1', 'win')
    c.attach(element(), element())
    c.start()
    await settle()
    expect(c.getState().phase).toBe('certificate')
    c.answerCertificate(true)
    await settle()
    expect(calls).toContain('trust AB:AB')
    expect(c.getState().phase).toBe('credentials')
    expect(c.getState().credentials?.askUsername).toBe(true)
    c.submitCredentials({ username: 'bob', domain: 'CORP', password: 'pw', save: true })
    await settle()
    expect(calls).toContain('open bob CORP')
    expect(calls).toContain('connect bob/pw')
    expect(c.getState().phase).toBe('connected')
    expect(c.getState().desktop).toEqual({ width: 1280, height: 720 })
    expect(saved).toEqual([['h1', 'pw']])
    // Gửi clipboard thủ công.
    expect(await c.pushClipboard(true)).toBe(true)
    expect(pasted).toEqual(['local text'])
    c.dispose()
    expect(calls).toContain('shutdown')
  })

  it('không tin chứng chỉ → dừng, không mở proxy', async () => {
    const { RdpController } = await import('../../src/renderer/src/rdp/controller')
    const c = new RdpController('h1', 'win')
    c.attach(element(), element())
    c.start()
    await settle()
    c.answerCertificate(false)
    await settle()
    expect(c.getState().phase).toBe('disconnected')
    expect(calls.some((x) => x.startsWith('open'))).toBe(false)
  })

  it('sai mật khẩu → hỏi lại kèm lỗi; mật khẩu đã lưu thì không hỏi', async () => {
    const { RdpController } = await import('../../src/renderer/src/rdp/controller')
    prepare = { ...prepare, username: 'alice', hasPassword: true } as RdpViewPrepare
    probe = { ...probe, status: 'trusted' }
    let first = true
    connectResult = () => {
      if (first) {
        first = false
        return Promise.reject(
          Object.assign(new Error('wrong'), { kind: () => 1, backtrace: () => 'wrong password' })
        )
      }
      return Promise.resolve(fakeSession)
    }
    const c = new RdpController('h1', 'win')
    c.attach(element(), element())
    c.start()
    await settle()
    expect(calls).toContain('connect saved/stored')
    expect(c.getState().phase).toBe('credentials')
    expect(c.getState().credentials?.error).toMatch(/incorrect/)
    c.submitCredentials({ username: 'alice', domain: '', password: 'right', save: false })
    await settle()
    expect(c.getState().phase).toBe('connected')
    expect(saved).toEqual([])
    c.dispose()
  })

  it('RD Gateway → báo lỗi, gợi ý client ngoài', async () => {
    const { RdpController } = await import('../../src/renderer/src/rdp/controller')
    prepare = { ok: false, message: 'gateway', external: true }
    const c = new RdpController('h1', 'win')
    c.attach(element(), element())
    c.start()
    await settle()
    expect(c.getState().phase).toBe('disconnected')
    expect(c.getState().error).toEqual({ message: 'gateway', external: true })
  })
})

describe('tiện ích', () => {
  it('kích thước desktop chẵn, trong giới hạn', async () => {
    const { desktopSizeFor } = await import('../../src/renderer/src/rdp/controller')
    expect(desktopSizeFor(1001.7, 701)).toEqual({ width: 1000, height: 700 })
    expect(desktopSizeFor(100, 100)).toEqual({ width: 640, height: 480 })
    expect(desktopSizeFor(99999, 99999)).toEqual({ width: 8192, height: 8192 })
  })

  it('bảng scancode', async () => {
    const { scancodeOf } = await import('../../src/renderer/src/rdp/keymap')
    expect(scancodeOf('KeyA')).toBe(0x1e)
    expect(scancodeOf('Delete')).toBe(0xe053)
    expect(scancodeOf('MetaLeft')).toBe(0xe05b)
    expect(scancodeOf('toString')).toBeNull()
    expect(scancodeOf('Unidentified')).toBeNull()
  })

  it('lỗi IronRDP → thông báo', async () => {
    const { describeConnectError } = await import('../../src/renderer/src/rdp/controller')
    const iron = (kind: number, details?: object) => ({
      kind: () => kind,
      backtrace: () => 'detail line\nstack',
      rdcleanpathDetails: () => details
    })
    expect(describeConnectError(iron(2)).kind).toBe('auth')
    expect(describeConnectError(iron(4, { tlsAlertCode: 42 }))).toEqual({ kind: 'certificate' })
    expect(describeConnectError(iron(4, { httpStatusCode: 401 }))).toMatchObject({ kind: 'other' })
    expect(describeConnectError(new Error('boom'))).toEqual({ kind: 'other', message: 'boom' })
  })
})
