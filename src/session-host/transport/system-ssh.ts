import { t } from '@shared/i18n'
import { isAbsolute } from 'node:path'
import { Hostname, Username } from '@shared/hosts'
import type { SystemSshSessionSpec } from '@shared/stream-protocol'
import { findOnPath } from './shell'

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

/**
 * User cho `ssh` hệ thống: chặt hơn `Username` chung. OpenSSH đổi `-J` thành ProxyCommand chạy qua
 * `sh -c` mà không quote user / host của jump host (bản < 9.6 không tự kiểm), và `%r` trong
 * ProxyCommand / Match exec của ~/.ssh/config cũng chèn user vào lệnh shell — user lấy từ file
 * import (`a$(curl …)`) không được thành lệnh trên máy này. Như `valid_ruser` của OpenSSH 9.6.
 */
const SYSTEM_SSH_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/

function checkTarget(target: { host: string; username: string }, jump = false): void {
  // Kiểm tra lại dù zod đã kiểm ở main: đây là ranh giới cuối trước khi thành tham số dòng lệnh.
  // Jump host: "%" bị ProxyCommand hiểu là token (%h, %p…) → không nhận (vd. fe80::1%eth0).
  if (!Hostname.safeParse(target.host).success || (jump && target.host.includes('%')))
    throw new Error(t('Invalid hostname: {value}', { value: target.host }))
  if (!Username.safeParse(target.username).success || !SYSTEM_SSH_USER.test(target.username))
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
    for (const j of spec.jumps) checkTarget(j, true)
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
