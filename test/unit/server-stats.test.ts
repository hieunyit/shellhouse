import { describe, expect, it } from 'vitest'
import { computeStats, parseStatsBlock, STATS_SCRIPT } from '@shared/server-stats'

// Output thật của script trên Ubuntu 24.04 (rút gọn /proc/net/dev).
const block = (cpu: string, uptime: string, rx: number, tx: number): string => `
${cpu}
MemTotal:        4028232 kB
MemAvailable:    2911816 kB
${uptime} 12345.67
0.42 0.30 0.21 1/187 4242
/dev/sda1         30298176 12119271 16609512      43% /
    lo: 9999999    100    0    0    0     0          0         0  9999999    100    0    0    0     0       0          0
  eth0: ${rx}   2000    0    0    0     0          0         0  ${tx}   1500    0    0    0     0       0          0
`

describe('server stats', () => {
  it("script chạy được trong sh -c '…' (không có dấu nháy đơn)", () => {
    expect(STATS_SCRIPT).not.toContain("'")
  })

  it('đọc một lần đo: RAM, ổ đĩa, uptime, load; bỏ loopback', () => {
    const s = parseStatsBlock(block('cpu  100 0 50 800 50 0 0 0 0 0', '1000.00', 5000, 3000))
    expect(s).toEqual({
      cpuBusy: 150,
      cpuTotal: 1000,
      memUsed: (4028232 - 2911816) * 1024,
      memTotal: 4028232 * 1024,
      diskUsed: 12119271 * 1024,
      diskTotal: 30298176 * 1024,
      diskAvail: 16609512 * 1024,
      rxBytes: 5000,
      txBytes: 3000,
      uptimeSeconds: 1000,
      load1: 0.42
    })
  })

  it('CPU % và tốc độ mạng từ hai lần đo; lần đầu chưa có', () => {
    const a = parseStatsBlock(block('cpu  100 0 50 800 50 0 0 0', '1000.00', 5000, 3000))
    const b = parseStatsBlock(block('cpu  400 0 50 1000 50 0 0 0', '1003.00', 35_000, 6000))
    if (!a || !b) throw new Error('parse failed')
    expect(computeStats(a, null)).toMatchObject({ cpu: null, rxRate: null, txRate: null })
    const stats = computeStats(b, a)
    expect(stats.cpu).toBeCloseTo(60) // bận +300 trên tổng +500
    expect(stats.rxRate).toBe(10_000)
    expect(stats.txRate).toBe(1000)
    // Như `df`: 12119271 / (12119271 + 16609512) = 42,2% → 43% (làm tròn lên).
    expect(stats.diskPercent).toBe(43)
  })

  it('bộ đếm mạng quay về 0 → không báo số âm', () => {
    const a = parseStatsBlock(block('cpu  1 0 1 1 0 0 0 0', '10', 9_000_000, 9_000_000))
    const b = parseStatsBlock(block('cpu  2 0 1 2 0 0 0 0', '13', 100, 100))
    if (!a || !b) throw new Error('parse failed')
    expect(computeStats(b, a).rxRate).toBe(0)
  })

  it('output không phải Linux → null', () => {
    expect(parseStatsBlock('head: /proc/stat: No such file or directory')).toBeNull()
    expect(parseStatsBlock('')).toBeNull()
  })
})
