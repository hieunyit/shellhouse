import { describe, expect, it } from 'vitest'
import { looksLikeSelector, matchesSelector, parseSelector } from '../../shared/selector'

/** Label selector kiểu kubectl -l trong ô lọc Pods. */
describe('k8s: label selector', () => {
  const web = { app: 'web', tier: 'front' }
  const api = { app: 'api', tier: 'data', canary: 'true' }

  it('nhận ra selector; chữ thường vẫn là tìm theo tên', () => {
    expect(looksLikeSelector('app=web')).toBe(true)
    expect(looksLikeSelector('app in (web,api)')).toBe(true)
    expect(looksLikeSelector('!canary')).toBe(true)
    expect(looksLikeSelector('-l canary')).toBe(true)
    expect(looksLikeSelector('web-1')).toBe(false)
  })

  it('=, !=, in, notin, tồn tại / không tồn tại, nối bằng dấu phẩy', () => {
    const match = (s: string, labels: Record<string, string>): boolean => {
      const p = parseSelector(s)
      if (!p.ok) throw new Error(p.error)
      return matchesSelector(labels, p.requirements)
    }
    expect(match('app=web', web)).toBe(true)
    expect(match('app==web', api)).toBe(false)
    expect(match('tier!=data', web)).toBe(true)
    expect(match('tier!=data', api)).toBe(false)
    expect(match('app in (web, api)', api)).toBe(true)
    expect(match('app notin (web)', api)).toBe(true)
    expect(match('-l canary', api)).toBe(true)
    expect(match('!canary', api)).toBe(false)
    expect(match('app in (web,api),!canary', web)).toBe(true)
    expect(match('app in (web,api),!canary', api)).toBe(false)
  })

  it('cú pháp sai → thông báo cụ thể; chuẩn hoá cho kubectl', () => {
    expect(parseSelector('app in (web')).toEqual({ ok: false, error: 'Unbalanced parentheses' })
    const bad = parseSelector('app=we b')
    expect(bad.ok).toBe(false)
    const ok = parseSelector('-l app = web , tier in (a,b)')
    expect(ok.ok && ok.text).toBe('app=web,tier in (a,b)')
  })
})
