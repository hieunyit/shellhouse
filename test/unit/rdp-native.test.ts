import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RDP, type RdpSettings } from '@shared/rdp'
import {
  chooseRdpEngine,
  clampRect,
  desktopSizeFor,
  disconnectIsError,
  scaleFactorsFor,
  toPhysical,
  type RdpNativeEvent,
  type RdpNativeViewport
} from '@shared/rdp-native'
import type { ResolvedRdp } from '../../src/main/hosts/service'
import {
  buildConnect,
  RdpNativeController,
  sessionEventOf
} from '../../src/main/rdp-native/controller'
import { helperCandidates, hwndOf } from '../../src/main/rdp-native/locate'
import {
  describeCommand,
  encodeCommand,
  LineDecoder,
  parseEvent,
  physicalHoles,
  type HelperCommand
} from '../../src/main/rdp-native/protocol'

afterEach(() => {
  vi.useRealTimers()
})

describe('rdp-native: chọn engine', () => {
  it('Windows + có tiến trình phụ → native; host chọn IronRDP / nơi khác → IronRDP', () => {
    const base = { platform: 'win32', nativeAvailable: true }
    expect(chooseRdpEngine({ ...base, engine: undefined })).toBe('native')
    expect(chooseRdpEngine({ ...base, engine: 'auto' })).toBe('native')
    expect(chooseRdpEngine({ ...base, engine: 'native' })).toBe('native')
    expect(chooseRdpEngine({ ...base, engine: 'ironrdp' })).toBe('ironrdp')
    expect(chooseRdpEngine({ ...base, nativeAvailable: false, engine: 'native' })).toBe('ironrdp')
    expect(chooseRdpEngine({ platform: 'linux', nativeAvailable: true, engine: 'native' })).toBe(
      'ironrdp'
    )
    expect(chooseRdpEngine({ platform: 'darwin', nativeAvailable: false, engine: 'auto' })).toBe(
      'ironrdp'
    )
    // "Open in IronRDP" trên tab thắng mọi thứ.
    expect(chooseRdpEngine({ ...base, engine: 'native', override: 'ironrdp' })).toBe('ironrdp')
  })
})

describe('rdp-native: toạ độ', () => {
  it('CSS px × devicePixelRatio, làm tròn theo cạnh (không hở 1 px ở 125 % / 150 %)', () => {
    expect(toPhysical({ x: 10, y: 20, width: 100, height: 50 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50
    })
    expect(toPhysical({ x: 0.5, y: 44.4, width: 801.2, height: 600.6 }, 1.25)).toEqual({
      x: 1,
      y: 56,
      width: 1001,
      height: 750
    })
    // Hai vùng kề nhau (chia đôi màn hình) không chồng / hở.
    const left = toPhysical({ x: 0, y: 0, width: 333.3, height: 10 }, 1.5)
    const right = toPhysical({ x: 333.3, y: 0, width: 333.3, height: 10 }, 1.5)
    expect(left.x + left.width).toBe(right.x)
    // Zoom trang 110 % trên màn 150 %: dpr 1.65.
    expect(toPhysical({ x: 100, y: 100, width: 200, height: 100 }, 1.65)).toEqual({
      x: 165,
      y: 165,
      width: 330,
      height: 165
    })
  })

  it('cắt vào vùng web của cửa sổ', () => {
    expect(clampRect({ x: -10, y: 5, width: 100, height: 100 }, { width: 50, height: 60 })).toEqual(
      { x: 0, y: 5, width: 50, height: 55 }
    )
    expect(clampRect({ x: 80, y: 80, width: 10, height: 10 }, { width: 50, height: 60 })).toEqual({
      x: 50,
      y: 60,
      width: 0,
      height: 0
    })
  })

  it('cỡ desktop: rộng chẵn, 200…8192; hệ số scale theo DPI hoặc host', () => {
    expect(desktopSizeFor(1001.7, 655)).toEqual({ width: 1000, height: 655 })
    expect(desktopSizeFor(10, 10)).toEqual({ width: 200, height: 200 })
    expect(desktopSizeFor(9000, 9000)).toEqual({ width: 8192, height: 8192 })
    expect(scaleFactorsFor(1, null)).toEqual({ desktopScale: 100, deviceScale: 100 })
    expect(scaleFactorsFor(1.25, null)).toEqual({ desktopScale: 125, deviceScale: 100 })
    expect(scaleFactorsFor(1.5, null)).toEqual({ desktopScale: 150, deviceScale: 140 })
    expect(scaleFactorsFor(1.65, null)).toEqual({ desktopScale: 175, deviceScale: 140 })
    expect(scaleFactorsFor(2, null)).toEqual({ desktopScale: 200, deviceScale: 180 })
    expect(scaleFactorsFor(2, 100)).toEqual({ desktopScale: 100, deviceScale: 100 })
    expect(scaleFactorsFor(0.5, null)).toEqual({ desktopScale: 100, deviceScale: 100 })
  })

  it('lỗ của lớp phủ → pixel vật lý trong cửa sổ native, cắt vào khung', () => {
    expect(
      physicalHoles(
        [
          { x: 10, y: 10, width: 20, height: 20 },
          { x: -5, y: 90, width: 50, height: 50 },
          { x: 500, y: 500, width: 10, height: 10 }
        ],
        1.5,
        { width: 150, height: 150 }
      )
    ).toEqual([
      { x: 15, y: 15, width: 30, height: 30 },
      { x: 0, y: 135, width: 68, height: 15 }
    ])
  })

  it('HWND từ Buffer của getNativeWindowHandle', () => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(0x1234abcdn)
    expect(hwndOf(b)).toBe(String(0x1234abcd))
    const small = Buffer.alloc(4)
    small.writeUInt32LE(77)
    expect(hwndOf(small)).toBe('77')
  })

  it('đường dẫn tiến trình phụ: bản cài → resources; dev → build output (+ biến môi trường)', () => {
    expect(
      helperCandidates({ packaged: true, resourcesPath: 'R', appPath: 'A', override: 'X' })
    ).toEqual([join('R', 'rdp-host', 'shellhouse-rdp-host.exe')])
    expect(
      helperCandidates({ packaged: false, resourcesPath: 'R', appPath: 'A', override: 'X' })
    ).toEqual(['X', join('A', 'native', 'rdp-host-win', 'bin', 'shellhouse-rdp-host.exe')])
  })
})

