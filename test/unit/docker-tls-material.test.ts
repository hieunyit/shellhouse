import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkTlsMaterial } from '../../src/modules/docker/main/tls-material'

const F = join(__dirname, '../../src/modules/docker/test/fixtures')
const pem = (name: string): string => readFileSync(join(F, name), 'utf8')

describe('checkTlsMaterial — chứng chỉ của engine TCP + TLS', () => {
  it('CA + chứng chỉ client + khoá khớp → hợp lệ, trả hạn và chủ thể', () => {
    const info = checkTlsMaterial({
      ca: pem('ca.pem'),
      cert: pem('client.pem'),
      key: pem('client-key.pem')
    })
    expect(info.subject).toBe('shellhouse-client')
    expect(info.expires).toBeGreaterThan(Date.now() + 365 * 24 * 3600 * 1000)
  })

  it('chỉ CA (server TLS, không mTLS) hoặc không gì cả → hợp lệ, không có chứng chỉ client', () => {
    expect(checkTlsMaterial({ ca: pem('ca.pem') })).toEqual({ expires: null, subject: null })
    expect(checkTlsMaterial({})).toEqual({ expires: null, subject: null })
  })

  it('CA không phải PEM → lỗi nói rõ', () => {
    expect(() => checkTlsMaterial({ ca: 'hello' })).toThrow(/CA file is not a PEM/)
  })

  it('có chứng chỉ mà thiếu khoá (hoặc ngược lại) → lỗi', () => {
    expect(() => checkTlsMaterial({ cert: pem('client.pem') })).toThrow(/both/)
    expect(() => checkTlsMaterial({ key: pem('client-key.pem') })).toThrow(/both/)
  })

  it('khoá đặt passphrase → hướng dẫn gỡ passphrase', () => {
    expect(() =>
      checkTlsMaterial({ cert: pem('client.pem'), key: pem('encrypted-key.pem') })
    ).toThrow(/passphrase/)
  })

  it('khoá không khớp chứng chỉ → lỗi', () => {
    expect(() => checkTlsMaterial({ cert: pem('client.pem'), key: pem('other-key.pem') })).toThrow(
      /do not belong together/
    )
  })

  it('khoá / chứng chỉ rác → lỗi theo từng tệp', () => {
    expect(() => checkTlsMaterial({ cert: pem('client.pem'), key: 'nope' })).toThrow(
      /private key file is not a valid/
    )
    expect(() => checkTlsMaterial({ cert: 'nope', key: pem('client-key.pem') })).toThrow(
      /client certificate is not a PEM/
    )
  })

  it('chứng chỉ client đã hết hạn → lỗi kèm ngày', () => {
    const farFuture = new Date('2200-01-01').getTime()
    expect(() =>
      checkTlsMaterial({ cert: pem('client.pem'), key: pem('client-key.pem') }, farFuture)
    ).toThrow(/expired on 2126-09-15/)
  })
})
