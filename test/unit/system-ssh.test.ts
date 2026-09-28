import { describe, expect, it } from 'vitest'
import { buildSystemSshArgs } from '../../src/session-host/transport/system-ssh'

const target = { host: 'srv.example', port: 22, username: 'deploy' }

describe('buildSystemSshArgs', () => {
  it('cơ bản: port, user, `--` trước hostname', () => {
    expect(buildSystemSshArgs({ target, jumps: [], keyFile: null })).toEqual([
      '-p',
      '22',
      '-l',
      'deploy',
      '--',
      'srv.example'
    ])
  })

  it('IdentityFile, chuỗi jump (IPv6 có ngoặc vuông), tuỳ chọn test', () => {
    expect(
      buildSystemSshArgs({
        target: { ...target, port: 2222 },
        jumps: [
          { host: 'bastion', port: 22, username: 'a' },
          { host: 'fe80::1', port: 2200, username: 'b' }
        ],
        keyFile: '/home/u/.ssh/id_work',
        testOptions: ['UserKnownHostsFile=/tmp/kh']
      })
    ).toEqual([
      '-p',
      '2222',
      '-l',
      'deploy',
      '-i',
      '/home/u/.ssh/id_work',
      '-J',
      'a@bastion:22,b@[fe80::1]:2200',
      '-o',
      'UserKnownHostsFile=/tmp/kh',
      '--',
      'srv.example'
    ])
  })

  it('chặn chèn tham số ở mọi vị trí', () => {
    const bad = [
      { target: { ...target, host: '-oProxyCommand=x' }, jumps: [], keyFile: null },
      { target: { ...target, username: '-oX' }, jumps: [], keyFile: null },
      { target, jumps: [{ host: 'a b', port: 22, username: 'x' }], keyFile: null },
      { target, jumps: [], keyFile: '-oProxyCommand=x' },
      { target, jumps: [], keyFile: 'relative/key' }
    ]
    for (const spec of bad) expect(() => buildSystemSshArgs(spec)).toThrow()
  })
})
