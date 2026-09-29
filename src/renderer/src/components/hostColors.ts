import type { HostSummary } from '@shared/hosts'

export const hostColorClass: Record<NonNullable<HostSummary['color']>, string> = {
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  yellow: 'bg-yellow-400',
  green: 'bg-emerald-500',
  teal: 'bg-teal-400',
  blue: 'bg-sky-500',
  purple: 'bg-violet-500',
  gray: 'bg-zinc-400'
}

/** Ô icon của host trong sidebar: nền nhạt + icon cùng màu (dễ nhận ra, không giống chấm báo lỗi). */
export const hostTileClass: Record<NonNullable<HostSummary['color']>, string> = {
  red: 'bg-red-500/15 text-red-500',
  orange: 'bg-orange-500/15 text-orange-500',
  yellow: 'bg-yellow-400/20 text-yellow-600 dark:text-yellow-400',
  green: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  teal: 'bg-teal-400/20 text-teal-600 dark:text-teal-300',
  blue: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  purple: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  gray: 'bg-zinc-400/20 text-zinc-500 dark:text-zinc-300'
}

/** Viền màu môi trường (thanh phiên / tab). */
export const hostBorderClass: Record<NonNullable<HostSummary['color']>, string> = {
  red: 'border-t-red-500',
  orange: 'border-t-orange-500',
  yellow: 'border-t-yellow-400',
  green: 'border-t-emerald-500',
  teal: 'border-t-teal-400',
  blue: 'border-t-sky-500',
  purple: 'border-t-violet-500',
  gray: 'border-t-zinc-400'
}

/** Màu chữ/icon (thư mục nhóm có màu môi trường). */
export const hostTextClass: Record<NonNullable<HostSummary['color']>, string> = {
  red: 'text-red-500',
  orange: 'text-orange-500',
  yellow: 'text-yellow-500',
  green: 'text-emerald-500',
  teal: 'text-teal-500',
  blue: 'text-sky-500',
  purple: 'text-violet-500',
  gray: 'text-zinc-400'
}
