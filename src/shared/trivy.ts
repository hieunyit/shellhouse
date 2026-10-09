import { z } from 'zod'
import { t } from './i18n'

/**
 * Kết quả quét của Trivy (`trivy image` / `trivy config` với `--format json`) rút gọn cho giao diện.
 * Shellhouse không tự quét: chỉ gọi `trivy` có sẵn trên máy rồi đọc JSON của nó. Đọc dễ dãi (dữ liệu
 * từ chương trình ngoài, đổi theo phiên bản): trường lạ bỏ qua, trường thiếu thì để trống.
 */
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const
export type Severity = (typeof SEVERITIES)[number]

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  UNKNOWN: 4
}

export const severityRank = (s: Severity): number => SEVERITY_RANK[s]

/** Một phát hiện: lỗ hổng của một gói (image) hoặc một luật cấu hình bị vi phạm (manifest). */
export interface ScanFinding {
  kind: 'vulnerability' | 'misconfiguration'
  /** CVE-2024-… hoặc mã luật (KSV014). */
  id: string
  severity: Severity
  /** Gói (lỗ hổng) hoặc mục đích của luật (cấu hình). */
  subject: string
  /** Phiên bản đang cài (lỗ hổng). */
  installed?: string
  /** Phiên bản đã sửa (lỗ hổng) — thiếu = chưa có bản sửa. */
  fixed?: string
  title: string
  /** Gợi ý khắc phục (cấu hình). */
  resolution?: string
  /** Vị trí trong YAML (cấu hình). */
  line?: number
  url?: string
  /** Mục của kết quả (lớp OS / ngôn ngữ, hoặc tên tệp). */
  target: string
}

export interface ScanResult {
  /** Đích đã quét (tên image, hoặc "Deployment shop/web"). */
  target: string
  /** Phiên bản Trivy, nếu hỏi được. */
  version?: string
  /** Số lượng theo mức độ (trước khi cắt bớt). */
  summary: Record<Severity, number>
  /** Đã xếp theo mức độ rồi tới tên; có thể bị cắt (xem `truncated`). */
  findings: ScanFinding[]
  /** Có bản ghi bị bỏ vì quá nhiều. */
  truncated: boolean
  /** Hệ điều hành của image (Alpine 3.20…) — nếu Trivy nhận ra. */
  os?: string
  /** Bao nhiêu phát hiện đã có bản sửa. */
  fixable: number
  at: number
}

/** Giữ tối đa chừng này dòng gửi sang giao diện (image lớn có thể hàng nghìn CVE). */
export const MAX_FINDINGS = 3000

const Str = z.string().catch('')
const OptStr = z.string().optional().catch(undefined)

const Vulnerability = z.object({
  VulnerabilityID: Str,
  PkgName: Str,
  InstalledVersion: OptStr,
  FixedVersion: OptStr,
  Severity: Str,
  Title: OptStr,
  Description: OptStr,
  PrimaryURL: OptStr
})

const Misconfiguration = z.object({
  ID: Str,
  AVDID: OptStr,
  Title: OptStr,
  Message: OptStr,
  Description: OptStr,
  Resolution: OptStr,
  Severity: Str,
  Status: OptStr,
  PrimaryURL: OptStr,
  CauseMetadata: z
    .object({ StartLine: z.number().optional().catch(undefined) })
    .optional()
    .catch(undefined)
})

const TrivyResult = z.object({
  Target: Str,
  Vulnerabilities: z.array(z.unknown()).optional().catch(undefined),
  Misconfigurations: z.array(z.unknown()).optional().catch(undefined)
})

const TrivyReport = z.object({
  ArtifactName: OptStr,
  Metadata: z
    .object({
      OS: z.object({ Family: OptStr, Name: OptStr }).optional().catch(undefined)
    })
    .optional()
    .catch(undefined),
  Results: z.array(z.unknown()).optional().catch(undefined)
})

function severityOf(raw: string): Severity {
  const up = raw.toUpperCase()
  return (SEVERITIES as readonly string[]).includes(up) ? (up as Severity) : 'UNKNOWN'
}

function emptySummary(): Record<Severity, number> {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 }
}

