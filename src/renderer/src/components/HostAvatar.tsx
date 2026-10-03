import type { HostSummary } from '@shared/hosts'
import { Monitor } from 'lucide-react'
import { osTitle, type HostOs } from '@shared/host-os'
import { OsIcon } from './OsIcon'
import { hostTileClass } from './hostColors'
import { cx, StatusDot, type ConnectionState } from './ui'

const PALETTE = Object.keys(hostTileClass) as NonNullable<HostSummary['color']>[]

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

/** Màu ổn định theo tên khi host chưa đặt màu (cùng tên → cùng màu). */
function colorFor(host: Pick<HostSummary, 'label' | 'color'>): NonNullable<HostSummary['color']> {
  if (host.color) return host.color
  let h = 0
  for (const c of host.label) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PALETTE[h % (PALETTE.length - 1)] ?? 'gray'
}

/**
 * Ảnh đại diện của host: icon hệ điều hành server (đã nhận ra lúc kết nối) hoặc chữ cái đầu, trên
 * nền màu môi trường; chấm trạng thái phiên. Host có màu riêng → icon distro nằm trên nền màu đó.
 */
export function HostAvatar({
  host,
  size = 28,
  session,
  className
}: {
  host: Pick<HostSummary, 'label' | 'color'> & {
    os?: HostOs | null | undefined
    /** Remote Desktop → icon màn hình thay cho chữ cái đầu. */
    protocol?: HostSummary['protocol'] | undefined
  }
  size?: number
  session?: ConnectionState | null
  className?: string
}): React.JSX.Element {
  const os = host.os ?? null
  return (
    <span
      aria-hidden
      title={os ? osTitle(os) : undefined}
      data-os={os?.id}
      className={cx(
        'relative flex shrink-0 items-center justify-center rounded-md font-semibold tracking-tight select-none',
        os ? (host.color ? hostTileClass[host.color] : 'bg-subtle') : hostTileClass[colorFor(host)],
        className
      )}
      style={{
        width: size,
        height: size,
        // Nhỏ (tab): một chữ cái to cho dễ đọc; lớn: hai chữ cái.
        fontSize: Math.round(size * (size < 22 ? 0.6 : 0.38))
      }}
    >
      {os ? (
        <OsIcon os={os.id} size={Math.round(size * (size < 22 ? 0.82 : 0.72))} />
      ) : host.protocol === 'rdp' ? (
        <Monitor size={Math.round(size * (size < 22 ? 0.75 : 0.55))} data-testid="rdp-avatar" />
      ) : size < 22 ? (
        initials(host.label).slice(0, 1)
      ) : (
        initials(host.label)
      )}
      {session && (
        <StatusDot
          state={session}
          className="absolute -right-0.5 -bottom-0.5 size-2 ring-2 ring-surface"
        />
      )}
    </span>
  )
}
