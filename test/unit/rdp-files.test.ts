import { describe, expect, it } from 'vitest'
import { DEFAULT_RDP, RdpSettings, RdpUsername, rdpAddress, splitDomainUser } from '@shared/rdp'
import { HostInput } from '@shared/hosts'
import {
  buildRdpFile,
  buildRemminaFile,
  decodeRdpFile,
  encodeRdpFile,
  parseAddress,
  parseRdpFile,
  type RdpTarget
} from '../../src/main/rdp/rdp-file'
import {
  cmdkeyAddArgs,
  cmdkeyDeleteArgs,
  freerdpArgs,
  macOpenArgs,
  remminaArgs
} from '../../src/main/rdp/argv'
import { detectRdpClient, findInPath, parseFreeRdpMajor } from '../../src/main/rdp/detect'
import { rdpHostInput, scanRdpFiles } from '../../src/main/rdp/controller'

const target = (over: Partial<RdpTarget> = {}, settings: Partial<RdpSettings> = {}): RdpTarget => ({
  label: 'Win Server',
  host: 'win.example.com',
  port: 3389,
  username: 'john',
  domain: 'CORP',
  settings: { ...DEFAULT_RDP, ...settings },
  ...over
})

const lines = (text: string): string[] => text.split('\r\n').filter(Boolean)

describe('RDP: file .rdp', () => {
  it('cửa sổ 1920×1080, chuyển hướng, username có domain — không bao giờ có mật khẩu', () => {
    const text = buildRdpFile(target())
    const l = lines(text)
    expect(l).toContain('full address:s:win.example.com:3389')
    expect(l).toContain('screen mode id:i:1')
    expect(l).toContain('desktopwidth:i:1920')
    expect(l).toContain('desktopheight:i:1080')
    expect(l).toContain('username:s:CORP\\john')
    expect(l).toContain('domain:s:CORP')
    expect(l).toContain('redirectclipboard:i:1')
    expect(l).toContain('audiomode:i:0')
    expect(l).toContain('drivestoredirect:s:')
    expect(l).toContain('gatewayusagemethod:i:0')
    expect(text).not.toMatch(/password/i)
    expect(text.endsWith('\r\n')).toBe(true)
  })

  it('toàn màn hình nhiều màn hình, scale, gateway, IPv6', () => {
    const l = lines(
      buildRdpFile(
        target(
          { host: '::1', port: 3390, domain: '' },
          {
            fullScreen: true,
            multiMonitor: true,
            scale: 150,
            drives: true,
            audio: false,
            printers: true,
            gateway: 'gw.example.com'
          }
        )
      )
    )
    expect(l).toContain('full address:s:[::1]:3390')
    expect(l).toContain('screen mode id:i:2')
    expect(l).toContain('use multimon:i:1')
    expect(l).toContain('desktopscalefactor:i:150')
    expect(l).toContain('drivestoredirect:s:*')
    expect(l).toContain('audiomode:i:2')
    expect(l).toContain('redirectprinters:i:1')
    expect(l).toContain('gatewayhostname:s:gw.example.com')
    expect(l).toContain('gatewayusagemethod:i:1')
    expect(l).toContain('username:s:john')
    expect(l.some((x) => x.startsWith('domain:'))).toBe(false)
  })

  it('chống chèn dòng cấu hình (ký tự xuống dòng trong giá trị)', () => {
    expect(() => buildRdpFile(target({ username: 'john\r\nalternate shell:s:cmd.exe' }))).toThrow()
  })

  it('UTF-16LE có BOM; đọc lại được (cả UTF-8)', () => {
    const encoded = encodeRdpFile(buildRdpFile(target({ username: 'nguyễn' })))
    expect([...encoded.subarray(0, 2)]).toEqual([0xff, 0xfe])
    expect(decodeRdpFile(encoded)).toContain('username:s:CORP\\nguyễn')
    expect(decodeRdpFile(Buffer.from('\ufefffull address:s:a'))).toBe('full address:s:a')
  })

  it('file .remmina: không có mật khẩu, nhãn có ký tự điều khiển bị thay', () => {
    const text = buildRemminaFile(target({ label: 'bad\nlabel' }, { drives: true }), '/home/u')
    expect(text.startsWith('[remmina]\n')).toBe(true)
    expect(text).toContain('name=bad label\n')
    expect(text).toContain('server=win.example.com:3389\n')
    expect(text).toContain('sharefolder=/home/u\n')
    expect(text).toContain('protocol=RDP\n')
    expect(text).not.toMatch(/^password=/m)
  })

  it('đọc file .rdp của mstsc (import)', () => {
    const parsed = parseRdpFile(
      [
        'screen mode id:i:2',
        'desktopwidth:i:2560',
        'desktopheight:i:1440',
        'full address:s:srv01.corp.local:3390',
        'username:s:CORP\\admin',
        'redirectclipboard:i:0',
        'audiomode:i:2',
        'drivestoredirect:s:*',
        'gatewayhostname:s:rdgw.corp.local',
        'gatewayusagemethod:i:1',
        'desktopscalefactor:i:125',
        'password 51:b:01000000D08C9DDF'
      ].join('\r\n')
    )
    expect(parsed).toMatchObject({
      hostname: 'srv01.corp.local',
      port: 3390,
      username: 'admin',
      settings: {
        domain: 'CORP',
        fullScreen: true,
        width: 2560,
        height: 1440,
        clipboard: false,
        audio: false,
        drives: true,
        gateway: 'rdgw.corp.local',
        scale: 125
      }
    })
    expect(parseRdpFile('nothing here')).toBeNull()
    // Giá trị lạ → giữ mặc định thay vì bỏ cả file.
    expect(parseRdpFile('full address:s:h\ndesktopwidth:i:10')?.settings.width).toBe(1920)
  })

  it('địa chỉ host[:port]', () => {
    expect(parseAddress('h')).toEqual({ host: 'h', port: 3389 })
    expect(parseAddress('h:3390')).toEqual({ host: 'h', port: 3390 })
    expect(parseAddress('[fe80::1]:3390')).toEqual({ host: 'fe80::1', port: 3390 })
    expect(parseAddress('fe80::1')).toEqual({ host: 'fe80::1', port: 3389 })
  })

  it('quét nhiều file .rdp → host RDP', () => {
    const scan = scanRdpFiles(
      [
        { path: '/x/Web.rdp', text: 'full address:s:web:3389\nusername:s:bob' },
        { path: '/y/Web.rdp', text: 'full address:s:-evil' },
        { path: '/z/broken.rdp', text: null }
      ],
      ['web']
    )
    expect(scan.candidates.map((c) => c.alias)).toEqual(['Web.rdp', 'Web.rdp (2)', 'broken.rdp'])
    expect(scan.candidates[0]).toMatchObject({ duplicate: true, problem: null, username: 'bob' })
    expect(scan.candidates[1]?.problem).toBeTruthy()
    expect(scan.candidates[2]?.problem).toBeTruthy()
    const input = rdpHostInput(scan.parsed.get('Web.rdp') ?? ({} as never))
    expect(HostInput.safeParse(input).success).toBe(true)
    expect(input).toMatchObject({ protocol: 'rdp', hostname: 'web', username: 'bob', auth: 'auto' })
  })
})

