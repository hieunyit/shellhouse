/** Thay ký tự Windows không cho phép trong tên file (và ký tự điều khiển) bằng "_". */
export function replaceUnsafeFileChars(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\p{Cc}/gu, '_')
}

/** Tên thiết bị của Windows (kể cả có đuôi: "con.txt", "COM1.log", "LPT¹") — không tạo file được. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

export interface SafeNameOptions {
  /**
   * Quy tắc Windows: bỏ dấu chấm / khoảng trắng ở cuối (Windows tự cắt → trùng tên khác hoặc thành
   * ".."), né tên thiết bị (CON, NUL, COM1…). Mặc định bật (an toàn — renderer không biết máy đích);
   * Session Host / main truyền `process.platform === 'win32'`.
   */
  windows?: boolean
}

/**
 * Một thành phần đường dẫn an toàn để ghi ra máy từ tên do server đặt (key S3, tên file SFTP):
 * ngoài ký tự cấm còn chặn "", ".", ".." (thoát khỏi thư mục đích) trên mọi hệ điều hành; quy tắc
 * riêng của Windows xem SafeNameOptions. Luôn trả về tên khác rỗng, không chứa dấu phân cách.
 * Hai tên khác nhau có thể ra cùng một tên ("a:b" / "a_b") — ghi nhiều file cùng chỗ thì dùng
 * UniqueNames.
 */
export function safeFileName(name: string, options: SafeNameOptions = {}): string {
  const windows = options.windows ?? true
  const replaced = replaceUnsafeFileChars(name)
  const cleaned = windows ? replaced.replace(/[. ]+$/, '') : replaced
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_'
  return windows && WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned
}

/**
 * Đường dẫn tương đối kiểu "a/b/c.txt" (key S3…) → các thành phần an toàn. Đoạn rỗng ("a//b",
 * "/a") thành "_" — giữ cấu trúc; hai key vẫn có thể ra cùng đường dẫn ("a//b" / "a/_/b") → dùng
 * UniqueNames khi ghi nhiều file.
 */
export function safeRelativeSegments(rel: string, options: SafeNameOptions = {}): string[] {
  return rel.split('/').map((part) => safeFileName(part, options))
}

/** "a.txt" + 2 → "a (2).txt"; ".bashrc" / "README" → ".bashrc (2)" / "README (2)". */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
}

/**
 * Cấp tên an toàn KHÔNG trùng nhau trong một thư mục đích: tên gốc khác nhau mà ra cùng tên an toàn
 * (hoặc chỉ khác hoa / thường trên ổ không phân biệt) thì tên sau thêm " (2)", " (3)"… — hai lượt
 * tải không ghi chung một file (và chung file .part). Cùng `id` luôn ra cùng tên.
 */
export class UniqueNames {
  private readonly taken = new Set<string>()
  private readonly assigned = new Map<string, string>()

  constructor(
    private readonly options: SafeNameOptions & {
      /** Ổ không phân biệt hoa / thường (Windows, macOS). */
      foldCase?: boolean
    } = {},
    /** Tên đã có người dùng (lượt tải khác đang ghi vào cùng thư mục). */
    taken: Iterable<string> = []
  ) {
    for (const name of taken) this.taken.add(this.fold(name))
  }

  private fold(name: string): string {
    return this.options.foldCase ? name.toLowerCase() : name
  }

  /** `id` phân biệt mục gốc (vd. "f:a." và "d:a." — file và thư mục cùng tên gốc là hai mục). */
  name(id: string, raw: string): string {
    const known = this.assigned.get(id)
    if (known !== undefined) return known
    const safe = safeFileName(raw, this.options)
    let out = safe
    for (let n = 2; this.taken.has(this.fold(out)); n++) out = numberedName(safe, n)
    this.taken.add(this.fold(out))
    this.assigned.set(id, out)
    return out
  }
}

/** Tuỳ chọn tên file theo máy đang chạy (chỉ dùng trong Node: Session Host / main). */
export function hostNameOptions(platform: string): SafeNameOptions & { foldCase: boolean } {
  return { windows: platform === 'win32', foldCase: platform === 'win32' || platform === 'darwin' }
}
