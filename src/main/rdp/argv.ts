import { hostPort } from '@shared/rdp'
import { qualifiedUser, type RdpTarget } from './rdp-file'

/**
 * Tham số dòng lệnh cho client RDP. Luôn là MẢNG đối số truyền thẳng cho spawn (không qua shell),
 * và KHÔNG BAO GIỜ chứa mật khẩu: FreeRDP đọc mật khẩu từ stdin (/from-stdin), mstsc lấy từ
 * Credential Manager (cmdkey).
 */

/** Phiên bản chính của FreeRDP — cú pháp tuỳ chọn khác nhau giữa 2.x và 3.x. */
export type FreeRdpMajor = 2 | 3

export function freerdpArgs(
  target: RdpTarget,
  options: { major: FreeRdpMajor; passwordOnStdin: boolean }
): string[] {
  const s = target.settings
  const v3 = options.major === 3
  const args = [`/v:${hostPort(target.host, target.port)}`]
  if (target.username) args.push(`/u:${target.username}`)
  if (target.domain) args.push(`/d:${target.domain}`)
  // /from-stdin chỉ hỏi những gì còn thiếu, theo thứ tự Username → Domain → Password: đặt domain
  // rỗng để dòng đầu tiên trên stdin chắc chắn là mật khẩu.
  else if (options.passwordOnStdin) args.push('/d:')
  if (options.passwordOnStdin) args.push('/from-stdin')
  // Chứng chỉ: tin ở lần đầu, báo khi đổi (như known_hosts của SSH). Không có terminal để hỏi.
  args.push(v3 ? '/cert:tofu' : '/cert-tofu')
  args.push(v3 ? `/title:${target.label}` : `/t:${target.label}`)
  if (s.fullScreen) {
    args.push('/f')
    if (s.multiMonitor) args.push('/multimon')
  } else {
    args.push(`/size:${s.width}x${s.height}`)
  }
  if (s.dynamicResolution) args.push('/dynamic-resolution')
  if (s.scale !== null) args.push(`/scale-desktop:${s.scale}`)
  args.push(s.clipboard ? '+clipboard' : '-clipboard')
  if (s.drives) args.push('+home-drive')
  args.push(s.audio ? '/sound' : '/audio-mode:2')
  if (s.printers) args.push('/printer')
  if (s.gateway) args.push(v3 ? `/gateway:g:${s.gateway}` : `/g:${s.gateway}`)
  args.push('+auto-reconnect')
  return args
}

/**
 * mstsc chạy bằng tham số thay cho file .rdp (file tạm không ký → Windows cảnh báo "Unknown
 * publisher"). Chỉ dùng khi `mstscFileOnlyOptions` rỗng — phần còn lại mstsc lấy từ Default.rdp.
 * Tên đăng nhập + mật khẩu đi qua Credential Manager (cmdkey); không có thì /prompt để mstsc hỏi.
 */
export function mstscArgs(target: RdpTarget, options: { prompt: boolean }): string[] {
  const s = target.settings
  const args = [`/v:${hostPort(target.host, target.port)}`]
  if (s.fullScreen) {
    args.push('/f')
    if (s.multiMonitor) args.push('/multimon')
  } else {
    args.push(`/w:${s.width}`, `/h:${s.height}`)
  }
  if (options.prompt) args.push('/prompt')
  return args
}

/** Đích trong Credential Manager mà mstsc tra khi kết nối tới `host`. */
export function termsrvTarget(host: string): string {
  return `TERMSRV/${host}`
}

/**
 * `cmdkey /generic:TERMSRV/<host> /user:<u> /pass:<p>` — mstsc dùng mà không hỏi lại. Đây là cách
 * duy nhất mstsc nhận mật khẩu do chương trình khác cấp; mục này bị xoá khi client thoát.
 */
export function cmdkeyAddArgs(
  host: string,
  username: string,
  domain: string,
  password: string
): string[] {
  return [
    `/generic:${termsrvTarget(host)}`,
    `/user:${qualifiedUser(username, domain)}`,
    `/pass:${password}`
  ]
}

export function cmdkeyDeleteArgs(host: string): string[] {
  return [`/delete:${termsrvTarget(host)}`]
}

/** macOS: `open -a "<app>" file.rdp` — Windows App tự hỏi mật khẩu. */
export function macOpenArgs(appPath: string, file: string): string[] {
  return ['-a', appPath, file]
}

/** Remmina: `remmina -c file.remmina`. */
export function remminaArgs(file: string): string[] {
  return ['-c', file]
}