describe('RDP: kiểm tra trường', () => {
  it('tên đăng nhập Windows (UPN, khoảng trắng giữa) nhưng không ký tự cấm', () => {
    for (const ok of ['john', 'john.doe@corp.com', 'John Smith', 'nguyễn'])
      expect(RdpUsername.safeParse(ok).success, ok).toBe(true)
    for (const bad of ['-x', ' john', 'a\nb', 'a"b', 'a/b', 'a\\b', 'a:b', 'a;b', ''])
      expect(RdpUsername.safeParse(bad).success, bad).toBe(false)
  })

  it('domain, kích thước, gateway / tunnel loại trừ nhau', () => {
    expect(RdpSettings.safeParse({ ...DEFAULT_RDP, domain: 'corp.example.com' }).success).toBe(true)
    expect(RdpSettings.safeParse({ ...DEFAULT_RDP, domain: '.' }).success).toBe(true)
    expect(RdpSettings.safeParse({ ...DEFAULT_RDP, domain: 'CO RP' }).success).toBe(false)
    expect(RdpSettings.safeParse({ ...DEFAULT_RDP, width: 100 }).success).toBe(false)
    expect(RdpSettings.safeParse({ ...DEFAULT_RDP, gateway: '-x' }).success).toBe(false)
    const both = RdpSettings.safeParse({ ...DEFAULT_RDP, gateway: 'gw', viaHostId: 'h1' })
    expect(both.success).toBe(false)
  })

  it('tách DOMAIN\\user; địa chỉ hiển thị', () => {
    expect(splitDomainUser('CORP\\john')).toEqual({ domain: 'CORP', username: 'john' })
    expect(splitDomainUser('john@corp.com')).toEqual({ domain: null, username: 'john@corp.com' })
    expect(rdpAddress({ hostname: 'h', port: 3389, username: 'u' })).toBe('u@h')
    expect(rdpAddress({ hostname: 'h', port: 3390, username: '' })).toBe('h:3390')
  })
})

