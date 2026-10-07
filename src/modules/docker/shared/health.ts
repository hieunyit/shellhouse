/**
 * Health check của container (State.Health + Config.Healthcheck trong inspect) → tóm tắt gọn cho
 * bảng chi tiết: lệnh kiểm tra, nhịp, số lần gần đây đạt, lần lỗi gần nhất. Output được làm sạch
 * (thanh tiến trình của curl / wget chiếm gần hết output mà không nói gì). Thuần — renderer và test.
 */

type Obj = Record<string, unknown>
const o = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {}
const s = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

export interface HealthRun {
  /** ms */
  at: number
  exitCode: number
  /** Output đã làm sạch ('' nếu không có gì đáng đọc). */
  output: string
}

export interface HealthSummary {
  status: string
  /** Lệnh kiểm tra (bỏ tiền tố CMD / CMD-SHELL). */
  command: string
  /** Nhịp, hết giờ (ms) và số lần lỗi liên tiếp thì thành unhealthy (Docker mặc định 30s / 30s / 3). */
  intervalMs: number
  timeoutMs: number
  retries: number
  failingStreak: number
  /** Mới nhất trước. */
  runs: HealthRun[]
  /** Lần kiểm tra lỗi gần nhất trong log (nếu có). */
  lastFailure: HealthRun | null
}

const NS_PER_MS = 1_000_000
const time = '(?:--:--:--|\\d+:\\d{2}:\\d{2})'
const num = '\\d+(?:\\.\\d+)?[kKMGT]?'
/** Một dòng số liệu của thanh tiến trình curl: các cột số, ba cột thời gian, tốc độ hiện tại. */
const CURL_ROW = new RegExp(`(?:${num}\\s+)*${time}\\s+${time}\\s+${time}\\s+${num}`, 'g')
/** Tiêu đề thanh tiến trình curl. */
const CURL_HEAD = /%\s*Total\s+%\s*Received|^\s*Dload\s+Upload/

/** Bỏ thanh tiến trình curl / wget, dòng trống; gộp khoảng trắng thừa. */
export function cleanHealthOutput(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => !CURL_HEAD.test(line))
    .map((line) =>
      line
        .replace(CURL_ROW, ' ')
        // wget: "Connecting to …", thanh "100% |****| 69 0:00:00 ETA"
        .replace(/^\s*Connecting to \S+.*$/, '')
        .replace(/\s*\d+%\s*\|[*\s]*\|.*$/, '')
        .trim()
    )
    .filter(Boolean)
    .join('\n')
}

/** Lệnh của Healthcheck.Test: ["CMD-SHELL", "curl -f …"] / ["CMD", "a", "b"] → chuỗi. */
export function healthCommand(test: unknown): string {
  if (!Array.isArray(test)) return ''
  const parts = test.map((x) => s(x))
  if (parts[0] === 'CMD-SHELL') return parts.slice(1).join(' ')
  if (parts[0] === 'CMD') return parts.slice(1).join(' ')
  if (parts[0] === 'NONE') return ''
  return parts.join(' ')
}

export function healthSummary(inspect: Obj | null): HealthSummary | null {
  const state = o(inspect?.['State'])
  const health = o(state['Health'])
  const status = s(health['Status'])
  if (!status) return null
  const check = o(o(inspect?.['Config'])['Healthcheck'])
  const runs: HealthRun[] = ((health['Log'] as unknown[] | null | undefined) ?? [])
    .map((l) => {
      const x = o(l)
      return {
        at: Date.parse(s(x['Start'])) || 0,
        exitCode: Number(x['ExitCode'] ?? 0),
        output: cleanHealthOutput(s(x['Output']))
      }
    })
    .sort((a, b) => b.at - a.at)
  const nanos = (v: unknown, fallback: number): number =>
    typeof v === 'number' && v > 0 ? v / NS_PER_MS : fallback
  return {
    status,
    command: healthCommand(check['Test']),
    intervalMs: nanos(check['Interval'], 30_000),
    timeoutMs: nanos(check['Timeout'], 30_000),
    retries: typeof check['Retries'] === 'number' && check['Retries'] > 0 ? check['Retries'] : 3,
    failingStreak: Number(health['FailingStreak'] ?? 0),
    runs,
    lastFailure: runs.find((r) => r.exitCode !== 0) ?? null
  }
}

/** Tốc độ mạng (byte/s) giữa hai mẫu liên tiếp; mẫu đầu / bộ đếm lùi (container khởi động lại) → 0. */
export function netRates(
  samples: readonly { at: number; netRx: number; netTx: number }[]
): { rx: number; tx: number }[] {
  return samples.map((cur, i) => {
    const prev = samples[i - 1]
    const dt = prev ? (cur.at - prev.at) / 1000 : 0
    if (!prev || dt <= 0) return { rx: 0, tx: 0 }
    return {
      rx: Math.max(0, (cur.netRx - prev.netRx) / dt),
      tx: Math.max(0, (cur.netTx - prev.netTx) / dt)
    }
  })
}
