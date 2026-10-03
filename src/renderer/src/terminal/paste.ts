// Xử lý văn bản dán vào terminal (thuần — có unit test).

/** Văn bản có xuống dòng (kể cả một \n ở cuối — nó cũng làm lệnh chạy ngay). */
export function isMultiline(text: string): boolean {
  return /[\r\n]/.test(text)
}

/** Các dòng của văn bản dán (bỏ dòng trống cuối do \n kết thúc). */
export function pasteLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/** "Paste as one line": nối các dòng bằng dấu cách, bỏ xuống dòng ở cuối. */
export function joinPasteLines(text: string): string {
  return pasteLines(text)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ')
}