describe('RDP: tham số dòng lệnh', () => {
  it('FreeRDP 3: mật khẩu qua stdin, không bao giờ trong argv', () => {
    const args = freerdpArgs(target({}, { scale: 125, drives: true, printers: true }), {
      major: 3,
      passwordOnStdin: true
    })
    expect(args).toEqual([
      '/v:win.example.com:3389',
      '/u:john',
      '/d:CORP',
      '/from-stdin',
      '/cert:tofu',
      '/title:Win Server',
      '/size:1920x1080',
      '/dynamic-resolution',
      '/scale-desktop:125',
      '+clipboard',
      '+home-drive',
      '/sound',
      '/printer',
      '+auto-reconnect'
    ])
    expect(args.some((a) => a.startsWith('/p:'))).toBe(false)
  })

  it('FreeRDP 2: cú pháp cũ; domain rỗng + stdin → /d: để dòng đầu là mật khẩu', () => {
    const args = freerdpArgs(
      target(
        { domain: '' },
        { fullScreen: true, multiMonitor: true, clipboard: false, audio: false, gateway: 'gw' }
      ),
      { major: 2, passwordOnStdin: true }
    )
    expect(args).toContain('/d:')
    expect(args).toContain('/cert-tofu')
    expect(args).toContain('/t:Win Server')
    expect(args).toContain('/f')
    expect(args).toContain('/multimon')
    expect(args).toContain('-clipboard')
    expect(args).toContain('/audio-mode:2')
    expect(args).toContain('/g:gw')
    expect(args.some((a) => a.startsWith('/size:'))).toBe(false)
    const noPw = freerdpArgs(target({ domain: '' }), { major: 3, passwordOnStdin: false })
    expect(noPw).not.toContain('/from-stdin')
    expect(noPw).not.toContain('/d:')
  })

  it('cmdkey / open / remmina', () => {
    expect(cmdkeyAddArgs('127.0.0.1', 'john', 'CORP', 'p@ss "x"')).toEqual([
      '/generic:TERMSRV/127.0.0.1',
      '/user:CORP\\john',
      '/pass:p@ss "x"'
    ])
    expect(cmdkeyDeleteArgs('srv')).toEqual(['/delete:TERMSRV/srv'])
    expect(macOpenArgs('/Applications/Windows App.app', '/t/a.rdp')).toEqual([
      '-a',
      '/Applications/Windows App.app',
      '/t/a.rdp'
    ])
    expect(remminaArgs('/t/a.remmina')).toEqual(['-c', '/t/a.remmina'])
  })
})

describe('RDP: dò client', () => {
  const deps = (platform: NodeJS.Platform, files: string[], version = '') => ({
    platform,
    env: { PATH: ['/usr/local/bin', '/usr/bin'].join(':'), SystemRoot: 'C:\\Windows' },
    home: '/home/u',
    exists: (p: string) => files.includes(p),
    output: () => Promise.resolve(version)
  })

  it('Linux: xfreerdp3 > xfreerdp (đọc phiên bản) > Remmina; không có → null', async () => {
    expect(
      await detectRdpClient(deps('linux', ['/usr/bin/xfreerdp3', '/usr/bin/xfreerdp']))
    ).toMatchObject({ kind: 'xfreerdp', name: 'xfreerdp3', freerdpMajor: 3 })
    expect(
      await detectRdpClient(deps('linux', ['/usr/bin/xfreerdp'], 'This is FreeRDP version 3.5.1'))
    ).toMatchObject({ name: 'xfreerdp', freerdpMajor: 3 })
    expect(await detectRdpClient(deps('linux', ['/usr/bin/xfreerdp']))).toMatchObject({
      freerdpMajor: 2
    })
    expect(await detectRdpClient(deps('linux', ['/usr/bin/remmina']))).toMatchObject({
      kind: 'remmina'
    })
    expect(await detectRdpClient(deps('linux', []))).toBeNull()
  })

  it('macOS: Windows App / Microsoft Remote Desktop', async () => {
    expect(
      await detectRdpClient(deps('darwin', ['/home/u/Applications/Microsoft Remote Desktop.app']))
    ).toMatchObject({ kind: 'windows-app', name: 'Microsoft Remote Desktop' })
    expect(await detectRdpClient(deps('darwin', ['/Applications/Windows App.app']))).toMatchObject({
      name: 'Windows App'
    })
  })

  it('PATH / phiên bản', () => {
    expect(
      findInPath('x', { env: { PATH: '/a:/b' }, exists: (p) => p === '/b/x', platform: 'linux' })
    ).toBe('/b/x')
    expect(
      findInPath('x.exe', {
        env: { PATH: 'C:\\a;C:\\b' },
        exists: (p) => p === 'C:\\b\\x.exe',
        platform: 'win32'
      })
    ).toBe('C:\\b\\x.exe')
    expect(parseFreeRdpMajor('This is FreeRDP version 2.11.7 (2.11.7)', 3)).toBe(2)
    expect(parseFreeRdpMajor(null, 3)).toBe(3)
  })
})