describe('rdp-native: giao thức', () => {
  const connect = buildConnect({
    server: 'win.corp',
    port: 3389,
    username: 'john',
    domain: 'CORP',
    password: 'S3cr3t!pw',
    settings: { ...DEFAULT_RDP, gateway: 'gw.corp:443', audio: false, scale: null },
    physical: { width: 1501, height: 900 },
    dpr: 1.5
  })

  it('lệnh connect theo cài đặt host + vùng tab', () => {
    expect(connect).toMatchObject({
      type: 'connect',
      server: 'win.corp',
      port: 3389,
      username: 'john',
      domain: 'CORP',
      gateway: 'gw.corp:443',
      width: 1500,
      height: 900,
      desktopScale: 150,
      deviceScale: 140,
      smartSizing: false,
      clipboard: true,
      audioMode: 2,
      enableCredSsp: true,
      authenticationLevel: 2
    })
    // Không co theo cửa sổ → cỡ cố định của host, hình co giãn.
    const fixed = buildConnect({
      server: 'h',
      port: 1,
      username: 'u',
      domain: '',
      password: 'p',
      settings: { ...DEFAULT_RDP, dynamicResolution: false, width: 1280, height: 720, scale: 125 },
      physical: { width: 500, height: 300 },
      dpr: 2
    })
    expect(fixed).toMatchObject({ width: 1280, height: 720, smartSizing: true, desktopScale: 125 })
  })

  it('mã hoá một dòng JSON; mô tả để ghi log không bao giờ có mật khẩu', () => {
    const line = encodeCommand(connect)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line)).toMatchObject({ password: 'S3cr3t!pw' })
    const commands: HelperCommand[] = [
      connect,
      { type: 'bounds', x: 1, y: 2, width: 3, height: 4, visible: true },
      { type: 'region', mode: 'holes', holes: [{ x: 0, y: 0, width: 1, height: 1 }] },
      { type: 'resize', width: 800, height: 600, desktopScale: 100, deviceScale: 100 },
      { type: 'cad' }
    ]
    for (const c of commands) expect(describeCommand(c)).not.toContain('S3cr3t')
    expect(describeCommand(connect)).toContain('(password provided)')
  })

  it('tách dòng qua nhiều chunk, \\r\\n, bỏ dòng quá dài', () => {
    const lines: string[] = []
    const errors: string[] = []
    const d = new LineDecoder(
      (l) => lines.push(l),
      (e) => errors.push(e),
      20
    )
    d.push('{"a":')
    d.push('1}\r\n\n{"b":2}\n{"c"')
    d.push(':3}\n')
    d.push('x'.repeat(30))
    d.push('yyy\n{"d":4}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}'])
    expect(errors).toEqual(['line too long'])
  })

  it('sự kiện: hợp lệ thì nhận, sai kiểu / JSON hỏng thì bỏ', () => {
    expect(parseEvent('{"type":"connected"}')).toEqual({ type: 'connected' })
    expect(
      parseEvent('{"type":"disconnected","reason":516,"extended":0,"message":"no route"}')
    ).toMatchObject({ reason: 516 })
    expect(parseEvent('{"type":"disconnected","reason":"x"}')).toBeNull()
    expect(parseEvent('{"type":"snapshot","id":1,"ok":true,"data":"<script>"}')).toBeNull()
    expect(parseEvent('not json')).toBeNull()
    expect(parseEvent('{"type":"unknown"}')).toBeNull()
  })

  it('sự kiện gửi renderer: lý do ngắt 1/2/3 không phải lỗi', () => {
    expect(disconnectIsError(1)).toBe(false)
    expect(disconnectIsError(3)).toBe(false)
    expect(disconnectIsError(516)).toBe(true)
    expect(
      sessionEventOf({ type: 'disconnected', reason: 2308, extended: 0, message: 'socket closed' })
    ).toEqual({
      type: 'disconnected',
      reason: 2308,
      extended: 0,
      message: 'socket closed',
      error: true
    })
    expect(sessionEventOf({ type: 'fatalError', code: 7 })).toMatchObject({ type: 'fatal' })
    expect(sessionEventOf({ type: 'log', level: 'info', message: 'x' })).toBeNull()
    // Lệnh connect hỏng chặn phiên; lệnh khác lỗi (cad…) thì không.
    expect(sessionEventOf({ type: 'error', message: 'connect: server is invalid' })).toEqual({
      type: 'fatal',
      message: 'Could not start the connection: server is invalid'
    })
    expect(sessionEventOf({ type: 'error', message: 'cad: E_FAIL' })).toBeNull()
  })
})

