import { ArrowDown, ArrowUp, Clock, Cpu, HardDrive, MemoryStick } from 'lucide-react'
import type { ServerStats } from '@shared/server-stats'
import { t } from '@shared/i18n'
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRate
} from '@shared/i18n/format'
import { cx } from '../components/ui'

/** Phần trăm 0–100 → "42%" theo locale. */
function percent(value: number): string {
  return formatPercent(value / 100)
}

/** ≥ 90%: đỏ, ≥ 75%: vàng — dễ thấy server sắp đầy. */
function level(percent: number): string {
  return percent >= 90 ? 'text-danger' : percent >= 75 ? 'text-warning' : 'text-muted'
}

function Meter({ percent }: { percent: number }): React.JSX.Element {
  return (
    <span className="relative hidden h-1 w-10 overflow-hidden rounded-full bg-ds-chart-track @md:inline-block">
      <span
        className={cx(
          'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500',
          percent >= 90 ? 'bg-danger' : percent >= 75 ? 'bg-warning' : 'bg-chart'
        )}
        style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
      />
    </span>
  )
}

function Item({
  icon,
  title,
  className,
  children,
  testId
}: {
  icon: React.ReactNode
  title: string
  className?: string
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <span
      className={cx('flex shrink-0 items-center gap-1.5', className)}
      title={title}
      data-testid={testId}
    >
      <span className="text-faint">{icon}</span>
      {children}
    </span>
  )
}

const BAR_CLASS =
  '@container flex h-6 shrink-0 items-center gap-4 overflow-hidden border-t border-ds-border-subtle bg-surface px-3 text-xs whitespace-nowrap text-muted tabular-nums'

/** Ô xám nhấp nháy giữ chỗ cho một số liệu chưa có. */
function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cx('inline-block h-2 animate-pulse rounded bg-subtle', className)}
    />
  )
}

/**
 * Thanh giữ chỗ trong lúc chờ lần đo đầu tiên: cùng chiều cao với thanh thật (không giật bố cục),
 * các ô xám thay cho số liệu.
 */
export function ServerStatsPlaceholder(): React.JSX.Element {
  return (
    <div
      className={BAR_CLASS}
      data-testid="server-stats-loading"
      role="status"
      aria-busy="true"
      aria-label={t('Loading server stats…')}
    >
      <span className="flex items-center gap-1.5">
        <Cpu size={12} className="text-faint" />
        <Skeleton className="w-8" />
      </span>
      <span className="flex items-center gap-1.5">
        <MemoryStick size={12} className="text-faint" />
        <Skeleton className="w-20" />
      </span>
      <span className="flex items-center gap-1.5">
        <HardDrive size={12} className="text-faint" />
        <Skeleton className="w-8" />
      </span>
      <span className="hidden text-faint @md:inline">{t('Loading server stats…')}</span>
    </div>
  )
}

/** Thanh số liệu server dưới terminal SSH (MobaXterm-style). */
export function ServerStatsBar({ stats }: { stats: ServerStats }): React.JSX.Element {
  const mem = stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : 0
  const disk = stats.diskPercent
  return (
    <div
      className={BAR_CLASS}
      data-testid="server-stats"
      role="status"
      aria-label={t('Server statistics')}
    >
      <Item
        icon={<Cpu size={12} />}
        title={
          stats.cpu === null
            ? t('CPU · measuring… · load {load}', { load: formatNumber(stats.load1, 2) })
            : t('CPU · load {load}', { load: formatNumber(stats.load1, 2) })
        }
        testId="stats-cpu"
      >
        {/* CPU cần hai lần đo (chênh lệch /proc/stat) — lần đầu chỉ giữ chỗ. */}
        {stats.cpu === null ? (
          <Skeleton className="w-7" />
        ) : (
          <span className={level(stats.cpu)}>{percent(Math.round(stats.cpu))}</span>
        )}
        <Meter percent={stats.cpu ?? 0} />
      </Item>
      <Item
        icon={<MemoryStick size={12} />}
        title={t('Memory: {percent} used ({free} available)', {
          percent: percent(Math.round(mem)),
          free: formatBytes(stats.memTotal - stats.memUsed)
        })}
        testId="stats-mem"
      >
        <span className={level(mem)}>
          {formatBytes(stats.memUsed)} / {formatBytes(stats.memTotal)}
        </span>
        <Meter percent={mem} />
      </Item>
      {stats.diskTotal > 0 && (
        <Item
          icon={<HardDrive size={12} />}
          title={t('Disk /: {used} used of {total} (same % as df)', {
            used: formatBytes(stats.diskUsed),
            total: formatBytes(stats.diskTotal)
          })}
          testId="stats-disk"
        >
          <span className={level(disk)}>{percent(disk)}</span>
          <span className="hidden text-faint @lg:inline">
            {t('of {total}', { total: formatBytes(stats.diskTotal) })}
          </span>
        </Item>
      )}
      {stats.rxRate !== null && stats.txRate !== null && (
        <Item
          icon={<ArrowDown size={12} />}
          title={t('Network download / upload')}
          className="hidden @sm:flex"
        >
          <span>{formatRate(stats.rxRate)}</span>
          <ArrowUp size={12} className="text-faint" />
          <span>{formatRate(stats.txRate)}</span>
        </Item>
      )}
      <div className="flex-1" />
      <Item icon={<Clock size={12} />} title={t('Uptime')} className="hidden @md:flex">
        {t('up {time}', { time: formatDuration(stats.uptimeSeconds * 1000) })}
      </Item>
    </div>
  )
}
