import type { Db } from './store/db'

/** Mỗi đích giữ tối đa chừng này lệnh (cũ nhất bị xoá). */
export const MAX_COMMANDS_PER_TARGET = 2000
export const MAX_COMMAND_LENGTH = 1000
const PRUNE_SLACK = 100

/**
 * Mẫu lệnh thường chứa bí mật ngay trên dòng lệnh. Lịch sử lưu không mã hoá trong DB → lệnh khớp
 * thì không lưu (thà mất một gợi ý còn hơn lộ mật khẩu).
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // --password=…, --password …, --token …, --secret-key=… (không bắt --password-stdin)
  /(?:^|\s)--(?:passw(?:or)?d|pass|token|secret|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret)(?:=|\s+)\S/i,
  // mysql -pXXX / mysqldump --user=x -pXXX (dính liền: -p rời là hỏi mật khẩu, không lộ gì)
  /\b(?:mysql|mariadb|mysqldump|mysqladmin|mariadb-dump)\b.*\s-p\S/,
  // sshpass -p XXX, docker/podman/helm login -p XXX
  /\bsshpass\b.*\s-p\s*\S/,
  /\b(?:docker|podman|helm|nerdctl)\b.*\blogin\b.*\s-p\s*\S/,
  // Authorization: Bearer …, X-Api-Key: … trong curl / httpie
  /\bauthorization\s*:\s*\S/i,
  /\bx-(?:api-key|auth-token|access-token)\s*:\s*\S/i,
  // curl -u user:pass
  /\bcurl\b.*\s(?:-u|--user)\s*['"]?[^\s:'"]+:[^\s'"]/,
  // URL có mật khẩu: scheme://user:pass@host
  /\b[a-z][\w+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i
]

/** Từ (trọn) trong tên biến cho thấy giá trị là bí mật. */
const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'pass',
  'pwd',
  'token',
  'secret',
  'credential',
  'credentials',
  'apikey',
  'accesskey',
  'privatekey'
])
/** Đuôi dính liền vẫn tính (PGPASSWORD, GHTOKEN, CLIENTSECRET) — không gồm "pass" (bypass). */
const SECRET_SUFFIX = /(?:password|passwd|token|secret)$/
/** Cặp từ: API_KEY, ACCESS_KEY, PRIVATE_KEY, SECRET_KEY. */
const SECRET_PAIRS = new Set(['api key', 'access key', 'private key', 'secret key'])
/**
 * Từ cuối cho thấy giá trị KHÔNG phải bí mật: POSTGRES_PASSWORD_FILE=/run/secrets/…,
 * TOKEN_PATH=…, `ssh -o PasswordAuthentication=no`.
 */
const NOT_SECRET_LAST = new Set(['file', 'path', 'dir', 'authentication'])
/** Lệnh tìm chuỗi: `grep -r api_key=foo .` là mẫu cần tìm, không phải gán bí mật. */
const SEARCH_COMMAND = /^\s*(?:sudo\s+)?(?:grep|egrep|fgrep|zgrep|rg|ag|ack|git\s+grep)\b/

/** Tên biến / tuỳ chọn (PASSWORD, db-pass, PasswordAuthentication…) có vẻ chứa bí mật không. */
function secretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_.-]+/)
    .filter(Boolean)
  const last = words[words.length - 1]
  if (!last || NOT_SECRET_LAST.has(last)) return false
  return words.some(
    (w, i) =>
      SECRET_WORDS.has(w) ||
      SECRET_SUFFIX.test(w) ||
      (i > 0 && SECRET_PAIRS.has(`${words[i - 1] ?? ''} ${w}`))
  )
}

/** Lệnh có vẻ chứa mật khẩu / token — không lưu vào lịch sử. */
export function looksSecret(command: string): boolean {
  // PASSWORD=…, DB_PASS=…, GITHUB_TOKEN=…, AWS_SECRET_ACCESS_KEY=…, export API_KEY=…
  if (!SEARCH_COMMAND.test(command))
    for (const m of command.matchAll(/(?:^|[\s;&|('"])-{0,2}([A-Za-z_][\w.-]*)=\S/g))
      if (secretName(m[1] ?? '')) return true
  return SECRET_PATTERNS.some((p) => p.test(command))
}

/**
 * Lịch sử lệnh theo đích kết nối — nguồn cho gợi ý lệnh khi gõ. Chỉ lệnh người dùng đã gõ và
 * hiện trên màn hình (mật khẩu gõ vào lời nhắc không hiện nên không vào đây; mật khẩu viết thẳng
 * trên dòng lệnh bị `looksSecret` lọc).
 */
export class CommandHistory {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  /** Lệnh gần đây nhất trước (dùng lại nhiều lần cũng chỉ một dòng). */
  list(target: string, limit = 1000): string[] {
    const rows = this.db
      .prepare('SELECT command FROM command_history WHERE target = ? ORDER BY used_at DESC LIMIT ?')
      .all(target, limit) as { command: string }[]
    return rows.map((r) => r.command)
  }

  record(target: string, command: string): void {
    const text = command.trim()
    if (!text || text.length > MAX_COMMAND_LENGTH || /[\r\n\0]/.test(text)) return
    if (looksSecret(text)) return
    this.db
      .prepare(
        `INSERT INTO command_history (target, command, count, used_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (target, command) DO UPDATE SET count = count + 1, used_at = excluded.used_at`
      )
      .run(target, text, this.now())
    // Dọn theo đợt (vượt quá 100 lệnh mới dọn) — không quét lại cả bảng mỗi lần gõ lệnh.
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM command_history WHERE target = ?')
      .get(target) as { n: number }
    if (n <= MAX_COMMANDS_PER_TARGET + PRUNE_SLACK) return
    this.db
      .prepare(
        `DELETE FROM command_history WHERE target = ? AND command NOT IN (
           SELECT command FROM command_history WHERE target = ? ORDER BY used_at DESC LIMIT ?
         )`
      )
      .run(target, target, MAX_COMMANDS_PER_TARGET)
  }

  /** Xoá lịch sử của một đích, hoặc tất cả (target = null). */
  clear(target: string | null): void {
    if (target === null) this.db.prepare('DELETE FROM command_history').run()
    else this.db.prepare('DELETE FROM command_history WHERE target = ?').run(target)
  }
}