// ——— Controller với tiến trình phụ giả ———

class FakeHelper extends EventEmitter {
  input = ''
  ended = false
  killed = false
  readonly out = new EventEmitter()
  readonly err = new EventEmitter()
  readonly stdin = {
    write: (d: string) => {
      this.input += d
    },
    end: () => {
      this.ended = true
    },
    on: () => undefined
  }
  readonly stdout = { on: (_e: 'data', l: (c: Buffer) => void) => this.out.on('data', l) }
  readonly stderr = { on: (_e: 'data', l: (c: Buffer) => void) => this.err.on('data', l) }

  commands(): Record<string, unknown>[] {
    return this.input
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }
  reply(event: Record<string, unknown>): void {
    this.out.emit('data', Buffer.from(`${JSON.stringify(event)}\n`))
  }
  kill(): boolean {
    this.killed = true
    this.emit('exit', 1, null)
    return true
  }
}

function resolved(overrides: Partial<ResolvedRdp> = {}, settings: Partial<RdpSettings> = {}) {
  let disposed = false
  const host: ResolvedRdp = {
    label: 'win',
    host: 'win.corp',
    port: 3389,
    username: 'john',
    settings: { ...DEFAULT_RDP, ...settings },
    password: {
      revealString: () => 'S3cr3t!pw',
      dispose: () => {
        disposed = true
      }
    } as unknown as ResolvedRdp['password'],
    via: null,
    ...overrides
  }
  return { host, disposed: () => disposed }
}

const viewport: RdpNativeViewport = {
  x: 0,
  y: 40,
  width: 800,
  height: 600,
  dpr: 1.5,
  visible: true
}

