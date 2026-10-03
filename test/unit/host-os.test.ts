import { describe, expect, it } from 'vitest'
import {
  HostOs,
  isWindowsSshServer,
  OS_DETECT_SCRIPT,
  OS_UNAME_MARKER,
  osFromDetectOutput,
  osFromRelease,
  osFromUname,
  osFromWindowsVer,
  osIdFromRelease,
  osTitle,
  parseOsRelease,
  sameOs
} from '@shared/host-os'

const UBUNTU = `PRETTY_NAME="Ubuntu 22.04.4 LTS"
NAME="Ubuntu"
VERSION_ID="22.04"
VERSION="22.04.4 LTS (Jammy Jellyfish)"
VERSION_CODENAME=jammy
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
`

describe('host-os: đọc /etc/os-release', () => {
  it('bóc nháy kép / nháy đơn / không nháy, bỏ chú thích và dòng sai', () => {
    const r = parseOsRelease(
      [
        '# comment',
        'NAME="Debian GNU/Linux"',
        "ID='debian'",
        'VERSION_ID=12',
        'BAD LINE',
        'PRETTY_NAME="Say \\"hi\\" \\$HOME"',
        'lower=x'
      ].join('\r\n')
    )
    expect(r).toEqual({
      NAME: 'Debian GNU/Linux',
      ID: 'debian',
      VERSION_ID: '12',
      PRETTY_NAME: 'Say "hi" $HOME'
    })
  })

  it('Ubuntu → NAME + VERSION', () => {
    expect(osFromRelease(parseOsRelease(UBUNTU))).toEqual({
      id: 'ubuntu',
      name: 'Ubuntu',
      version: '22.04.4 LTS (Jammy Jellyfish)'
    })
  })

  it.each([
    ['ubuntu', '', 'ubuntu'],
    ['debian', '', 'debian'],
    ['rhel', 'fedora', 'rhel'],
    ['centos', 'rhel fedora', 'centos'],
    ['rocky', 'rhel centos fedora', 'rocky'],
    ['almalinux', 'rhel centos fedora', 'almalinux'],
    ['fedora', '', 'fedora'],
    ['amzn', 'centos rhel fedora', 'amazon'],
    ['sles', '', 'suse'],
    ['sles_sap', 'suse', 'suse'],
    ['opensuse-leap', 'suse opensuse', 'opensuse'],
    ['opensuse-tumbleweed', 'opensuse suse', 'opensuse'],
    ['arch', '', 'arch'],
    ['archarm', 'arch', 'arch'],
    ['alpine', '', 'alpine'],
    ['ol', 'fedora', 'oracle'],
    ['kali', 'debian', 'kali'],
    ['raspbian', 'debian', 'raspbian'],
    ['freebsd', '', 'freebsd'],
    // Không có icon riêng → theo ID_LIKE.
    ['linuxmint', 'ubuntu debian', 'ubuntu'],
    ['pop', 'ubuntu debian', 'ubuntu'],
    ['manjaro', 'arch', 'arch'],
    ['eurolinux', 'rhel fedora centos', 'rhel'],
    ['nixos', '', 'linux']
  ])('ID=%s ID_LIKE=%s → %s', (id, like, expected) => {
    expect(osIdFromRelease({ ID: id, ID_LIKE: like })).toBe(expected)
  })

  it('Arch (rolling) không có version; thiếu cả ID lẫn NAME → null', () => {
    expect(osFromRelease({ NAME: 'Arch Linux', ID: 'arch' })).toEqual({
      id: 'arch',
      name: 'Arch Linux',
      version: null
    })
    expect(osFromRelease({ VERSION_ID: '1' })).toBeNull()
    expect(osIdFromRelease({ NAME: 'Red Hat Enterprise Linux' })).toBe('rhel')
  })
})

