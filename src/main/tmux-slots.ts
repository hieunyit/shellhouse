/**
 * Phiên tmux theo tab: tab thứ n đang mở của một host gắn vào "shellhouse-n" (số nhỏ nhất còn
 * trống). Kết nối lại — kể cả sau khi mở lại app — lấy lại đúng số đó, nên về đúng phiên cũ trên
 * server; đóng tab thì trả số lại.
 */
export class TmuxSlots {
  private readonly slots = new Map<string, { hostId: string; slot: number }>()

  /** Cấp tên phiên cho session mới của host. */
  take(sessionId: string, hostId: string): string {
    const used = new Set(
      [...this.slots.values()].filter((s) => s.hostId === hostId).map((s) => s.slot)
    )
    let slot = 1
    while (used.has(slot)) slot++
    this.slots.set(sessionId, { hostId, slot })
    return `shellhouse-${String(slot)}`
  }

  release(sessionId: string): void {
    this.slots.delete(sessionId)
  }
}
