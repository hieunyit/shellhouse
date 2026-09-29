import type { Client, ClientChannel } from 'ssh2'
import {
  computeStats,
  parseStatsBlock,
  STATS_END,
  STATS_MARKER,
  STATS_SCRIPT,
  type ServerStats,
  type StatsSample
} from '@shared/server-stats'

/** Output lạ (không phải Linux) mà lớn dần → dừng, không giữ bộ nhớ. */
const MAX_BUFFER = 64 * 1024

export type StatsListener = (update: { stats: ServerStats } | { unsupported: string }) => void

/**
 * Chạy vòng lặp đọc /proc trên server qua MỘT kênh exec riêng (không đụng vào shell của người
 * dùng) và báo số liệu mỗi lần đo. Server không hỗ trợ (không có /proc, không cho exec) → báo
 * `unsupported` một lần rồi thôi.
 */
export class StatsMonitor {
  private channel: ClientChannel | null = null
  private buffer = ''
  private previous: StatsSample | null = null
  private gotSample = false
  private stopped = true
  private unsupported = false

  constructor(
    private readonly client: Client,
    private readonly listener: StatsListener
  ) {}

  get running(): boolean {
    return !this.stopped
  }

  start(): void {
    if (!this.stopped || this.unsupported) return
    this.stopped = false
    this.buffer = ''
    this.previous = null
    // Script không có dấu nháy đơn (xem STATS_SCRIPT) → bọc an toàn trong '…'.
    this.client.exec(`sh -c '${STATS_SCRIPT}'`, (error, channel) => {
      if (error) {
        this.fail(`The server does not allow running commands (${error.message})`)
        return
      }
      if (this.stopped) {
        channel.close()
        return
      }
      this.channel = channel
      channel.on('data', (chunk: Buffer) => {
        this.onData(chunk.toString('utf8'))
      })
      channel.stderr.on('data', () => undefined)
      channel.on('close', () => {
        this.channel = null
        if (!this.stopped && !this.gotSample) this.fail('Server statistics need Linux (/proc)')
        this.stopped = true
      })
    })
  }

  stop(): void {
    this.stopped = true
    this.channel?.close()
    this.channel = null
  }

  private fail(reason: string): void {
    if (this.unsupported) return
    this.unsupported = true
    this.stop()
    this.listener({ unsupported: reason })
  }

  private onData(text: string): void {
    this.buffer += text
    if (this.buffer.length > MAX_BUFFER) {
      this.fail('Server statistics need Linux (/proc)')
      return
    }
    // Một lần đo = nội dung giữa dấu mốc đầu và dấu mốc cuối.
    for (;;) {
      const end = this.buffer.indexOf(STATS_END)
      if (end === -1) return
      const start = this.buffer.lastIndexOf(STATS_MARKER, end)
      const block = start === -1 ? '' : this.buffer.slice(start + STATS_MARKER.length, end)
      this.buffer = this.buffer.slice(end + STATS_END.length)
      const sample = parseStatsBlock(block)
      if (!sample) {
        if (!this.gotSample) this.fail('Server statistics need Linux (/proc)')
        continue
      }
      this.gotSample = true
      this.listener({ stats: computeStats(sample, this.previous) })
      this.previous = sample
    }
  }
}
