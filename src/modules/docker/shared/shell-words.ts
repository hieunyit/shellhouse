/**
 * Tách dòng lệnh thành argv kiểu POSIX shell (không chạy shell): `sh -c "echo a b"` → ["sh", "-c",
 * "echo a b"]. Hỗ trợ nháy đơn (giữ nguyên mọi ký tự), nháy kép (`\` thoát `"`, `\`, `$`, `` ` ``),
 * `\` ngoài nháy thoát ký tự kế tiếp. Không mở rộng biến / glob. Nháy chưa đóng → lỗi.
 */
export function splitShellWords(input: string): string[] {
  const out: string[] = []
  let word = ''
  /** Có từ đang dở (kể cả từ rỗng `""`). */
  let inWord = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? ''
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1] ?? '')) {
        i++
        // `\` + xuống dòng trong nháy kép: nối dòng.
        if (input[i] !== '\n') word += input[i] ?? ''
      } else word += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      inWord = true
    } else if (ch === '\\') {
      i++
      if (i < input.length && input[i] !== '\n') {
        word += input[i] ?? ''
        inWord = true
      }
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(word)
      word = ''
      inWord = false
    } else {
      word += ch
      inWord = true
    }
  }
  if (quote) throw new Error(`Unclosed ${quote === '"' ? 'double' : 'single'} quote`)
  if (inWord) out.push(word)
  return out
}

/** Như `splitShellWords` nhưng không ném: lỗi → null (giao diện báo, khoá nút). */
export function trySplitShellWords(input: string): string[] | null {
  try {
    return splitShellWords(input)
  } catch {
    return null
  }
}
