import { t } from '@shared/i18n'
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
  /**
   * Tăng mỗi lần start/stop: callback exec / 'close' của lượt chạy CŨ (đến muộn, bất đồng bộ) không
   * được đụng vào kênh / trạng thái của lượt mới (start → stop → start nhanh làm rò kênh, chạm
   * MaxSessions của server).
   */
  private generation = 0

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
    const generation = ++this.generation
    const current = (): boolean => generation === this.generation && !this.stopped
    // Script không có dấu nháy đơn (xem STATS_SCRIPT) → bọc an toàn trong '…'.
    this.client.exec(`sh -c '${STATS_SCRIPT}'`, (error, channel) => {
      if (error) {
        if (current())
          this.fail(
            t('The server does not allow running commands ({error})', { error: error.message })
          )
        return
      }
      if (!current()) {
        channel.close()
        return
      }
      this.channel = channel
      channel.on('data', (chunk: Buffer) => {
        if (current()) this.onData(chunk.toString('utf8'))
      })
      channel.stderr.on('data', () => undefined)
      channel.on('close', () => {
        if (!current()) return
        this.channel = null
        if (!this.gotSample) this.fail(t('Server statistics need Linux (/proc)'))
        this.stopped = true
      })
    })
  }

  stop(): void {
    this.stopped = true
    this.generation++
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
      this.fail(t('Server statistics need Linux (/proc)'))
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
        if (!this.gotSample) {
          this.fail(t('Server statistics need Linux (/proc)'))
          return
        }
        continue
      }
      this.gotSample = true
      this.listener({ stats: computeStats(sample, this.previous) })
      this.previous = sample
    }
  }
}
