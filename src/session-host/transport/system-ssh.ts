import { isAbsolute } from 'node:path'
import { Hostname, Username } from '@shared/hosts'
import type { SystemSshSessionSpec } from '@shared/stream-protocol'
import { findOnPath } from './shell'

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

function checkTarget(t: { host: string; username: string }): void {
  // Kiểm tra lại dù zod đã kiểm ở main: đây là ranh giới cuối trước khi thành tham số dòng lệnh.
  if (!Hostname.safeParse(t.host).success) throw new Error(`Invalid hostname: ${t.host}`)
  if (!Username.safeParse(t.username).success) throw new Error(`Invalid username: ${t.username}`)
}

/**
 * Tham số cho `ssh` của hệ thống. Luôn là MẢNG (không ghép chuỗi shell) và kết thúc bằng `--`
 * trước hostname, nên hostname không bao giờ bị hiểu thành tuỳ chọn.
 */
export function buildSystemSshArgs(
  spec: Pick<SystemSshSessionSpec, 'target' | 'jumps' | 'keyFile' | 'testOptions'>
): string[] {
  checkTarget(spec.target)
  const args = ['-p', String(spec.target.port), '-l', spec.target.username]
  if (spec.keyFile) {
    if (!isAbsolute(spec.keyFile) || spec.keyFile.startsWith('-')) {
      throw new Error(`IdentityFile must be an absolute path: ${spec.keyFile}`)
    }
    args.push('-i', spec.keyFile)
  }
  if (spec.jumps.length > 0) {
    for (const j of spec.jumps) checkTarget(j)
    args.push(
      '-J',
      spec.jumps.map((j) => `${j.username}@${formatHost(j.host)}:${j.port}`).join(',')
    )
  }
  for (const option of spec.testOptions ?? []) args.push('-o', option)
  args.push('--', spec.target.host)
  return args
}

export function findSystemSsh(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  return findOnPath(platform === 'win32' ? 'ssh.exe' : 'ssh', env, platform)
}
