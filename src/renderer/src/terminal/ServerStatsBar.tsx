import { ArrowDown, ArrowUp, Clock, Cpu, HardDrive, MemoryStick } from 'lucide-react'
import type { ServerStats } from '@shared/server-stats'
import { cx } from '../components/ui'

function bytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`
  if (n < 1000 * 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${(n / 1024 ** 4).toFixed(1)} TB`
}

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** ≥ 90%: đỏ, ≥ 75%: vàng — dễ thấy server sắp đầy. */
function level(percent: number): string {
  return percent >= 90 ? 'text-danger' : percent >= 75 ? 'text-warning' : 'text-muted'
}

function Meter({ percent }: { percent: number }): React.JSX.Element {
  return (
    <span className="relative hidden h-1.5 w-10 overflow-hidden rounded-full bg-subtle @md:inline-block">
      <span
        className={cx(
          'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500',
          percent >= 90 ? 'bg-danger' : percent >= 75 ? 'bg-warning' : 'bg-accent'
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

/** Thanh số liệu server dưới terminal SSH (MobaXterm-style). */
export function ServerStatsBar({ stats }: { stats: ServerStats }): React.JSX.Element {
  const mem = stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : 0
  const disk = stats.diskPercent
  return (
    <div
      className="@container flex h-6 shrink-0 items-center gap-4 overflow-hidden border-t border-line bg-surface px-3 text-xs whitespace-nowrap text-muted tabular-nums"
      data-testid="server-stats"
      role="status"
      aria-label="Server statistics"
    >
      <Item
        icon={<Cpu size={12} />}
        title={`CPU · load ${stats.load1.toFixed(2)}`}
        testId="stats-cpu"
      >
        <span className={level(stats.cpu ?? 0)}>
          {stats.cpu === null ? '…' : `${Math.round(stats.cpu)}%`}
        </span>
        <Meter percent={stats.cpu ?? 0} />
      </Item>
      <Item
        icon={<MemoryStick size={12} />}
        title={`Memory: ${Math.round(mem)}% used (${bytes(stats.memTotal - stats.memUsed)} available)`}
        testId="stats-mem"
      >
        <span className={level(mem)}>
          {bytes(stats.memUsed)} / {bytes(stats.memTotal)}
        </span>
        <Meter percent={mem} />
      </Item>
      {stats.diskTotal > 0 && (
        <Item
          icon={<HardDrive size={12} />}
          title={`Disk /: ${bytes(stats.diskUsed)} used of ${bytes(stats.diskTotal)} (same % as df)`}
          testId="stats-disk"
        >
          <span className={level(disk)}>{disk}%</span>
          <span className="hidden text-faint @lg:inline">of {bytes(stats.diskTotal)}</span>
        </Item>
      )}
      {stats.rxRate !== null && stats.txRate !== null && (
        <Item
          icon={<ArrowDown size={12} />}
          title="Network download / upload"
          className="hidden @sm:flex"
        >
          <span>{bytes(stats.rxRate)}/s</span>
          <ArrowUp size={12} className="text-faint" />
          <span>{bytes(stats.txRate)}/s</span>
        </Item>
      )}
      <div className="flex-1" />
      <Item icon={<Clock size={12} />} title="Uptime" className="hidden @md:flex">
        up {uptime(stats.uptimeSeconds)}
      </Item>
    </div>
  )
}
