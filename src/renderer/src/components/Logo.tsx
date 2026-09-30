import { useId } from 'react'

/**
 * Logo Shellhouse: mái nhà + dấu nhắc ">_" ("Shell" + "house") trên nền vuông bo góc tối — cùng
 * hình với icon app (scripts/make-icon.mjs). Nền luôn tối nên dùng được ở cả theme sáng và tối.
 */
export function Logo({
  size = 24,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  // id riêng cho mỗi lần vẽ: nhiều logo trên cùng trang không dùng nhầm gradient của nhau.
  const id = useId().replace(/:/g, '')
  return (
    <svg
      viewBox="80 80 864 864"
      width={size}
      height={size}
      role="img"
      aria-label="Shellhouse"
      className={className}
    >
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d2531" />
          <stop offset="1" stopColor="#0c0f14" />
        </linearGradient>
        <linearGradient id={`${id}-mark`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5eead4" />
          <stop offset="1" stopColor="#14b8a6" />
        </linearGradient>
      </defs>
      <rect
        x="84"
        y="84"
        width="856"
        height="856"
        rx="200"
        fill={`url(#${id}-tile)`}
        stroke="#2b3544"
        strokeWidth="8"
      />
      <g
        fill="none"
        stroke={`url(#${id}-mark)`}
        strokeWidth="76"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M250 452 L512 262 L774 452" />
        <path d="M318 548 L448 646 L318 744" />
        <path d="M528 744 H706" />
      </g>
    </svg>
  )
}
