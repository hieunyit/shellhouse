/**
 * Thanh theo dõi server (như MobaXterm): CPU, RAM, ổ đĩa `/`, mạng, uptime, load. Số liệu lấy từ
 * /proc qua một kênh exec riêng — chỉ Linux; server khác (BSD, thiết bị mạng) thì ẩn thanh.
 */

export interface ServerStats {
  /** % CPU dùng trong khoảng giữa hai lần đo; null ở lần đo đầu. */
  cpu: number | null
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  /** % như cột Use% của `df`: đã dùng / (đã dùng + còn trống), làm tròn lên (không tính phần dành cho root). */
  diskPercent: number
  /** Byte/giây (mọi card mạng trừ loopback); null ở lần đo đầu. */
  rxRate: number | null
  txRate: number | null
  uptimeSeconds: number
  load1: number
}

/** Một lần đo thô (số đếm tích luỹ — cần hai lần đo để ra tốc độ). */
export interface StatsSample {
  cpuBusy: number
  cpuTotal: number
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  diskAvail: number
  rxBytes: number
  txBytes: number
  uptimeSeconds: number
  load1: number
}

export const STATS_MARKER = '--SHELLHOUSE-STATS--'
export const STATS_END = '--SHELLHOUSE-STATS-END--'
export const STATS_INTERVAL_SECONDS = 3

/**
 * Chạy trong `sh -c '…'` (shell đăng nhập có thể là fish/csh) — script KHÔNG được chứa dấu `'`.
 * `exec` + vòng lặp: một kênh cho cả phiên, không mở kênh mới mỗi lần đo.
 */
export const STATS_SCRIPT = [
  'export LC_ALL=C',
  'while :; do',
  `echo ${STATS_MARKER}`,
  'head -n 1 /proc/stat',
  'grep -E "^(MemTotal|MemAvailable):" /proc/meminfo',
  'cat /proc/uptime /proc/loadavg',
  'df -Pk / | tail -n 1',
  'tail -n +3 /proc/net/dev',
  `echo ${STATS_END}`,
  `sleep ${STATS_INTERVAL_SECONDS}`,
  'done'
].join('\n')

const num = (s: string | undefined): number => {
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** Phân tích một khối output (giữa hai dấu mốc). Thiếu phần bắt buộc → null. */
export function parseStatsBlock(block: string): StatsSample | null {
  const lines = block.split('\n').map((l) => l.trim())
  let cpuBusy = NaN
  let cpuTotal = NaN
  let memTotal = NaN
  let memAvailable = NaN
  let uptimeSeconds = NaN
  let load1 = NaN
  let diskUsed = NaN
  let diskTotal = NaN
  let diskAvail = NaN
  let rxBytes = 0
  let txBytes = 0
  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (parts[0] === 'cpu') {
      // user nice system idle iowait irq softirq steal …
      const v = parts.slice(1, 9).map(num)
      if (v.some((x) => Number.isNaN(x))) continue
      const idle = (v[3] ?? 0) + (v[4] ?? 0)
      cpuTotal = v.reduce((a, b) => a + b, 0)
      cpuBusy = cpuTotal - idle
    } else if (parts[0] === 'MemTotal:') memTotal = num(parts[1]) * 1024
    else if (parts[0] === 'MemAvailable:') memAvailable = num(parts[1]) * 1024
    else if (
      /^\d+(\.\d+)?$/.test(parts[0] ?? '') &&
      parts.length === 2 &&
      Number.isNaN(uptimeSeconds)
    )
      uptimeSeconds = num(parts[0])
    else if (/^\d+(\.\d+)?$/.test(parts[0] ?? '') && parts.length === 5) load1 = num(parts[0])
    else if (parts.length >= 6 && parts[5] === '/' && /^\d+$/.test(parts[1] ?? '')) {
      diskTotal = num(parts[1]) * 1024
      diskUsed = num(parts[2]) * 1024
      diskAvail = num(parts[3]) * 1024
    } else if (line.includes(':')) {
      // /proc/net/dev: "eth0: rxBytes … (8 cột rx) txBytes …"
      const [name, rest] = line.split(':', 2) as [string, string | undefined]
      if (name.trim() === 'lo' || rest === undefined) continue
      const v = rest.trim().split(/\s+/).map(num)
      if (v.length >= 9 && !Number.isNaN(v[0]) && !Number.isNaN(v[8])) {
        rxBytes += v[0] ?? 0
        txBytes += v[8] ?? 0
      }
    }
  }
  const memUsed = memTotal - memAvailable
  const required = [cpuBusy, cpuTotal, memTotal, memAvailable, uptimeSeconds]
  if (required.some((x) => Number.isNaN(x))) return null
  return {
    cpuBusy,
    cpuTotal,
    memUsed,
    memTotal,
    diskUsed: Number.isNaN(diskUsed) ? 0 : diskUsed,
    diskTotal: Number.isNaN(diskTotal) ? 0 : diskTotal,
    diskAvail: Number.isNaN(diskAvail) ? 0 : diskAvail,
    rxBytes,
    txBytes,
    uptimeSeconds,
    load1: Number.isNaN(load1) ? 0 : load1
  }
}

/** Số liệu hiển thị từ lần đo hiện tại và lần trước (nếu có). */
export function computeStats(current: StatsSample, previous: StatsSample | null): ServerStats {
  let cpu: number | null = null
  let rxRate: number | null = null
  let txRate: number | null = null
  if (previous) {
    const total = current.cpuTotal - previous.cpuTotal
    const busy = current.cpuBusy - previous.cpuBusy
    if (total > 0) cpu = Math.min(100, Math.max(0, (busy / total) * 100))
    const seconds = current.uptimeSeconds - previous.uptimeSeconds
    if (seconds > 0) {
      // Bộ đếm có thể quay về 0 (card mạng khởi động lại) → không báo số âm.
      rxRate = Math.max(0, (current.rxBytes - previous.rxBytes) / seconds)
      txRate = Math.max(0, (current.txBytes - previous.txBytes) / seconds)
    }
  }
  return {
    cpu,
    memUsed: current.memUsed,
    memTotal: current.memTotal,
    diskUsed: current.diskUsed,
    diskTotal: current.diskTotal,
    diskPercent:
      current.diskUsed + current.diskAvail > 0
        ? Math.ceil((current.diskUsed * 100) / (current.diskUsed + current.diskAvail))
        : 0,
    rxRate,
    txRate,
    uptimeSeconds: current.uptimeSeconds,
    load1: current.load1
  }
}
