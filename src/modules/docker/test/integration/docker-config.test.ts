import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localTempConfig, remoteTempConfig } from '../../session-host/docker-config'

/** `--config` tạm cho đăng nhập registry: giữ builder buildx + docker context của cấu hình thật. */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Cấu hình Docker "thật" giả lập: builder, context, config.json có cả thông tin đăng nhập cũ. */
function realConfig(currentContext = 'desktop-linux'): string {
  const real = mkdtempSync(join(tmpdir(), 'sh-real-docker-'))
  dirs.push(real)
  mkdirSync(join(real, 'buildx', 'instances'), { recursive: true })
  writeFileSync(join(real, 'buildx', 'instances', 'multi'), '{"Name":"multi"}')
  mkdirSync(join(real, 'contexts', 'meta', 'abc'), { recursive: true })
  writeFileSync(join(real, 'contexts', 'meta', 'abc', 'meta.json'), '{"Name":"desktop-linux"}')
  writeFileSync(
    join(real, 'config.json'),
    JSON.stringify(
      { auths: { 'ghcr.io': { auth: 'b2xkOnNlY3JldA==' } }, currentContext, credsStore: 'desktop' },
      null,
      2
    )
  )
  return real
}

function checkMirror(path: string, real: string): void {
  // Builder và context đọc được qua thư mục tạm.
  expect(readFileSync(join(path, 'buildx', 'instances', 'multi'), 'utf8')).toContain('multi')
  expect(existsSync(join(path, 'contexts', 'meta', 'abc', 'meta.json'))).toBe(true)
  // Chỉ mang currentContext — không thông tin đăng nhập / credsStore cũ.
  const cfg = JSON.parse(readFileSync(join(path, 'config.json'), 'utf8')) as Record<string, unknown>
  expect(cfg).toEqual({ currentContext: 'desktop-linux' })
  expect(existsSync(join(real, 'config.json'))).toBe(true)
}

function checkRemoved(path: string, real: string): void {
  expect(existsSync(path)).toBe(false)
  // Cấu hình thật còn nguyên (xoá không đi theo liên kết).
  expect(existsSync(join(real, 'buildx', 'instances', 'multi'))).toBe(true)
  expect(existsSync(join(real, 'contexts', 'meta', 'abc', 'meta.json'))).toBe(true)
}

describe('thư mục --config tạm', () => {
  it('máy này: liên kết buildx / contexts, chỉ chép currentContext; xoá không đụng cấu hình thật', async () => {
    const real = realConfig()
    const base = mkdtempSync(join(tmpdir(), 'sh-tmp-'))
    dirs.push(base)
    const dir = await localTempConfig({ DOCKER_CONFIG: real }, base)
    checkMirror(dir.path, real)
    await dir.remove()
    checkRemoved(dir.path, real)
  })

  it('máy này: không có cấu hình thật → thư mục rỗng, vẫn dùng được', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sh-tmp-'))
    dirs.push(base)
    const dir = await localTempConfig({ DOCKER_CONFIG: join(base, 'missing') }, base)
    expect(existsSync(join(dir.path, 'config.json'))).toBe(false)
    await dir.remove()
    expect(existsSync(dir.path)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'server SSH / WSL: cùng việc bằng sh (mktemp, ln -s, sed), xoá an toàn',
    async () => {
      const real = realConfig()
      const exec = (argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          execFile(
            argv[0] ?? 'sh',
            argv.slice(1),
            { env: { ...process.env, DOCKER_CONFIG: real } },
            (error, stdout, stderr) => {
              resolve({ code: error ? 1 : 0, stdout, stderr })
            }
          )
        })
      const dir = await remoteTempConfig(exec)
      dirs.push(dir.path)
      checkMirror(dir.path, real)
      await dir.remove()
      checkRemoved(dir.path, real)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'tên context lạ (có ký tự shell) không được chép',
    async () => {
      const real = realConfig('x"; rm -rf /tmp/zz; "')
      const base = mkdtempSync(join(tmpdir(), 'sh-tmp-'))
      dirs.push(base)
      const dir = await localTempConfig({ DOCKER_CONFIG: real }, base)
      expect(existsSync(join(dir.path, 'config.json'))).toBe(false)
      await dir.remove()
    }
  )
})
