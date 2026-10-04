import type { HostSummary } from '@shared/hosts'
import { Monitor, Router, Server } from 'lucide-react'
import { osTitle, type HostOs } from '@shared/host-os'
import { OsIcon } from './OsIcon'
import { cx, StatusDot, type ConnectionState } from './ui'

/** "web-01 production" → "WP", "bastion" → "BA". */
export function initials(label: string): string {
  const words = label.split(/[\s._\-/@:]+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
  const first = words[0] ?? label
  const chars = (w: string): string[] =>
    Array.from(new Intl.Segmenter().segment(w), (s) => s.segment)
  const pick = (w: string): string => chars(w).find((c) => /[\p{L}\p{N}]/u.test(c)) ?? ''
  const a = pick(first)
  const second = words.slice(1).find((w) => /\p{L}/u.test(w))
  const b = second ? pick(second) : (chars(first).filter((c) => /[\p{L}\p{N}]/u.test(c))[1] ?? '')
  return (a + b).toUpperCase() || '?'
}

/**
 * Biểu tượng của host (thiết kế v0.5 — đơn sắc, theo màu chữ phụ): glyph hệ điều hành server đã nhận
 * ra lúc kết nối, màn hình cho Remote Desktop, máy chủ cho host còn lại. Màu chỉ dành cho trạng
 * thái / môi trường, không tô logo. Chấm trạng thái phiên ở góc khi có phiên đang mở.
 */
export function HostAvatar({
  host,
  size = 16,
  session,
  className
}: {
  host: Pick<HostSummary, 'label' | 'color'> & {
    os?: HostOs | null | undefined
    /** Remote Desktop → icon màn hình. */
    protocol?: HostSummary['protocol'] | undefined
  }
  size?: number
  session?: ConnectionState | null
  className?: string
}): React.JSX.Element {
  const os = host.os ?? null
  const glyph = Math.round(size * 0.86)
  return (
    <span
      aria-hidden
      title={os ? osTitle(os) : undefined}
      data-os={os?.id}
      className={cx('relative flex shrink-0 items-center justify-center text-faint', className)}
      style={{ width: size, height: size }}
    >
      {os ? (
        <OsIcon os={os.id} size={glyph} mono />
      ) : host.protocol === 'rdp' ? (
        <Monitor size={glyph} strokeWidth={1.6} data-testid="rdp-avatar" />
      ) : host.protocol === 'serial' || host.protocol === 'telnet' ? (
        <Router size={glyph} strokeWidth={1.6} />
      ) : (
        <Server size={glyph} strokeWidth={1.6} />
      )}
      {session && (
        <StatusDot
          state={session}
          className="absolute -right-0.5 -bottom-0.5 size-1.5 ring-2 ring-surface"
        />
      )}
    </span>
  )
}
