/** "hieu.nguyen" → "HN", "hellc" → "HE": chữ viết tắt của tên đăng nhập trên máy. */
export function initials(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const letters =
    parts.length >= 2
      ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`
      : (parts[0] ?? '').slice(0, 2)
  return letters.toUpperCase()
}
