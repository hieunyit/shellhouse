import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSshConfig } from '../../src/main/hosts/ssh-config-import'
import { tempDir } from './helpers'

function setupHome(): string {
  const home = tempDir()
  mkdirSync(join(home, '.ssh', 'conf.d'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_work'), 'key')
  return home
}

const scan = (text: string, home: string, existingLabels: string[] = []) =>
  scanSshConfig(text, { home, existingLabels, defaultUser: 'me' })

describe('scanSshConfig', () => {
  it('đọc host cụ thể, áp mặc định từ Host *, bỏ qua pattern', () => {
    const home = setupHome()
    const result = scan(
      `
Host web
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_work
  ProxyJump bastion

Host bastion db-*
  HostName bastion.example.com

Host *.internal
  User ops

Host *
  User fallback
`,
      home
    )
    expect(result.map((r) => r.alias)).toEqual(['web', 'bastion'])
    expect(result[0]).toEqual({
      alias: 'web',
      hostname: '10.0.0.5',
      port: 2222,
      username: 'deploy',
      keyFile: join(home, '.ssh', 'id_work'),
      proxyJump: 'bastion',
      duplicate: false,
      problem: null,
      warning: null
    })
    expect(result[1]).toMatchObject({
      hostname: 'bastion.example.com',
      username: 'fallback',
      port: 22
    })
  })

  it('đánh dấu trùng tên và lỗi (hostname lạ, key không tồn tại)', () => {
    const home = setupHome()
    const result = scan(
      `
Host prod
  HostName prod.example.com
Host evil
  HostName -oProxyCommand=touch
Host nokey
  HostName k.example.com
  IdentityFile ~/.ssh/missing
`,
      home,
      ['PROD']
    )
    expect(result.find((r) => r.alias === 'prod')?.duplicate).toBe(true)
    expect(result.find((r) => r.alias === 'evil')?.problem).toMatch(/Invalid hostname/)
    // IdentityFile không có trên máy này: vẫn nhập được (chọn key khác lúc nhập) — chỉ cảnh báo.
    const nokey = result.find((r) => r.alias === 'nokey')
    expect(nokey?.problem).toBeNull()
    expect(nokey?.keyFile).toBeNull()
    expect(nokey?.warning).toMatch(/IdentityFile/)
  })

  it('xử lý Include (glob, đường dẫn tương đối theo ~/.ssh)', () => {
    const home = setupHome()
    writeFileSync(
      join(home, '.ssh', 'conf.d', 'a.conf'),
      'Host from-include\n  HostName inc.example.com\n'
    )
    const result = scan('Include conf.d/*.conf\nHost main\n  HostName main.example.com\n', home)
    expect(result.map((r) => r.alias)).toEqual(['from-include', 'main'])
  })

  it('KHÔNG thực thi lệnh trong `Match exec`', () => {
    const home = setupHome()
    const marker = join(home, 'pwned')
    scan(`Match exec "touch ${marker}"\n  User x\nHost h\n  HostName h.example.com\n`, home)
    expect(existsSync(marker)).toBe(false)
  })
})
