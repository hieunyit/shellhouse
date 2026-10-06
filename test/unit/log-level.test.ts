import { describe, expect, it } from 'vitest'
import { logLevel, logMatcher, splitMatches } from '../../src/shared/log-level'

describe('mức của dòng log', () => {
  it('error: chữ hoa, logfmt, JSON, klog, zap / logrus, stack trace', () => {
    for (const line of [
      '2026-10-06T10:00:00Z ERROR db: connection refused',
      'time="2026-10-06" level=error msg="boom"',
      '{"ts":1,"level":"error","msg":"x"}',
      '{"severity":"ERROR","message":"x"}',
      'E1006 10:00:00.123456       1 controller.go:42] sync failed',
      '2026-10-06T10:00:00.000Z\terror\tapi/handler.go:12\tfailed',
      '[error] upstream timed out',
      'Traceback (most recent call last):',
      'java.lang.IllegalStateException: bad state',
      '    at com.shop.Api.handle(Api.java:42)',
      'panic: runtime error: index out of range',
      '[shop/web-1/app] FATAL out of memory'
    ])
      expect(logLevel(line), line).toBe('error')
  })

  it('warn: WARN / WARNING, level=warn, JSON, klog', () => {
    for (const line of [
      '10:00:00 WARN cache miss rate high',
      'WARNING: deprecated flag',
      'level=warn msg="slow query"',
      '{"level":"warning","msg":"x"}',
      'W1006 10:00:00.123456       1 reflector.go:1] watch closed',
      '[warn] retrying'
    ])
      expect(logLevel(line), line).toBe('warn')
  })

  it('không đoán bừa: chữ "error" giữa câu, tên chứa ERROR, dòng thường', () => {
    for (const line of [
      'GET /health 200 no error',
      'processed 10 items, errors=0',
      'INFO server started on :8080',
      'ERRORS_TOTAL metric registered',
      'level=info msg="error budget ok"',
      ''
    ])
      expect(logLevel(line), line).toBeNull()
  })
})

describe('tìm trong log', () => {
  it('chuỗi thường: không phân biệt hoa thường, ký tự đặc biệt giữ nguyên văn', () => {
    const m = logMatcher('a.b(', false)
    expect(m.error).toBeNull()
    expect(m.test('xx A.B( yy')).toBe(true)
    expect(m.test('axb(')).toBe(false)
  })

  it('regex: khớp theo biểu thức; sai cú pháp → báo lỗi, không lọc', () => {
    const m = logMatcher('status=(5\\d\\d)', true)
    expect(m.test('GET / status=503')).toBe(true)
    expect(m.test('GET / status=200')).toBe(false)
    const bad = logMatcher('([', true)
    expect(bad.error).not.toBeNull()
    expect(bad.test('anything')).toBe(true)
  })

  it('tô sáng: cắt dòng thành đoạn khớp / không khớp', () => {
    const { highlight } = logMatcher('err', false)
    expect(splitMatches('an ERR and err', highlight ?? /x/g)).toEqual([
      { text: 'an ', match: false },
      { text: 'ERR', match: true },
      { text: ' and ', match: false },
      { text: 'err', match: true }
    ])
    // Regex khớp chuỗi rỗng không treo.
    expect(splitMatches('abc', /x*/g)).toEqual([{ text: 'abc', match: false }])
  })
})
