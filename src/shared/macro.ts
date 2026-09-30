/**
 * Macro (snippet chế độ 'macro'): gửi từng dòng, chờ dấu nhắc lệnh giữa các dòng. Dòng đặc biệt:
 *   # wait 5            → chờ 5 giây
 *   # expect Password:  → chờ tới khi màn hình có chữ này
 *   # ghi chú khác      → bỏ qua
 * Dòng trống bị bỏ qua (muốn gửi Enter trống: dùng một dòng chỉ có dấu cách).
 */
export type MacroStep =
  { kind: 'send'; line: string } | { kind: 'wait'; ms: number } | { kind: 'expect'; text: string }

/** Chờ tối đa bao lâu cho mỗi bước (dấu nhắc / expect). */
export const MACRO_STEP_TIMEOUT_MS = 60_000
export const MACRO_MAX_WAIT_MS = 10 * 60_000

export function parseMacro(body: string): MacroStep[] {
  const steps: MacroStep[] = []
  for (const raw of body.split(/\r?\n/)) {
    const wait = /^\s*#\s*wait\s+(\d+(?:\.\d+)?)\s*s?\s*$/i.exec(raw)
    if (wait) {
      steps.push({ kind: 'wait', ms: Math.min(MACRO_MAX_WAIT_MS, Number(wait[1]) * 1000) })
      continue
    }
    const expect = /^\s*#\s*expect\s+(.+?)\s*$/i.exec(raw)
    if (expect?.[1]) {
      steps.push({ kind: 'expect', text: expect[1] })
      continue
    }
    if (/^\s*#/.test(raw)) continue
    if (raw === '') continue
    steps.push({ kind: 'send', line: raw.trim() === '' ? '' : raw })
  }
  return steps
}

/**
 * Dòng cuối có giống dấu nhắc lệnh không: kết thúc bằng $ # > % hoặc : (dấu nhắc mật khẩu,
 * "--More--" không tính), có thể có một dấu cách. Ví dụ: "user@host:~$ ", "router#", "PS C:\>",
 * "Password:".
 */
export function looksLikePrompt(line: string): boolean {
  const trimmed = line.replace(/\s+$/, '')
  if (trimmed === '') return false
  // "%" chỉ tính khi có dấu cách phía trước (zsh: "me@mac ~ %"), không nhầm với "Downloading 42%".
  return /(?:[$#>:\]]|\s%)$/.test(trimmed) && !/--more--/i.test(trimmed)
}
