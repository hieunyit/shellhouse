/** Ghép class (bỏ giá trị rỗng). */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** Vòng focus của DS: 2px accent + khe 2px theo nền, chỉ khi focus bằng bàn phím. */
export const focusRing = 'outline-none focus-visible:shadow-ds-focus'

/** Icon trong DS: 16px, nét 1.5, màu chữ phụ (đặt ở phần tử cha). */
export const ICON = { size: 16, strokeWidth: 1.5 } as const
export const ICON_SM = { size: 14, strokeWidth: 1.5 } as const

/** Chuyển động chung: ≤ 150ms, chỉ màu / opacity / transform. */
export const transition =
  'transition-[background-color,color,opacity,transform,box-shadow,border-color] duration-(--ds-dur-fast) ease-ds-standard'
