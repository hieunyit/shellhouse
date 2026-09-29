/**
 * Tiêu đề do shell đặt → tên tab. Trên Windows, ConPTY đặt tiêu đề bằng đường dẫn exe
 * ("C:\\WINDOWS\\System32\\cmd.exe", "… - ping x"): bỏ phần đường dẫn; chỉ còn đường dẫn thì
 * trả về '' để tab giữ tên shell ("Command Prompt"). Shell chạy quyền admin thì Windows thêm
 * tiền tố "Administrator: " — bỏ đi rồi xét như trên.
 */
export function tabTitle(raw: string): string {
  const title = raw.trim()
  const path = title.replace(/^Administrator:\s*/, '')
  const exe = /^(?:[A-Za-z]:\\|\\\\)[^"]*?\.exe(?:\s+-\s+(.*))?$/i.exec(path)
  if (exe) return (exe[1] ?? '').trim()
  return title
}