/** Dòng đầu của tiêu đề / mô tả, gọn lại (Trivy hay trả cả đoạn dài). */
function oneLine(text: string | undefined, max = 200): string {
  const line = (text ?? '').split('\n')[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Đọc JSON của Trivy → kết quả gọn. Không phải JSON / không giống báo cáo của Trivy → lỗi rõ ràng
 * (kèm đoạn đầu của nội dung để người dùng thấy Trivy đã nói gì).
 */
export function parseTrivyReport(
  stdout: string,
  fallbackTarget: string,
  at: number = Date.now(),
  /** true = dùng đúng `fallbackTarget` (Trivy ghi đường dẫn thư mục tạm làm tên đích). */
  forceTarget = false
): ScanResult {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    const head = stdout.trim().slice(0, 300)
    throw new Error(`Trivy did not return a JSON report${head ? `: ${head}` : ''}`)
  }
  const report = TrivyReport.safeParse(raw)
  if (
    !report.success ||
    (report.data.Results === undefined && report.data.ArtifactName === undefined)
  )
    throw new Error('This does not look like a Trivy report')
  const summary = emptySummary()
  const all: ScanFinding[] = []
  for (const r of report.data.Results ?? []) {
    const result = TrivyResult.safeParse(r)
    if (!result.success) continue
    const target = result.data.Target
    for (const v of result.data.Vulnerabilities ?? []) {
      const p = Vulnerability.safeParse(v)
      if (!p.success || !p.data.VulnerabilityID) continue
      const severity = severityOf(p.data.Severity)
      summary[severity]++
      all.push({
        kind: 'vulnerability',
        id: p.data.VulnerabilityID,
        severity,
        subject: p.data.PkgName,
        ...(p.data.InstalledVersion ? { installed: p.data.InstalledVersion } : {}),
        ...(p.data.FixedVersion ? { fixed: p.data.FixedVersion } : {}),
        title: oneLine(p.data.Title ?? p.data.Description),
        ...(p.data.PrimaryURL ? { url: p.data.PrimaryURL } : {}),
        target
      })
    }
    for (const m of result.data.Misconfigurations ?? []) {
      const p = Misconfiguration.safeParse(m)
      // Luật đã đạt (PASS) không phải phát hiện.
      if (!p.success || (p.data.Status && p.data.Status !== 'FAIL')) continue
      const severity = severityOf(p.data.Severity)
      summary[severity]++
      const line = p.data.CauseMetadata?.StartLine
      all.push({
        kind: 'misconfiguration',
        id: p.data.AVDID ?? p.data.ID,
        severity,
        subject: oneLine(p.data.Title),
        title: oneLine(p.data.Message ?? p.data.Description),
        ...(p.data.Resolution ? { resolution: oneLine(p.data.Resolution, 300) } : {}),
        ...(line ? { line } : {}),
        ...(p.data.PrimaryURL ? { url: p.data.PrimaryURL } : {}),
        target
      })
    }
  }
  all.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.subject.localeCompare(b.subject) ||
      a.id.localeCompare(b.id)
  )
  const os = report.data.Metadata?.OS
  const osText = [os?.Family, os?.Name].filter(Boolean).join(' ')
  return {
    target: forceTarget ? fallbackTarget : report.data.ArtifactName || fallbackTarget,
    summary,
    findings: all.slice(0, MAX_FINDINGS),
    truncated: all.length > MAX_FINDINGS,
    ...(osText ? { os: osText } : {}),
    fixable: all.filter((f) => f.fixed).length,
    at
  }
}

/** Trivy bản mới tải CSDL lỗ hổng lần đầu (vài chục MB) — cho nhiều thời gian. */
export const SCAN_TIMEOUT_MS = 11 * 60_000

/** Kết quả JSON có thể lớn (image nhiều gói) — nới giới hạn mặc định 16 MB của exec. */
export const SCAN_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** `trivy image` đọc image từ Docker trên máy chạy Trivy; chỉ lỗ hổng gói (không quét bí mật / giấy phép). */
export function imageScanArgs(ref: string): string[] {
  return [
    'image',
    '--quiet',
    '--no-progress',
    '--format',
    'json',
    '--scanners',
    'vuln',
    '--timeout',
    '10m',
    '--',
    ref
  ]
}

/** `trivy config` quét thư mục chứa manifest — không cần kết nối cluster. */
export function configScanArgs(dir: string): string[] {
  return ['config', '--quiet', '--format', 'json', '--', dir]
}

/**
 * Trivy kết thúc lỗi → câu dễ hiểu: chưa cài, bản quá cũ (không có `--scanners`), hay nguyên văn
 * dòng lỗi cuối của Trivy (thiếu mạng để tải CSDL, image không có…).
 */
export function trivyFailure(code: number | null, stderr: string): Error {
  const text = stderr.trim()
  if (code === 127 || /command not found|not recognized as an internal/i.test(text))
    return new Error(
      t('Trivy is not installed here. Install it from https://trivy.dev and try again.')
    )
  if (/unknown flag: --scanners/i.test(text))
    return new Error(t('This Trivy is too old (it has no --scanners). Update Trivy and try again.'))
  const last = text.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 500)
  return new Error(
    last
      ? t('Trivy failed: {message}', { message: last })
      : t('Trivy failed (exit code {code})', { code: String(code) })
  )
}
