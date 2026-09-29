import { describe, expect, it } from 'vitest'
import { detectShells, parseWslList, type DetectDeps } from '../../src/node-shared/shells'

const deps = (patch: Partial<DetectDeps>): DetectDeps => ({
  platform: 'linux',
  env: {},
  exists: () => true,
  readFile: () => '',
  wslDistros: () => Promise.resolve([]),
  ...patch
})

describe('parseWslList', () => {
  it('đọc output UTF-16LE (có BOM) của wsl.exe --list --quiet', () => {
    const raw = Buffer.from('\uFEFFUbuntu-24.04\r\nDebian\r\n\r\n', 'utf16le')
    expect(parseWslList(raw)).toEqual(['Ubuntu-24.04', 'Debian'])
  })
  it('bỏ dòng thông báo lỗi (khi chưa cài bản phân phối nào)', () => {
    const raw = Buffer.from(
      'Windows Subsystem for Linux has no installed distributions.\r\n',
      'utf16le'
    )
    expect(parseWslList(raw)).toEqual([])
  })
})

describe('detectShells trên Windows', () => {
  const files = new Set([
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Windows\\System32\\wsl.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe'
  ])
  it('PowerShell 7, Windows PowerShell, cmd, từng bản WSL, Git Bash', async () => {
    const shells = await detectShells(
      deps({
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', PATH: '' },
        exists: (p) => files.has(p),
        wslDistros: () => Promise.resolve(['Ubuntu', 'Debian'])
      })
    )
    expect(shells.map((s) => [s.id, s.name])).toEqual([
      ['pwsh', 'PowerShell 7'],
      ['powershell', 'Windows PowerShell'],
      ['cmd', 'Command Prompt'],
      ['wsl:Ubuntu', 'Ubuntu (WSL)'],
      ['wsl:Debian', 'Debian (WSL)'],
      ['git-bash', 'Git Bash']
    ])
    expect(shells.find((s) => s.id === 'wsl:Ubuntu')?.args).toEqual(['-d', 'Ubuntu', '--cd', '~'])
  })

  it('không có WSL / PowerShell 7 / Git → vẫn có PowerShell và cmd', async () => {
    const shells = await detectShells(
      deps({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: () => false })
    )
    expect(shells.map((s) => s.id)).toEqual(['powershell', 'cmd'])
  })
})

describe('detectShells trên Linux / macOS', () => {
  it('$SHELL trước, rồi /etc/shells; bỏ trùng tên và nologin', async () => {
    const shells = await detectShells(
      deps({
        env: { SHELL: '/usr/bin/zsh' },
        readFile: () =>
          '# comment\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/usr/bin/zsh\n/usr/sbin/nologin\n',
        exists: (p) => p !== '/bin/bash'
      })
    )
    expect(shells.map((s) => s.id)).toEqual(['zsh', 'sh', 'bash'])
    expect(shells[0]?.name).toBe('zsh (default)')
    expect(shells.find((s) => s.id === 'bash')?.file).toBe('/usr/bin/bash')
  })

  it('macOS: login shell (-l)', async () => {
    const shells = await detectShells(
      deps({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, readFile: () => '/bin/zsh\n' })
    )
    expect(shells[0]?.args).toEqual(['-l'])
  })
})
