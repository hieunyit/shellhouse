import { describe, expect, it } from 'vitest'
import { parseQuickConnect } from '@shared/quick-connect'

describe('parseQuickConnect', () => {
  it.each([
    ['root@srv', { username: 'root', host: 'srv', port: 22 }],
    ['root@srv:2222', { username: 'root', host: 'srv', port: 2222 }],
    ['  ssh deploy@10.0.0.5 -p 2200 ', { username: 'deploy', host: '10.0.0.5', port: 2200 }],
    ['me@[::1]:2022', { username: 'me', host: '::1', port: 2022 }],
    ['me@fe80::1', { username: 'me', host: 'fe80::1', port: 22 }],
    ['a@b@host', { username: 'a@b', host: 'host', port: 22 }]
  ])('%s', (input, expected) => {
    expect(parseQuickConnect(input)).toEqual(expected)
  })

  it('dùng user mặc định khi thiếu', () => {
    expect(parseQuickConnect('srv', 'hieu')).toEqual({ username: 'hieu', host: 'srv', port: 22 })
    expect(parseQuickConnect('srv')).toBeNull()
  })

  it.each(['', 'root@', 'root@srv:0', 'root@srv:99999', 'a b@c', 'root@-oProxyCommand=x', '-l@x'])(
    'từ chối %j',
    (input) => {
      expect(parseQuickConnect(input)).toBeNull()
    }
  )
})
