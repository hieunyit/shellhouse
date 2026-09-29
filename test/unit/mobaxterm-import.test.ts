import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeMobaIni, scanMobaXterm } from '../../src/main/hosts/mobaxterm-import'
import { tempDir } from './helpers'

/** Chuỗi phiên SSH của MobaXterm: `#icon#0%host%port%user%…%gateway…%key%…#font…#…`. */
function ssh(opts: {
  host: string
  port?: string
  user?: string
  gateway?: [host: string, port: string, user: string]
  key?: string
}): string {
  const [gh, gp, gu] = opts.gateway ?? ['', '22', '']
  const fields = [
    '0',
    opts.host,
    opts.port ?? '22',
    opts.user ?? '',
    '',
    '-1',
    '-1',
    '',
    gh,
    gp,
    gu,
    '0',
    '0',
    '0',
    opts.key ?? '',
    '',
    '-1',
    '0',
    '0',
    '0',
    '',
    '1080',
    '',
    '0',
    '0',
    '1'
  ]
  return `#109#${fields.join('%')}#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%0%#0# #-1`
}

const RDP =
  '#91#4%192.0.2.10%3389%administrator%0%0%0%0%-1%0%0%-1%%%%%0%0%%-1%%-1%-1%0%-1%0%-1%0%0%0%0%#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%0%#0# #-1'

function setupHome(): string {
  const home = tempDir()
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_moba'), 'key')
  return home
}

const scan = (text: string, home: string, existingLabels: string[] = []) =>
  scanMobaXterm(text, { home, existingLabels, defaultUser: 'me' })

describe('scanMobaXterm', () => {
  it('đọc phiên SSH theo thư mục lồng nhau; bỏ qua RDP/WSL và đếm lại', () => {
    const home = setupHome()
    const ini = [
      '[Misc]',
      'SkinName=x',
      '[Bookmarks]',
      'SubRep=',
      'ImgNum=42',
      `web=${ssh({ host: 'web.example.com', port: '2222', user: 'deploy' })}`,
      `win=${RDP}`,
      'WSL-Ubuntu=#105#14%Ubuntu-22.04%',
      '[Bookmarks_1]',
      'SubRep=Prod\\Database',
      'ImgNum=41',
      `db=${ssh({ host: '10.0.0.5', user: 'postgres', gateway: ['bastion.example.com', '2200', 'jump'] })}`,
      '[Passwords]',
      'ssh22:deploy@web.example.com=SHOULD-NEVER-BE-READ'
    ].join('\r\n')

    const { candidates, ignored } = scan(ini, home)
    expect(ignored).toEqual({ RDP: 1, WSL: 1 })
    expect(candidates).toEqual([
      {
        alias: 'web',
        label: 'web',
        group: [],
        hostname: 'web.example.com',
        port: 2222,
        username: 'deploy',
        keyFile: null,
        proxyJump: null,
        duplicate: false,
        problem: null
      },
      {
        alias: 'Prod\\Database\\db',
        label: 'db',
        group: ['Prod', 'Database'],
        hostname: '10.0.0.5',
        port: 22,
        username: 'postgres',
        keyFile: null,
        proxyJump: 'jump@bastion.example.com:2200',
        duplicate: false,
        problem: null
      }
    ])
    expect(JSON.stringify(candidates)).not.toContain('SHOULD-NEVER-BE-READ')
  })

  it('private key: thay _ProfileDir_; key không tồn tại → báo lỗi, không chọn được', () => {
    const home = setupHome()
    const ini = [
      '[Bookmarks]',
      'SubRep=',
      `ok=${ssh({ host: 'a.example.com', user: 'u', key: '_ProfileDir_\\.ssh\\id_moba' })}`,
      `missing=${ssh({ host: 'b.example.com', user: 'u', key: '_ProfileDir_\\.ssh\\nope' })}`
    ].join('\n')
    const [ok, missing] = scan(ini, home).candidates
    expect(ok?.keyFile).toBe(join(home, '.ssh', 'id_moba'))
    expect(ok?.problem).toBeNull()
    expect(missing?.problem).toMatch(/Private key not found/)
  })

  it('nhiều jump host (__PIPE__), user trống → user mặc định, trùng tên → duplicate', () => {
    const home = setupHome()
    const ini = [
      '[Bookmarks]',
      'SubRep=',
      `app=${ssh({ host: 'app.internal', gateway: ['b1.example.com__PIPE__b2', '22__PIPE__2222', 'x__PIPE__y'] })}`
    ].join('\n')
    const [app] = scan(ini, home, ['APP']).candidates
    expect(app?.username).toBe('me')
    expect(app?.proxyJump).toBe('x@b1.example.com,y@b2:2222')
    expect(app?.duplicate).toBe(true)
  })

  it('giá trị nguy hiểm không lọt qua (hostname / jump host bắt đầu bằng "-")', () => {
    const home = setupHome()
    const ini = [
      '[Bookmarks]',
      'SubRep=',
      `h=${ssh({ host: '-oProxyCommand=x', user: 'u' })}`,
      `j=${ssh({ host: 'ok.example.com', user: 'u', gateway: ['-oProxyCommand=x', '22', ''] })}`
    ].join('\n')
    const [h, j] = scan(ini, home).candidates
    expect(h?.problem).toMatch(/Invalid hostname/)
    expect(j?.problem).toMatch(/Invalid jump host/)
    expect(j?.proxyJump).toBeNull()
  })

  it('file ANSI (windows-1252) vẫn đọc được tên có dấu', () => {
    const bytes = Buffer.from('[Bookmarks]\nSubRep=Caf\xe9\n', 'latin1')
    expect(decodeMobaIni(bytes)).toContain('SubRep=Café')
    expect(decodeMobaIni(Buffer.from('SubRep=Máy chủ', 'utf8'))).toContain('Máy chủ')
  })
})
