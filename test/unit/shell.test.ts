import { describe, expect, it } from 'vitest'
import { buildShellEnv, defaultShell, findOnPath } from '../../src/session-host/transport/shell'

const base = { homedir: '/home/u', userShell: null, appVersion: '1.2.3' }

describe('buildShellEnv', () => {
  it('đặt biến terminal và loại biến của Electron/app', () => {
    const env = buildShellEnv({
      ...base,
      platform: 'linux',
      env: {
        PATH: '/usr/bin',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
        SHELLHOUSE_TEST_HOOKS: '1',
        VITE_X: 'y',
        LANG: 'vi_VN.UTF-8'
      }
    })
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Shellhouse',
      TERM_PROGRAM_VERSION: '1.2.3',
      LANG: 'vi_VN.UTF-8'
    })
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'SHELLHOUSE_TEST_HOOKS', 'VITE_X']) {
      expect(env).not.toHaveProperty(key)
    }
  })

  it('đặt LANG UTF-8 mặc định trên Unix khi thiếu', () => {
    expect(buildShellEnv({ ...base, platform: 'linux', env: {} })['LANG']).toBe('en_US.UTF-8')
    expect(buildShellEnv({ ...base, platform: 'win32', env: {} })).not.toHaveProperty('LANG')
  })
})

describe('defaultShell', () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p)

  it('Linux: ưu tiên $SHELL nếu tồn tại', () => {
    const s = defaultShell({
      ...base,
      platform: 'linux',
      env: { SHELL: '/usr/bin/zsh' },
      exists: has('/usr/bin/zsh', '/bin/bash')
    })
    expect(s).toMatchObject({ file: '/usr/bin/zsh', args: [], cwd: '/home/u' })
  })

  it('Linux: $SHELL không tồn tại → shell trong passwd → /bin/bash → /bin/sh', () => {
    const ctx = { ...base, platform: 'linux' as const, env: { SHELL: '/nope' } }
    expect(defaultShell({ ...ctx, userShell: '/bin/fish', exists: has('/bin/fish') }).file).toBe(
      '/bin/fish'
    )
    expect(defaultShell({ ...ctx, exists: has('/bin/bash') }).file).toBe('/bin/bash')
    expect(defaultShell({ ...ctx, exists: has() }).file).toBe('/bin/sh')
  })

  it('macOS: chạy login shell', () => {
    const s = defaultShell({
      ...base,
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      exists: has('/bin/zsh')
    })
    expect(s).toMatchObject({ file: '/bin/zsh', args: ['-l'] })
  })

  it('Windows: pwsh nếu có trên PATH, không thì powershell.exe', () => {
    const env = { PATH: 'C:\\Windows;C:\\Program Files\\PowerShell\\7' }
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    expect(defaultShell({ ...base, platform: 'win32', env, exists: has(pwsh) }).file).toBe(pwsh)
    expect(defaultShell({ ...base, platform: 'win32', env, exists: has() }).file).toBe(
      'powershell.exe'
    )
  })
})

describe('findOnPath', () => {
  it('trả null khi không có', () => {
    expect(findOnPath('x', { PATH: '/a:/b' }, 'linux', () => false)).toBeNull()
  })
})