function setup(host = resolved()) {
  const helpers: FakeHelper[] = []
  const spawned: string[][] = []
  const events: RdpNativeEvent[] = []
  const logs: string[] = []
  let focused = 0
  const controller = new RdpNativeController({
    resolve: () => host.host,
    spawn: (args) => {
      spawned.push(args)
      const h = new FakeHelper()
      helpers.push(h)
      queueMicrotask(() => {
        h.reply({
          type: 'ready',
          control: 'MsRdpClient10NotSafeForScripting',
          selftest: false,
          hwnd: '5',
          version: '1'
        })
      })
      return h
    },
    parentHandle: () => '123456',
    contentSize: () => ({ width: 1800, height: 1200 }),
    emit: (e) => events.push(e),
    focusApp: () => {
      focused++
    },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    resizeDelayMs: 50
  })
  return { controller, helpers, spawned, events, logs, focused: () => focused, host }
}

describe('rdp-native: controller', () => {
  it('mở: chạy tiến trình phụ với HWND cha, đặt vị trí, vùng trống, rồi connect', async () => {
    const t = setup()
    const result = await t.controller.open({ hostId: 'h1', viewport })
    expect(result.ok).toBe(true)
    expect(t.spawned).toEqual([['--parent=123456']])
    const cmds = t.helpers[0]?.commands() ?? []
    expect(cmds.map((c) => c['type'])).toEqual(['bounds', 'region', 'connect'])
    expect(cmds[0]).toEqual({
      type: 'bounds',
      x: 0,
      y: 60,
      width: 1200,
      height: 900,
      visible: true
    })
    // Chưa kết nối: không vẽ (vẫn "visible" với Win32 để control kết nối được).
    expect(cmds[1]).toEqual({ type: 'region', mode: 'none' })
    expect(cmds[2]).toMatchObject({
      server: 'win.corp',
      port: 3389,
      username: 'john',
      password: 'S3cr3t!pw',
      width: 1200,
      height: 900,
      desktopScale: 150
    })
    expect(t.host.disposed()).toBe(true)
    // Log không có mật khẩu.
    expect(t.logs.join('\n')).not.toContain('S3cr3t')
  })

  it('kết nối xong → hiện cả vùng; lớp phủ → khoét lỗ / ẩn; đổi cỡ → đổi độ phân giải (debounce)', async () => {
    const t = setup()
    const r = await t.controller.open({ hostId: 'h1', viewport })
    if (!r.ok) throw new Error(r.message)
    const h = t.helpers[0]
    if (!h) throw new Error('no helper')
    h.input = ''
    h.reply({ type: 'connected' })
    expect(t.events).toEqual([{ sessionId: r.sessionId, event: { type: 'connected' } }])
    expect(h.commands()).toEqual([{ type: 'region', mode: 'full' }])

    h.input = ''
    t.controller.overlay(r.sessionId, {
      mode: 'holes',
      holes: [{ x: 10, y: 10, width: 100, height: 40 }]
    })
    expect(h.commands()).toEqual([
      { type: 'region', mode: 'holes', holes: [{ x: 15, y: 15, width: 150, height: 60 }] }
    ])
    h.input = ''
    t.controller.overlay(r.sessionId, { mode: 'hide' })
    t.controller.overlay(r.sessionId, { mode: 'hide' })
    expect(h.commands()).toEqual([{ type: 'region', mode: 'none' }])
    t.controller.overlay(r.sessionId, { mode: 'none' })

    h.input = ''
    vi.useFakeTimers()
    t.controller.bounds(r.sessionId, { ...viewport, width: 700 })
    t.controller.bounds(r.sessionId, { ...viewport, width: 640 })
    expect(h.commands()).toEqual([
      { type: 'bounds', x: 0, y: 60, width: 1050, height: 900, visible: true },
      { type: 'bounds', x: 0, y: 60, width: 960, height: 900, visible: true }
    ])
    h.input = ''
    vi.advanceTimersByTime(60)
    expect(h.commands()).toEqual([
      { type: 'resize', width: 960, height: 900, desktopScale: 150, deviceScale: 140 }
    ])
    // Tab ẩn: ẩn cửa sổ, không đổi độ phân giải.
    h.input = ''
    t.controller.bounds(r.sessionId, { ...viewport, width: 640, visible: false })
    vi.advanceTimersByTime(60)
    expect(h.commands()).toEqual([
      { type: 'bounds', x: 0, y: 60, width: 960, height: 900, visible: false }
    ])
  })

  it('toạ độ renderer gửi bị cắt vào vùng web của cửa sổ', async () => {
    const t = setup()
    const r = await t.controller.open({
      hostId: 'h1',
      viewport: { x: -50, y: 0, width: 5000, height: 5000, dpr: 1, visible: true }
    })
    expect(r.ok).toBe(true)
    expect(t.helpers[0]?.commands()[0]).toEqual({
      type: 'bounds',
      x: 0,
      y: 0,
      width: 1800,
      height: 1200,
      visible: true
    })
  })

  it('tunnel: chỉ nhận cổng khi host đi qua SSH host; khi đó kết nối 127.0.0.1:<cổng>', async () => {
    const direct = setup()
    expect(await direct.controller.open({ hostId: 'h', tunnelPort: 4000, viewport })).toEqual({
      ok: false,
      message: 'This host does not use an SSH tunnel'
    })
    expect(direct.spawned).toHaveLength(0)

    const tunneled = setup(resolved({ via: { id: 'b', label: 'bastion' } }))
    const missing = await tunneled.controller.open({ hostId: 'h', viewport })
    expect(missing.ok).toBe(false)
    const ok = await tunneled.controller.open({ hostId: 'h', tunnelPort: 4000, viewport })
    expect(ok.ok).toBe(true)
    expect(tunneled.helpers[0]?.commands()[2]).toMatchObject({ server: '127.0.0.1', port: 4000 })
  })

  it('mật khẩu: gõ lúc kết nối thắng mật khẩu đã lưu; không có thì báo', async () => {
    const t = setup()
    await t.controller.open({
      hostId: 'h',
      username: 'CORP2\\jane',
      password: 'typed',
      viewport
    })
    expect(t.helpers[0]?.commands()[2]).toMatchObject({
      username: 'jane',
      domain: 'CORP2',
      password: 'typed'
    })
    const none = setup(resolved({ password: null }))
    expect(await none.controller.open({ hostId: 'h', viewport })).toEqual({
      ok: false,
      message: 'Enter the password to connect'
    })
  })

  it('ảnh chụp, focus trả về app, đóng, tiến trình phụ chết → báo lỗi', async () => {
    const t = setup()
    const r = await t.controller.open({ hostId: 'h1', viewport })
    if (!r.ok) throw new Error(r.message)
    const h = t.helpers[0]
    if (!h) throw new Error('no helper')
    expect(await t.controller.snapshot(r.sessionId)).toBeNull() // chưa kết nối
    h.reply({ type: 'connected' })
    const pending = t.controller.snapshot(r.sessionId)
    const req = h.commands().find((c) => c['type'] === 'snapshot')
    h.reply({ type: 'snapshot', id: req?.['id'], ok: true, data: 'AAAA', width: 1, height: 1 })
    expect(await pending).toBe('data:image/jpeg;base64,AAAA')

    h.reply({ type: 'focusReleased', direction: 1 })
    expect(t.focused()).toBe(1)

    h.emit('exit', 3, null)
    expect(t.events.at(-1)).toMatchObject({ sessionId: r.sessionId, event: { type: 'fatal' } })

    const t2 = setup()
    const r2 = await t2.controller.open({ hostId: 'h1', viewport })
    if (!r2.ok) throw new Error(r2.message)
    t2.controller.close(r2.sessionId)
    expect(t2.helpers[0]?.commands().at(-1)).toEqual({ type: 'quit' })
    expect(t2.helpers[0]?.ended).toBe(true)
    // Thoát sau khi đóng: không báo lỗi.
    t2.helpers[0]?.emit('exit', 0, null)
    expect(t2.events).toHaveLength(0)
  })

  it('tiến trình phụ không lên (control không tạo được) → lỗi kèm stderr', async () => {
    const t = setup()
    const controller = new RdpNativeController({
      resolve: () => t.host.host,
      spawn: () => {
        const h = new FakeHelper()
        queueMicrotask(() => {
          h.err.emit('data', Buffer.from('could not create the Remote Desktop control: x\n'))
          h.emit('exit', 3, null)
        })
        return h
      },
      parentHandle: () => '1',
      contentSize: () => null,
      emit: () => undefined,
      focusApp: () => undefined,
      log: { info: () => undefined, warn: () => undefined }
    })
    const r = await controller.open({ hostId: 'h', viewport })
    expect(r).toEqual({
      ok: false,
      message:
        'Could not start the Remote Desktop helper: could not create the Remote Desktop control: x'
    })
  })
})
