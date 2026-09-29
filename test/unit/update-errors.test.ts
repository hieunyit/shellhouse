import { describe, expect, it } from 'vitest'
import { describeUpdateError } from '../../src/node-shared/update-errors'

const withCode = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code })

describe('describeUpdateError', () => {
  it('release chưa publish (file kênh 404) → "không có bản mới", không báo lỗi', () => {
    const e = withCode(
      'Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/download/v1.0.0-beta.1/latest.yml): HttpError: 404 …',
      'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    )
    expect(describeUpdateError(e)).toEqual({ kind: 'none' })
    expect(describeUpdateError(new Error('No published versions on GitHub'))).toEqual({
      kind: 'none'
    })
  })
  it('mất mạng → câu ngắn dễ hiểu', () => {
    expect(describeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toEqual({
      kind: 'error',
      message: 'Could not reach the update server. Check your connection.'
    })
  })
  it('lỗi khác: chỉ dòng đầu, cắt ngắn (không lộ header/stack)', () => {
    const r = describeUpdateError(new Error(`${'x'.repeat(300)}\nHeaders: { … }`))
    expect(r.kind).toBe('error')
    if (r.kind === 'error') {
      expect(r.message.length).toBeLessThanOrEqual(160)
      expect(r.message).not.toContain('Headers')
    }
  })
})
