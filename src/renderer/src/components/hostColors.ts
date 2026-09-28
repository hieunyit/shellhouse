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
