/** Bộ đệm log của tab (thuần — test được không cần giao diện). */

/** Giới hạn bộ đệm mỗi tab (ADR-014 mục 7.6 — áp cho cả Docker). */
export const MAX_LINES = 50_000

export interface Line {
  text: string
  err: boolean
}

/** Bộ đệm dòng: nối mảnh vào dòng dở, cắt bớt đầu khi quá giới hạn. */
export class LineBuffer {
  lines: Line[] = []
  private partial: Line | null = null

  push(text: string, err: boolean): void {
    const parts = text.split('\n')
    parts.forEach((part, i) => {
      const clean = part.replace(/\r$/, '')
      if (i === 0 && this.partial && this.partial.err === err) this.partial.text += clean
      else {
        if (this.partial) this.lines.push(this.partial)
        this.partial = { text: clean, err }
      }
      if (i < parts.length - 1) {
        this.lines.push(this.partial)
        this.partial = null
      }
    })
    // Mảnh kết thúc bằng xuống dòng: chưa có dòng dở nào.
    if (this.partial?.text === '') this.partial = null
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
  }

  all(): Line[] {
    return this.partial && this.partial.text ? [...this.lines, this.partial] : this.lines
  }

  clear(): void {
    this.lines = []
    this.partial = null
  }
}
