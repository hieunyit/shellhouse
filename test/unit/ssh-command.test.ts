import { describe, expect, it } from 'vitest'
import { shellQuote, sshCommand } from '../../src/shared/ssh-command'

describe('sshCommand', () => {
  it('host đơn giản, port mặc định', () => {
    expect(sshCommand({ username: 'root', hostname: 'web.example.com', port: 22 })).toBe(
      'ssh root@web.example.com'
    )
  })

  it('port khác 22, jump host nhiều chặng, key file', () => {
    expect(
      sshCommand(
        { username: 'deploy', hostname: '10.0.1.5', port: 2222 },
        {
          jumps: [
            { username: 'jump', hostname: 'bastion.example.com', port: 22 },
            { username: 'ops', hostname: 'gw2', port: 2200 }
          ],
          keyFile: '/home/me/.ssh/id_ed25519'
        }
      )
    ).toBe(
      'ssh -i /home/me/.ssh/id_ed25519 -J jump@bastion.example.com,ops@gw2:2200 -p 2222 deploy@10.0.1.5'
    )
  })

  it('không có username → để ssh dùng mặc định; ProxyJump dạng chuỗi', () => {
    expect(sshCommand({ username: null, hostname: 'h', port: 22 }, { proxyJump: 'gw' })).toBe(
      'ssh -J gw h'
    )
  })

  it('giá trị có ký tự đặc biệt được bọc nháy, không chèn được lệnh', () => {
    expect(shellQuote("/tmp/my key's")).toBe(`'/tmp/my key'\\''s'`)
    expect(sshCommand({ username: 'u', hostname: 'h', port: 22 }, { keyFile: '/a b/$(rm)' })).toBe(
      "ssh -i '/a b/$(rm)' u@h"
    )
  })
})
