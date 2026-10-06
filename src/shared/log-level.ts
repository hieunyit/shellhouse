/**
 * Mức của một dòng log (tô màu, lọc nhanh trong trình xem log): error / warn / không rõ. Nhận các
 * định dạng hay gặp — chữ hoa ERROR / WARN, logfmt `level=error`, JSON `"level":"warn"`, klog
 * (`E1006 …`, `W1006 …`), zap / logrus (`\terror\t`, `[error]`, `error:` đầu dòng), Python
 * `Traceback`, Java `…Exception:`. Chữ "error" thường giữa câu ("no error") không tính.
 */
export type LogLevel = 'error' | 'warn'

/** Từ khoá viết HOA đứng riêng: ERROR, FATAL, PANIC, CRITICAL, SEVERE… */
const ERROR_UPPER =
  /(?:^|[^A-Za-z0-9_])(?:ERROR|ERR|FATAL|PANIC|CRIT|CRITICAL|SEVERE|EMERG|ALERT)(?![A-Za-z0-9_])/
const WARN_UPPER = /(?:^|[^A-Za-z0-9_])(?:WARN|WARNING)(?![A-Za-z0-9_])/
/** logfmt / JSON / key=value: level=error, "severity":"ERROR", lvl: warn… */
const ERROR_KV =
  /\b(?:level|lvl|severity|loglevel)"?\s*[=:]\s*"?(?:error|err|fatal|panic|crit|critical|emerg|alert)\b/i
const WARN_KV = /\b(?:level|lvl|severity|loglevel)"?\s*[=:]\s*"?(?:warn|warning)\b/i
/** klog / glog: "E1006 12:00:00.000000 …" */
const KLOG_ERROR = /^[EF]\d{4} \d{2}:\d{2}:\d{2}/
const KLOG_WARN = /^W\d{4} \d{2}:\d{2}:\d{2}/
/** Từ khoá thường có ngăn cách rõ: "\terror\t", "[error]", "<error>", "error:" (sau thời gian / đầu dòng). */
const ERROR_TOKEN = /(?:^|[\t[<(|]|\s{2})(?:error|err|fatal|panic)(?:[\t\]>)|:]|\s{2}|$)/
const WARN_TOKEN = /(?:^|[\t[<(|]|\s{2})(?:warn|warning)(?:[\t\]>)|:]|\s{2}|$)/
/** Stack trace: Python, Java / .NET, Go panic. */
const TRACE =
  /^(?:Traceback \(most recent call last\)|panic: |goroutine \d+ \[|\s*at [\w$.<>]+\(.*\)$)|(?:^|\s)(?:[a-z_]\w*\.)*[A-Z]\w*(?:Exception|Error):\s/

/** Tiền tố nguồn của log gộp ("[pod/container] ") — bỏ trước khi xét (tránh nhầm tên nguồn). */
const SOURCE_PREFIX = /^\[([^\]\n]{1,160})\] /
/** "[error] …", "[WARN] …" là mức log, không phải tên nguồn. */
const LEVEL_WORD = /^(?:error|err|fatal|panic|crit|critical|warn|warning|info|debug|trace)$/i

export function logLevel(line: string): LogLevel | null {
  const prefix = SOURCE_PREFIX.exec(line)
  const text = prefix && !LEVEL_WORD.test(prefix[1] ?? '') ? line.slice(prefix[0].length) : line
  if (!text) return null
  if (
    KLOG_ERROR.test(text) ||
    ERROR_KV.test(text) ||
    ERROR_UPPER.test(text) ||
    ERROR_TOKEN.test(text) ||
    TRACE.test(text)
  )
    return 'error'
  if (KLOG_WARN.test(text) || WARN_KV.test(text) || WARN_UPPER.test(text) || WARN_TOKEN.test(text))
    return 'warn'
  return null
}

/**
 * Ô tìm của trình xem log → hàm khớp + biểu thức để tô sáng. Regex: không phân biệt hoa thường;
 * sai cú pháp → `error` (giao diện báo, không lọc). Chuỗi thường: tìm nguyên văn, không phân biệt
 * hoa thường.
 */
export function logMatcher(
  query: string,
  regex: boolean
): { test: (line: string) => boolean; highlight: RegExp | null; error: string | null } {
  const q = regex ? query : query.trim()
  if (!q) return { test: () => true, highlight: null, error: null }
  let re: RegExp
  try {
    re = regex ? new RegExp(q, 'gi') : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  } catch (e) {
    return {
      test: () => true,
      highlight: null,
      error: e instanceof Error ? e.message : String(e)
    }
  }
  const one = new RegExp(re.source, 'i')
  return { test: (line) => one.test(line), highlight: re, error: null }
}

/** Cắt dòng thành đoạn thường / đoạn khớp (tô sáng). Regex khớp chuỗi rỗng không tạo đoạn. */
export function splitMatches(text: string, re: RegExp): { text: string; match: boolean }[] {
  const out: { text: string; match: boolean }[] = []
  let last = 0
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') {
      re.lastIndex++
      continue
    }
    if (m.index > last) out.push({ text: text.slice(last, m.index), match: false })
    out.push({ text: m[0], match: true })
    last = m.index + m[0].length
    // Dòng rất dài nhiều chỗ khớp: tối đa 200 đoạn tô sáng.
    if (out.length > 400) break
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false })
  return out
}
