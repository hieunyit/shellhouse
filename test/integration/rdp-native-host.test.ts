import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RdpHelper } from '../../src/main/rdp-native/helper'
import type { HelperEvent } from '../../src/main/rdp-native/protocol'

/**
 * Tiến trình phụ thật (native/rdp-host-win) với control RDP thật của Windows. Chỉ chạy khi có file
 * exe: CI Windows build trước (`node scripts/build-rdp-host.mjs --require`); trên WSL có thể trỏ
 * SHELLHOUSE_RDP_HOST_EXE vào exe đã build (chạy qua interop của WSL).
 *
 * Kết nối RDP thật tới chính máy (127.0.0.2) chỉ chạy khi có SHELLHOUSE_RDP_LOOPBACK_USER /
 * SHELLHOUSE_RDP_LOOPBACK_PASSWORD (job tuỳ chọn của CI bật Remote Desktop + tạo user tạm).
 */
const exe =
  process.env['SHELLHOUSE_RDP_HOST_EXE'] ??
  join(__dirname, '../../native/rdp-host-win/bin/shellhouse-rdp-host.exe')
const runnable =
  existsSync(exe) && (process.platform === 'win32' || !!process.env['SHELLHOUSE_RDP_HOST_EXE'])

function start(args: string[]) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const events: HelperEvent[] = []
  const waiters: { type: string; resolve: (e: HelperEvent) => void }[] = []
  let exitCode: number | null | undefined
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      exitCode = code
      resolve(code)
    })
  })
  const helper = new RdpHelper(
    child,
    {
      event: (e) => {
        events.push(e)
        for (const w of [...waiters])
          if (w.type === e.type) {
            waiters.splice(waiters.indexOf(w), 1)
            w.resolve(e)
          }
      },
      exit: () => undefined
    },
    { info: () => undefined, warn: () => undefined }
  )
  /** Sự kiện `type` đầu tiên từ vị trí `after` (mặc định: từ đầu). */
  const next = (type: string, timeoutMs: number, after = 0): Promise<HelperEvent> => {
    const seen = events.slice(after).find((e) => e.type === type)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timeout waiting for ${type}; got ${events.map((e) => e.type).join(',')}`))
      }, timeoutMs)
      waiters.push({
        type,
        resolve: (e) => {
          clearTimeout(timer)
          resolve(e)
        }
      })
    })
  }
  return { child, helper, events, next, exited, exitCode: () => exitCode }
}

const connect = (server: string, port: number, username = 'nobody', password = 'x', domain = '') =>
  ({
    type: 'connect',
    server,
    port,
    username,
    domain,
    password,
    gateway: null,
    width: 1024,
    height: 768,
    desktopScale: 100,
    deviceScale: 100,
    colorDepth: 32,
    smartSizing: false,
    clipboard: false,
    drives: false,
    printers: false,
    audioMode: 2,
    keyboardHookMode: 0,
    authenticationLevel: 0,
    enableCredSsp: true
  }) as const

describe.skipIf(!runnable)('shellhouse-rdp-host.exe (Windows)', () => {
  it('--probe: typelib của mstscax khớp GUID / DISPID đã khai báo, tạo được control', () => {
    const r = spawnSync(exe, ['--probe'], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    const line = r.stdout.trim().split('\n').pop() ?? '{}'
    const report = JSON.parse(line) as {
      ok: boolean
      created: string | null
      dispids: { name: string; match: boolean }[]
    }
    expect(report, line).toMatchObject({ ok: true })
    expect(report.created).toMatch(/^MsRdpClient\d+NotSafeForScripting$/)
    expect(report.dispids.every((d) => d.match)).toBe(true)
    expect(r.status).toBe(0)
  }, 90_000)

  it('control thật: tạo cửa sổ, kết nối tới cổng đóng → connecting rồi disconnected có lý do', async () => {
    const h = start([])
    const ready = await h.helper.ready
    expect(ready.selftest).toBe(false)
    expect(ready.control).toMatch(/^MsRdpClient\d+NotSafeForScripting$/)
    expect(Number(ready.hwnd)).toBeGreaterThan(0)
    // Ngoài màn hình: không che máy chạy test.
    h.helper.send({ type: 'bounds', x: -32000, y: -32000, width: 1024, height: 768, visible: true })
    const state = await h.helper.request('query', 10_000)
    expect(state).toMatchObject({ type: 'state', hwnd: ready.hwnd, width: 1024, height: 768 })
    // 127.0.0.1 bị control chặn (kết nối vào chính máy) — 127.0.0.2 thì không; cổng 1 đóng.
    h.helper.send(connect('127.0.0.2', 1))
    await h.next('connecting', 15_000)
    const disconnected = await h.next('disconnected', 90_000)
    expect(disconnected).toMatchObject({ type: 'disconnected' })
    if (disconnected.type === 'disconnected') {
      expect(disconnected.reason).toBeGreaterThan(3)
      expect(disconnected.message.length).toBeGreaterThan(0)
    }
    h.helper.close()
    expect(await h.exited).toBe(0)
  }, 150_000)

  it('--selftest: sự kiện giả, ảnh chụp, lệnh sai bị từ chối, stdin đóng → thoát', async () => {
    const h = start(['--selftest'])
    await h.helper.ready
    h.helper.send({ type: 'bounds', x: -32000, y: -32000, width: 320, height: 200, visible: true })
    h.helper.send({ ...connect('127.0.0.2', 3389), password: 'never-logged' })
    await h.next('connected', 10_000)
    h.helper.send({ type: 'region', mode: 'full' })
    const snap = await h.helper.request('snapshot', 10_000)
    expect(snap).toMatchObject({ type: 'snapshot', ok: true, width: 320, height: 200 })
    h.child.stdin.write('{"type":"connect","server":"-x","port":1}\n')
    const error = await h.next('error', 10_000)
    expect(error).toMatchObject({ message: 'connect: server is invalid' })
    const state = await h.helper.request('query', 10_000)
    expect(state).toMatchObject({ type: 'state', region: 'full', connected: true })
    // Không sự kiện nào lặp lại mật khẩu.
    expect(JSON.stringify(h.events)).not.toContain('never-logged')
    h.child.stdin.end()
    expect(await h.exited).toBe(0)
  }, 60_000)

  const user = process.env['SHELLHOUSE_RDP_LOOPBACK_USER']
  const password = process.env['SHELLHOUSE_RDP_LOOPBACK_PASSWORD']
  it.skipIf(!user || !password)(
    'RDP thật tới chính máy (127.0.0.2:3389): đăng nhập xong, đổi độ phân giải, ngắt',
    async () => {
      const h = start([])
      await h.helper.ready
      h.helper.send({ type: 'bounds', x: 0, y: 0, width: 1024, height: 768, visible: true })
      h.helper.send({ type: 'region', mode: 'full' })
      h.helper.send(
        connect('127.0.0.2', 3389, user, password, process.env['SHELLHOUSE_RDP_LOOPBACK_DOMAIN'])
      )
      await h.next('connected', 60_000)
      await h.next('loginComplete', 90_000)
      const mark = h.events.length
      h.helper.send({
        type: 'resize',
        width: 1280,
        height: 720,
        desktopScale: 100,
        deviceScale: 100
      })
      expect(await h.next('desktopSize', 30_000, mark)).toMatchObject({ width: 1280, height: 720 })
      h.helper.send({ type: 'disconnect' })
      const d = await h.next('disconnected', 30_000)
      expect(d).toMatchObject({ reason: 1 })
      h.helper.close()
      await h.exited
    },
    240_000
  )
})
