import { t } from '@shared/i18n'
import { isAbsolute } from 'node:path'
import { Hostname, Username } from '@shared/hosts'
import type { SystemSshSessionSpec } from '@shared/stream-protocol'
import { findOnPath } from './shell'

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

function checkTarget(target: { host: string; username: string }): void {
  // Kiểm tra lại dù zod đã kiểm ở main: đây là ranh giới cuối trước khi thành tham số dòng lệnh.
  if (!Hostname.safeParse(target.host).success)
    throw new Error(t('Invalid hostname: {value}', { value: target.host }))
  if (!Username.safeParse(target.username).success)
    throw new Error(t('Invalid username: {value}', { value: target.username }))
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
      throw new Error(t('IdentityFile must be an absolute path: {path}', { path: spec.keyFile }))
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
