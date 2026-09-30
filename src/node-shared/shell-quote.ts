/**
 * argv → một dòng lệnh POSIX sh an toàn (mỗi đối số trong nháy đơn). Dùng cho lệnh module chạy qua
 * SSH (ADR-014 mục 3.6): module đưa mảng đối số, không bao giờ ghép chuỗi lệnh tự do.
 */
export function shellQuote(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('Empty command')
  return argv
    .map((arg) => {
      if (arg.includes('\0')) throw new Error('Arguments cannot contain NUL')
      // Chữ an toàn giữ nguyên cho dễ đọc trong log.
      if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
      return `'${arg.replace(/'/g, `'\\''`)}'`
    })
    .join(' ')
}
