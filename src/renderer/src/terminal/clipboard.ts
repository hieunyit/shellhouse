/** OSC 52: nhận clipboard UTF-8 do tmux phát khi copy-mode hoàn tất. */
export function decodeClipboardSequence(data: string): string | null {
  const separator = data.indexOf(';')
  if (separator < 0) return null
  const target = data.slice(0, separator)
  const encoded = data.slice(separator + 1)
  // Không hỗ trợ truy vấn "?", dữ liệu sai base64 hoặc payload quá lớn (1 MiB).
  if (!/^[cps0-7]*$/.test(target) || encoded.length > 1_398_104) return null
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null
  try {
    const bytes = atob(encoded)
    if (bytes.length > 1_048_576) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(bytes, (c) => c.charCodeAt(0))
    )
  } catch {
    return null
  }
}
