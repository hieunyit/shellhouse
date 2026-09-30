/**
 * Gợi ý lệnh kiểu fish: lấy lệnh gần nhất trong lịch sử của đích (host) bắt đầu bằng phần đã gõ.
 * Lịch sử của mỗi đích được nạp một lần và dùng chung cho mọi tab tới cùng đích.
 */
const cache = new Map<string, string[]>()
const loading = new Map<string, Promise<void>>()

export function loadHistory(target: string): Promise<void> {
  if (cache.has(target)) return Promise.resolve()
  let pending = loading.get(target)
  if (!pending) {
    pending = window.shellhouse
      .commandHistory(target)
      .then((list) => {
        cache.set(target, list)
      })
      .catch(() => {
        cache.set(target, [])
      })
      .finally(() => loading.delete(target))
    loading.set(target, pending)
  }
  return pending
}

/** Phần còn thiếu để thành lệnh gợi ý, hoặc null. */
export function suggestRest(target: string, typed: string): string | null {
  if (typed.trim() === '' || typed.startsWith(' ')) return null
  const list = cache.get(target)
  if (!list) return null
  const match = list.find((c) => c.length > typed.length && c.startsWith(typed))
  return match ? match.slice(typed.length) : null
}

export function recordCommand(target: string, command: string): void {
  const text = command.trim()
  // Lệnh bắt đầu bằng dấu cách: không lưu (như HISTCONTROL=ignorespace của bash).
  if (!text || command.startsWith(' ') || text.length > 1000) return
  const list = cache.get(target)
  if (list) {
    const i = list.indexOf(text)
    if (i !== -1) list.splice(i, 1)
    list.unshift(text)
  }
  void window.shellhouse.recordCommand(target, text).catch(() => undefined)
}

export function forgetHistory(target: string | null): void {
  if (target === null) cache.clear()
  else cache.delete(target)
}
