/**
 * Bố cục cột bảng tài nguyên: mỗi cột có độ rộng tối thiểu (rem), có giãn hay không, và thứ tự
 * bỏ bớt khi khung hẹp — cột chi tiết (Node, Owner…) đi trước, CPU / Memory giữ lâu nhất (mở bảng chi tiết, cửa sổ nhỏ) — như k9s bỏ cột ở màn hẹp. Cột Status và
 * Age không bao giờ bị bỏ; Status đủ rộng cho "CrashLoopBackOff".
 */
interface Spec {
  min: number
  /** 0 = cố định `min`. */
  grow: number
  /** Cao = bỏ trước; 0 = giữ luôn. */
  drop: number
}

const SPECS: Record<string, Spec> = {
  status: { min: 8.5, grow: 1, drop: 0 },
  age: { min: 3.5, grow: 0, drop: 0 },
  ready: { min: 4, grow: 0, drop: 1 },
  ns: { min: 6, grow: 1, drop: 2 },
  restarts: { min: 4.5, grow: 0, drop: 4 },
  cpu: { min: 4.5, grow: 0, drop: 3 },
  mem: { min: 5, grow: 0, drop: 3 },
  type: { min: 5, grow: 1, drop: 1 },
  keys: { min: 3.5, grow: 0, drop: 2 },
  ports: { min: 6, grow: 1.5, drop: 2 },
  hosts: { min: 8, grow: 2, drop: 1 },
  schedule: { min: 6, grow: 1, drop: 1 },
  reason: { min: 6, grow: 1, drop: 1 },
  message: { min: 10, grow: 3, drop: 1 },
  object: { min: 8, grow: 1.5, drop: 2 },
  desired: { min: 4.5, grow: 0, drop: 3 },
  upToDate: { min: 5, grow: 0, drop: 4 },
  available: { min: 5, grow: 0, drop: 3 },
  completions: { min: 5.5, grow: 0, drop: 2 },
  suspend: { min: 4.5, grow: 0, drop: 3 },
  capacity: { min: 4.5, grow: 0, drop: 2 },
  last: { min: 5, grow: 0, drop: 4 },
  version: { min: 5.5, grow: 1, drop: 4 },
  roles: { min: 6, grow: 1, drop: 4 },
  address: { min: 6, grow: 1, drop: 5 },
  clusterIP: { min: 6.5, grow: 1, drop: 5 },
  storageClass: { min: 6, grow: 1, drop: 6 },
  owner: { min: 6, grow: 1, drop: 6 },
  node: { min: 6, grow: 1, drop: 6 }
}
const DEFAULT: Spec = { min: 6, grow: 1, drop: 3 }
const NAME = 'minmax(10rem,2fr)'
const NAME_MIN = 10
/** px-3 hai bên + gap-3 giữa các cột (rem). */
const PADDING = 1.5
const GAP = 0.75

export function specOf(id: string, wide = false): Spec {
  const s = SPECS[id] ?? DEFAULT
  // Cột CPU / Memory của node có thêm "(37%)".
  return wide && (id === 'cpu' || id === 'mem') ? { ...s, min: s.min + 2.5 } : s
}

/**
 * Giữ các cột vừa `widthPx` (bỏ cột có `drop` cao nhất trước, cột cuối cùng bị bỏ trước khi
 * hoà); trả id cột giữ lại + `grid-template-columns`. `widthPx` = 0 (chưa đo) → giữ hết.
 */
export function fitColumns(
  ids: readonly string[],
  widthPx: number,
  options: { wide?: boolean; rem?: number } = {}
): { keep: Set<string>; template: string } {
  const rem = options.rem ?? 16
  const keep = [...ids]
  const need = (list: string[]): number =>
    NAME_MIN +
    PADDING +
    GAP * list.length +
    list.reduce((sum, id) => sum + specOf(id, options.wide).min, 0)
  if (widthPx > 0)
    while (need(keep) * rem > widthPx) {
      let worst = -1
      for (let i = 0; i < keep.length; i++) {
        const d = specOf(keep[i] ?? '', options.wide).drop
        if (d > 0 && (worst === -1 || d >= specOf(keep[worst] ?? '', options.wide).drop)) worst = i
      }
      if (worst === -1) break
      keep.splice(worst, 1)
    }
  const template = [
    NAME,
    ...keep.map((id) => {
      const s = specOf(id, options.wide)
      return s.grow ? `minmax(${s.min}rem,${s.grow}fr)` : `${s.min}rem`
    })
  ].join(' ')
  return { keep: new Set(keep), template }
}
