import { describe, expect, it } from 'vitest'
import {
  ClientInfoRewriter,
  INFO_AUTOLOGON,
  INFO_UNICODE,
  findClientInfo,
  patchClientInfo
} from '../../src/session-host/rdp/client-info'
import { RDP_PERF, performanceFlagsFor } from '../../src/shared/rdp-viewer'
import { clientInfoPdu as clientInfo } from '../integration/rdp-fake-server'

describe('Client Info PDU', () => {
  it('tìm cờ, mật khẩu, cờ hiệu năng', () => {
    const f = findClientInfo(clientInfo({ password: 'pw', perf: 0x86 }))
    expect(f).toMatchObject({ hasPassword: true, performanceFlags: 0x86 })
    expect(f?.flags).toBe(INFO_UNICODE | 0x0100)
    expect(findClientInfo(clientInfo({ extended: false }))).toMatchObject({
      hasPassword: false,
      performanceAt: null
    })
  })

  it('sửa tại chỗ, không đổi độ dài, không đụng phần còn lại', () => {
    const before = clientInfo({ password: 'pw', perf: 0x86 })
    const after = patchClientInfo(before, {
      performanceFlags: performanceFlagsFor('balanced'),
      autologon: true
    })
    expect(after).not.toBeNull()
    expect(after?.length).toBe(before.length)
    const f = findClientInfo(after ?? Buffer.alloc(0))
    expect(f?.performanceFlags).toBe(performanceFlagsFor('balanced'))
    expect((f?.flags ?? 0) & INFO_AUTOLOGON).toBe(INFO_AUTOLOGON)
    // Chỉ đúng 2 trường đổi.
    let diff = 0
    for (let i = 0; i < before.length; i++) if (before[i] !== after?.[i]) diff++
    expect(diff).toBeLessThanOrEqual(8)
    // Bản gốc không bị sửa.
    expect(findClientInfo(before)?.performanceFlags).toBe(0x86)
  })

  it('không có mật khẩu (NLA) → không bật autologon', () => {
    const out = patchClientInfo(clientInfo({ perf: 0 }), { performanceFlags: 1, autologon: true })
    expect((findClientInfo(out ?? Buffer.alloc(0))?.flags ?? 0) & INFO_AUTOLOGON).toBe(0)
  })

  it('độ dài PER 2 byte', () => {
    expect(
      findClientInfo(clientInfo({ password: 'x'.repeat(100), longLength: true }))
    ).not.toBeNull()
  })

  it('không phải Client Info → null; bộ lọc chỉ sửa PDU đầu tiên tìm thấy', () => {
    expect(findClientInfo(Buffer.from([0x30, 0x82, 0x01, 0x00]))).toBeNull()
    expect(findClientInfo(Buffer.from([3, 0, 0, 8, 2, 0xf0, 0x80, 0x68]))).toBeNull()
    const truncated = clientInfo().subarray(0, 40)
    expect(findClientInfo(truncated)).toBeNull()
    const r = new ClientInfoRewriter({
      performanceFlags: RDP_PERF.DISABLE_WALLPAPER,
      autologon: false
    })
    const other = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x06])
    expect(r.process(other)).toBe(other)
    const patched = r.process(clientInfo({ perf: 0x80 }))
    expect(findClientInfo(patched)?.performanceFlags).toBe(RDP_PERF.DISABLE_WALLPAPER)
    expect(r.done).toBe(true)
    const again = clientInfo({ perf: 0x80 })
    expect(r.process(again)).toBe(again)
  })

  it('mức hiệu ứng → cờ hiệu năng', () => {
    expect(performanceFlagsFor('performance') & RDP_PERF.DISABLE_FULLWINDOWDRAG).toBeTruthy()
    expect(performanceFlagsFor('performance') & RDP_PERF.ENABLE_FONT_SMOOTHING).toBe(0)
    expect(performanceFlagsFor('balanced') & RDP_PERF.DISABLE_WALLPAPER).toBeTruthy()
    expect(performanceFlagsFor('balanced') & RDP_PERF.ENABLE_FONT_SMOOTHING).toBeTruthy()
    expect(performanceFlagsFor('balanced') & RDP_PERF.DISABLE_FULLWINDOWDRAG).toBe(0)
    expect(performanceFlagsFor('quality') & RDP_PERF.DISABLE_WALLPAPER).toBe(0)
  })
})
