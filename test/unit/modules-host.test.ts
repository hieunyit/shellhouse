import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { HostModule, SshCapability } from '../../src/modules/registry/host-types'
import { HostModuleRegistry, ModulePermissionError } from '../../src/modules/registry/session-host'
import type { ModuleManifest } from '../../src/modules/registry/types'
import { shellQuote } from '../../src/node-shared/shell-quote'
import { tempDir } from './helpers'

function manifest(extra: Partial<ModuleManifest>): ModuleManifest {
  return {
    id: 'fake',
    name: 'Fake',
    summary: '',
    description: '',
    category: 'other',
    keywords: [],
    source: 'builtin',
    since: '1.3.0',
    permissions: [],
    version: 1,
    icon: 'puzzle',
    enabledByDefault: true,
    contributes: { sessionKinds: ['main'], attachToSsh: true },
    ...extra
  }
}

/** Module giả: lấy lại ctx để thử từng năng lực. */
function capture(m: ModuleManifest) {
  const got: { ctx?: Parameters<NonNullable<HostModule['createSession']>>[2] } = {}
  const module: HostModule = {
    manifest: m,
    createSession: (_kind, _config, ctx) => {
      got.ctx = ctx
      return { run: () => Promise.resolve(null), dispose: () => undefined }
    }
  }
  return { module, got }
}

const sink = { emit: () => undefined, transfers: () => undefined }

describe('HostModuleRegistry', () => {
  it('module tắt / loại phiên không khai báo → không tạo phiên', () => {
    const { module } = capture(manifest({}))
    const registry = new HostModuleRegistry([module], {
      log: () => undefined,
      requestProgramGrant: () => Promise.resolve(true)
    })
    expect(() => registry.createSession('fake', 'main', {}, sink)).toThrow(/turned off/)
    registry.setEnabled(['fake'])
    expect(() => registry.createSession('fake', 'other', {}, sink)).toThrow(/no session kind/)
    expect(() => registry.createSession('fake', 'main', {}, sink)).not.toThrow()
  })

  it('chạy chương trình: chỉ binary khai báo + quyền run-program; hỏi người dùng một lần; từ chối → lỗi', async () => {
    const { module, got } = capture(
      manifest({
        binaries: ['docker'],
        permissions: [{ kind: 'run-program', binary: 'docker' }]
      })
    )
    const asked: string[] = []
    let allow = false
    const registry = new HostModuleRegistry([module], {
      log: () => undefined,
      // "docker" giả = node đang chạy test.
      findProgram: (name) => (name === 'docker' ? process.execPath : null),
      requestProgramGrant: (_m, binary) => {
        asked.push(binary)
        return Promise.resolve(allow)
      }
    })
    registry.setEnabled(['fake'])
    registry.createSession('fake', 'main', {}, sink)
    const spawn = got.ctx?.spawn
    await expect(spawn?.exec('kubectl', ['version'])).rejects.toThrow(ModulePermissionError)
    await expect(spawn?.exec('docker', ['-e', '1'])).rejects.toThrow(/did not allow/)
    allow = true
    const result = await spawn?.exec('docker', [
      '-e',
      'process.stdout.write(process.argv[1])',
      'a b;c'
    ])
    expect(result).toMatchObject({ code: 0, stdout: 'a b;c' })
    // Đối số đi nguyên vẹn (không qua shell); cho phép được nhớ, không hỏi lại.
    await spawn?.exec('docker', ['-e', '0'])
    expect(asked).toEqual(['docker', 'docker'])
    const echoed = await spawn?.exec('docker', ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'xin chào'
    })
    expect(echoed?.stdout).toBe('xin chào')
  }, 30_000)

  it('SSH: exec / socket / tunnel chỉ khi khai báo; mẫu đường dẫn socket có *', async () => {
    const calls: string[] = []
    const raw: SshCapability = {
      label: 'u@h',
      exec: (argv) => {
        calls.push(argv.join(' '))
        return Promise.resolve({ code: 0, stdout: '', stderr: '' })
      },
      spawn: () => Promise.reject(new Error('unused')),
      openPty: () => Promise.reject(new Error('unused')),
      openUnixSocket: (path) => {
        calls.push(`socket ${path}`)
        return Promise.resolve(new Duplex())
      },
      openTcp: () => Promise.resolve(new Duplex())
    }
    const registry = new HostModuleRegistry([], {
      log: () => undefined,
      requestProgramGrant: () => Promise.resolve(true)
    })
    const none = registry.guardSsh(manifest({}), raw)
    await expect(none.exec(['docker', 'ps'])).rejects.toThrow(ModulePermissionError)
    await expect(none.openTcp('10.0.0.1', 6443)).rejects.toThrow(ModulePermissionError)
    await expect(none.openUnixSocket('/var/run/docker.sock')).rejects.toThrow(ModulePermissionError)

    const docker = registry.guardSsh(
      manifest({
        permissions: [
          { kind: 'ssh-exec', detail: 'Runs docker' },
          { kind: 'ssh-socket', path: '/var/run/docker.sock' },
          { kind: 'ssh-socket', path: '/run/user/*/docker.sock' }
        ]
      }),
      raw
    )
    await docker.exec(['docker', 'ps'])
    await docker.openUnixSocket('/var/run/docker.sock')
    await docker.openUnixSocket('/run/user/1000/docker.sock')
    await expect(docker.openUnixSocket('/run/user/1000/x/docker.sock')).rejects.toThrow(
      ModulePermissionError
    )
    await expect(docker.openUnixSocket('/etc/shadow')).rejects.toThrow(ModulePermissionError)
    expect(calls).toEqual([
      'docker ps',
      'socket /var/run/docker.sock',
      'socket /run/user/1000/docker.sock'
    ])
  })

  it('đọc file: chỉ đường dẫn khai báo (~ = home, /** = cả thư mục)', async () => {
    const home = tempDir()
    mkdirSync(join(home, '.kube', 'extra'), { recursive: true })
    writeFileSync(join(home, '.kube', 'config'), 'apiVersion: v1')
    writeFileSync(join(home, '.kube', 'extra', 'dev.yaml'), 'dev')
    writeFileSync(join(home, 'secret.txt'), 'no')
    const { module, got } = capture(
      manifest({ permissions: [{ kind: 'read-file', path: '~/.kube/**' }] })
    )
    const registry = new HostModuleRegistry([module], {
      log: () => undefined,
      requestProgramGrant: () => Promise.resolve(true),
      home
    })
    registry.setEnabled(['fake'])
    registry.createSession('fake', 'main', {}, sink)
    await expect(got.ctx?.readFile('~/.kube/config')).resolves.toBe('apiVersion: v1')
    await expect(got.ctx?.readFile(join(home, '.kube', 'extra', 'dev.yaml'))).resolves.toBe('dev')
    await expect(got.ctx?.readFile('~/secret.txt')).rejects.toThrow(ModulePermissionError)
  })
})

describe('shellQuote', () => {
  it('quote an toàn cho sh; giữ nguyên chữ an toàn', () => {
    expect(shellQuote(['docker', 'ps', '--format', '{{json .}}'])).toBe(
      "docker ps --format '{{json .}}'"
    )
    expect(shellQuote(['echo', "it's; rm -rf /"])).toBe(`echo 'it'\\''s; rm -rf /'`)
    expect(shellQuote(['a', ''])).toBe("a ''")
    expect(() => shellQuote([])).toThrow()
    expect(() => shellQuote(['a\0b'])).toThrow()
  })
})