describe('host-os: output lệnh dò', () => {
  it('lệnh dò không có dấu nháy đơn (bọc được trong sh -c …)', () => {
    expect(OS_DETECT_SCRIPT).not.toContain("'")
    expect(OS_DETECT_SCRIPT).toContain('/etc/os-release')
  })

  it('os-release có → dùng nó (bỏ qua uname)', () => {
    const out = `${UBUNTU}${OS_UNAME_MARKER}\nLinux 6.8.0-45-generic\n`
    expect(osFromDetectOutput(out)?.id).toBe('ubuntu')
  })

  it('Raspberry Pi OS 64-bit (ID=debian + /etc/rpi-issue)', () => {
    const out = `NAME="Debian GNU/Linux"\nID=debian\nVERSION="12 (bookworm)"\n--SHELLHOUSE-RPI--\n${OS_UNAME_MARKER}\nLinux 6.6\n`
    expect(osFromDetectOutput(out)).toEqual({
      id: 'raspbian',
      name: 'Raspberry Pi OS',
      version: '12 (bookworm)'
    })
  })

  it('không có os-release → uname: macOS (sw_vers), FreeBSD, Linux, BSD khác', () => {
    expect(osFromDetectOutput(`${OS_UNAME_MARKER}\nDarwin 23.4.0\n14.4.1\n`)).toEqual({
      id: 'macos',
      name: 'macOS',
      version: '14.4.1'
    })
    expect(osFromDetectOutput(`${OS_UNAME_MARKER}\nFreeBSD 14.0-RELEASE\n`)).toEqual({
      id: 'freebsd',
      name: 'FreeBSD',
      version: '14.0-RELEASE'
    })
    expect(osFromDetectOutput(`${OS_UNAME_MARKER}\nLinux 4.19.0\n`)?.id).toBe('linux')
    expect(osFromDetectOutput(`${OS_UNAME_MARKER}\nOpenBSD 7.5\n`)?.id).toBe('unix')
    expect(osFromUname('MINGW64_NT-10.0 3.4')?.id).toBe('windows')
  })

  it('output lạ (thiết bị mạng, shell hạn chế) → null', () => {
    expect(osFromDetectOutput('% Invalid input detected at marker.\n')).toBeNull()
    expect(osFromDetectOutput('')).toBeNull()
    expect(osFromDetectOutput(`${OS_UNAME_MARKER}\nIOS-XE 17\n`)).toBeNull()
  })

  it('Windows OpenSSH: nhận theo chuỗi phiên bản server + `ver`', () => {
    expect(isWindowsSshServer('OpenSSH_for_Windows_9.5')).toBe(true)
    expect(isWindowsSshServer('OpenSSH_9.6p1 Ubuntu-3ubuntu13')).toBe(false)
    expect(isWindowsSshServer(undefined)).toBe(false)
    expect(osFromWindowsVer('\r\nMicrosoft Windows [Version 10.0.20348.2340]\r\n')).toEqual({
      id: 'windows',
      name: 'Windows',
      version: '10.0.20348.2340'
    })
    expect(osFromWindowsVer('Microsoft Windows [Versión 10.0.19045.4291]').version).toBe(
      '10.0.19045.4291'
    )
    expect(osFromWindowsVer('').version).toBeNull()
  })
})

describe('host-os: so sánh / hiển thị / schema', () => {
  it('sameOs, osTitle, HostOs từ chối id lạ', () => {
    const a = { id: 'debian', name: 'Debian GNU/Linux', version: '12 (bookworm)' } as const
    expect(sameOs(a, { ...a })).toBe(true)
    expect(sameOs(a, { ...a, version: '13 (trixie)' })).toBe(false)
    expect(sameOs(null, undefined)).toBe(true)
    expect(sameOs(a, null)).toBe(false)
    expect(osTitle(a)).toBe('Debian GNU/Linux 12 (bookworm)')
    expect(osTitle({ id: 'arch', name: 'Arch Linux', version: null })).toBe('Arch Linux')
    expect(HostOs.safeParse({ id: 'beos', name: 'BeOS', version: null }).success).toBe(false)
  })
})
