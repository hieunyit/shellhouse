import { afterEach, describe, expect, it } from 'vitest'
import type { AccountSummary, KeySummary } from '@shared/hosts'
import { setLanguage } from '@shared/i18n'
import {
  accountBadges,
  accountProblem,
  accountUser,
  customFromAccount,
  filterAccounts,
  suggestAccountName
} from '../../src/renderer/src/components/accounts/account-logic'

const key: KeySummary = {
  id: 'k1',
  name: 'laptop',
  type: 'ed25519',
  fingerprint: 'SHA256:x',
  encrypted: true
}

function account(over: Partial<AccountSummary>): AccountSummary {
  return {
    id: 'a',
    name: 'Deploy',
    username: 'deploy',
    hasPassword: false,
    keyId: null,
    hasPassphrase: false,
    domain: '',
    notes: '',
    hostIds: [],
    updatedAt: 1,
    ...over
  }
}

afterEach(() => {
  setLanguage('en')
})

describe('ô chọn tài khoản', () => {
  it('nhãn: key (tên key), mật khẩu, passphrase chỉ khi có key, domain', () => {
    const full = account({ keyId: 'k1', hasPassword: true, hasPassphrase: true, domain: 'CORP' })
    expect(accountBadges(full, [key]).map((b) => [b.kind, b.label])).toEqual([
      ['key', 'laptop'],
      ['password', 'Password'],
      ['passphrase', 'passphrase'],
      ['domain', 'CORP']
    ])
    expect(accountBadges(account({ hasPassphrase: true }), [key])).toEqual([])
    expect(accountBadges(account({ keyId: 'gone' }), [])[0]?.label).toBe('SSH key (deleted)')
    setLanguage('vi')
    expect(accountBadges(account({ hasPassword: true }), [])[0]?.label).toBe('Mật khẩu')
  })

  it('tìm theo tên, username, domain (không dấu, mờ)', () => {
    const list = [
      account({ id: '1', name: 'Production deploy', username: 'deploy' }),
      account({ id: '2', name: 'Máy chủ Windows', username: 'Administrator', domain: 'CORP' }),
      account({ id: '3', name: 'Router', username: 'admin' })
    ]
    expect(filterAccounts(list, '').map((a) => a.id)).toEqual(['1', '2', '3'])
    expect(filterAccounts(list, 'may chu').map((a) => a.id)).toEqual(['2'])
    expect(filterAccounts(list, 'corp').map((a) => a.id)).toEqual(['2'])
    expect(filterAccounts(list, 'admin')[0]?.id).toBe('3')
    expect(filterAccounts(list, 'zzz')).toEqual([])
  })

  it('username phải hợp lệ theo giao thức; Telnet / Serial không dùng tài khoản', () => {
    const upn = account({ username: 'john@corp.com' })
    expect(accountProblem(upn, 'rdp')).toBeNull()
    expect(accountProblem(upn, 'ssh')).toMatch(/not a valid SSH username/)
    expect(accountProblem(account({ username: '' }), 'ssh')).toBeNull()
    expect(accountProblem(account({}), 'telnet')).toMatch(/SSH and Remote Desktop/)
    expect(accountUser(account({ domain: 'CORP', username: 'john' }))).toBe('CORP\\john')
  })

  it('chuyển sang Custom: chép username / cách đăng nhập (key trước mật khẩu)', () => {
    expect(customFromAccount(account({ keyId: 'k1', hasPassword: true }))).toEqual({
      username: 'deploy',
      auth: 'key',
      keyId: 'k1',
      domain: '',
      savePassword: true
    })
    expect(customFromAccount(account({ hasPassword: true })).auth).toBe('password')
    expect(customFromAccount(account({})).auth).toBe('auto')
  })

  it('tên gợi ý cho tài khoản mới không trùng', () => {
    const list = [account({ name: 'deploy' }), account({ name: 'deploy (2)' })]
    expect(suggestAccountName(list, 'deploy', '')).toBe('deploy (3)')
    expect(suggestAccountName(list, 'root', 'web')).toBe('root@web')
    expect(suggestAccountName(list, '', '')).toBe('')
  })
})
