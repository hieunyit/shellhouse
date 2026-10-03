import type { ReactNode } from 'react'
import type { OsId } from '@shared/host-os'

/**
 * Dấu nhận diện hệ điều hành server: hình tròn màu đặc trưng + ký hiệu đơn giản tự vẽ (không dùng
 * file logo). Hệ toạ độ 16×16, tâm (8, 8).
 */
interface Mark {
  bg: string
  glyph: ReactNode
}

const W = '#fff'

function letter(text: string, fill = W, size = 9): ReactNode {
  return (
    <text
      x="8"
      y="8"
      dy="0.36em"
      textAnchor="middle"
      fontFamily="ui-sans-serif, system-ui, sans-serif"
      fontWeight="700"
      fontSize={size}
      fill={fill}
    >
      {text}
    </text>
  )
}

const MARKS: Record<OsId, Mark> = {
  // Vòng tròn với ba chấm.
  ubuntu: {
    bg: '#E95420',
    glyph: (
      <g fill="none" stroke={W} strokeWidth="1.3">
        <circle cx="8" cy="8" r="3.3" />
        <circle cx="11.6" cy="8" r="1.1" fill={W} stroke="#E95420" strokeWidth="0.6" />
        <circle cx="6.2" cy="4.9" r="1.1" fill={W} stroke="#E95420" strokeWidth="0.6" />
        <circle cx="6.2" cy="11.1" r="1.1" fill={W} stroke="#E95420" strokeWidth="0.6" />
      </g>
    )
  },
  // Vòng xoáy.
  debian: {
    bg: '#A81D33',
    glyph: (
      <path
        d="M10.6 9.6A3.2 3.2 0 1 1 9.9 5.3M9.9 5.3A2 2 0 0 0 6.6 7.9a1.3 1.3 0 0 0 2.2.7"
        fill="none"
        stroke={W}
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    )
  },
  // Chiếc mũ.
  rhel: {
    bg: '#EE0000',
    glyph: (
      <g fill={W}>
        <path d="M5.4 8.6 6.3 5.2c.2-.6.8-.8 1.3-.5l.5.3.6-.3c.5-.2 1 0 1.2.6l.9 3.3c-1.6.6-3.8.6-5.4 0Z" />
        <path d="M3.4 8.8c-.5.5.4 1.6 2.6 2.2 2.6.7 5.9.4 6.6-.6.3-.4 0-.9-.6-1.2.1.6-1.6 1.2-4 1-2.3-.1-4.3-.8-4.6-1.4Z" />
      </g>
    )
  },
  // Chong chóng bốn màu.
  centos: {
    bg: '#fff',
    glyph: (
      <g transform="rotate(45 8 8)">
        <rect x="4.2" y="4.2" width="3.4" height="3.4" fill="#EFA724" />
        <rect x="8.4" y="4.2" width="3.4" height="3.4" fill="#9CCD2A" />
        <rect x="8.4" y="8.4" width="3.4" height="3.4" fill="#262577" />
        <rect x="4.2" y="8.4" width="3.4" height="3.4" fill="#932279" />
      </g>
    )
  },
  // Dãy núi.
  rocky: {
    bg: '#10B981',
    glyph: <path d="M3.2 11.2 6.6 6.4l1.9 2.5 1.3-1.6 3 3.9Z" fill={W} />
  },
  almalinux: { bg: '#0F4266', glyph: letter('A') },
  fedora: { bg: '#51A2DA', glyph: letter('f', W, 10.5) },
  // Nụ cười.
  amazon: {
    bg: '#232F3E',
    glyph: (
      <g fill="none" stroke="#FF9900" strokeWidth="1.4" strokeLinecap="round">
        <path d="M4 8.4c2.4 1.7 5.6 1.7 8 0" />
        <path d="M10.6 7.7 12 8.4l-.4 1.5" />
      </g>
    )
  },
  suse: { bg: '#30BA78', glyph: letter('S') },
  opensuse: { bg: '#73BA25', glyph: letter('S') },
  // Mũi tên nhọn.
  arch: {
    bg: '#1793D1',
    glyph: <path d="M8 3.3 12.4 12.3 8 10.2 3.6 12.3Z" fill={W} />
  },
  alpine: {
    bg: '#0D597F',
    glyph: <path d="M2.8 11 6.4 5.6l2 3 1.4-1.8 3.4 4.2Z" fill={W} />
  },
  // Viên thuốc rỗng.
  oracle: {
    bg: '#C74634',
    glyph: (
      <rect
        x="3.6"
        y="5.6"
        width="8.8"
        height="4.8"
        rx="2.4"
        fill="none"
        stroke={W}
        strokeWidth="1.4"
      />
    )
  },
  kali: { bg: '#367BF0', glyph: letter('K') },
  raspbian: { bg: '#C51A4A', glyph: letter('π', W, 10) },
  // Quả cầu có sừng.
  freebsd: {
    bg: '#AB2B28',
    glyph: (
      <g fill="none" stroke={W} strokeWidth="1.2" strokeLinecap="round">
        <path d="M4.4 6.2C4 4.9 4.3 3.9 5 3.4M11.6 6.2c.4-1.3.1-2.3-.6-2.8" />
        <circle cx="8" cy="9" r="2.8" />
      </g>
    )
  },
  // Quả táo (hình chung).
  macos: {
    bg: '#3F3F46',
    glyph: (
      <g fill={W}>
        <path d="M8 6.1c-.9-.7-2.9-.8-3.6.9-.7 1.6.1 3.9 1.3 4.6.8.4 1.5 0 2.3 0s1.5.4 2.3 0c1.2-.7 2-3 1.3-4.6-.7-1.7-2.7-1.6-3.6-.9Z" />
        <path d="M8.2 5.4c0-1 .7-1.8 1.7-1.9 0 1-.7 1.8-1.7 1.9Z" />
      </g>
    )
  },
  // Bốn ô cửa sổ.
  windows: {
    bg: '#0078D4',
    glyph: (
      <g fill={W}>
        <rect x="4.4" y="4.4" width="3.3" height="3.3" />
        <rect x="8.3" y="4.4" width="3.3" height="3.3" />
        <rect x="4.4" y="8.3" width="3.3" height="3.3" />
        <rect x="8.3" y="8.3" width="3.3" height="3.3" />
      </g>
    )
  },
  // Chim cánh cụt giản lược.
  linux: {
    bg: '#FCC624',
    glyph: (
      <g>
        <ellipse cx="8" cy="8.6" rx="3.1" ry="4" fill="#1F2937" />
        <ellipse cx="8" cy="9.6" rx="1.8" ry="2.5" fill={W} />
        <path d="M7.2 6.6h1.6L8 7.6Z" fill="#F59E0B" />
      </g>
    )
  },
  // Dấu nhắc lệnh.
  unix: {
    bg: '#52525B',
    glyph: (
      <path
        d="m4.6 5.8 2.4 2.2-2.4 2.2M8.4 10.6h3"
        fill="none"
        stroke={W}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )
  }
}

/** Icon hệ điều hành (tròn). `title` = chú thích khi rê chuột. */
export function OsIcon({
  os,
  size = 16,
  title,
  className
}: {
  os: OsId
  size?: number
  title?: string
  className?: string
}): React.JSX.Element {
  const mark = MARKS[os]
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      data-testid="os-icon"
      data-os={os}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <circle cx="8" cy="8" r="8" fill={mark.bg} />
      {os === 'centos' && <circle cx="8" cy="8" r="7.5" fill="none" stroke="#e4e4e7" />}
      {mark.glyph}
    </svg>
  )
}
