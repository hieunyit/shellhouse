import type { ContainerRow, DockerOp, ImageRow } from './ops'

/**
 * Phần thuần của chọn nhiều dòng + thao tác hàng loạt (Containers / Images / Volumes / Networks):
 * ô chọn tất cả ba trạng thái, Shift+bấm chọn một khoảng, thao tác áp dụng được cho container nào,
 * chạy song song có giới hạn với kết quả từng mục. Ở `shared/` để test chạy trong Node.
 */

export type SelectAllState = 'none' | 'some' | 'all'

/** Trạng thái ô "chọn tất cả" theo các dòng đang hiện (dòng bị lọc ẩn không tính). */
export function selectAllState(
  keys: readonly string[],
  selected: ReadonlySet<string>
): SelectAllState {
  if (keys.length === 0) return 'none'
  let n = 0
  for (const k of keys) if (selected.has(k)) n++
  return n === 0 ? 'none' : n === keys.length ? 'all' : 'some'
}

/** Bấm ô "chọn tất cả": đang chọn hết → bỏ chọn; còn lại → chọn mọi dòng đang hiện. */
export function toggleAll(keys: readonly string[], selected: ReadonlySet<string>): Set<string> {
  return selectAllState(keys, selected) === 'all' ? new Set() : new Set(keys)
}

/**
 * Bấm ô chọn của một dòng. `range` (Shift) + có mốc: mọi dòng từ mốc tới dòng này nhận trạng thái
 * mới của dòng được bấm (như Gmail) — các dòng ngoài khoảng giữ nguyên.
 */
export function toggleKey(
  keys: readonly string[],
  selected: ReadonlySet<string>,
  key: string,
  anchor: string | null,
  range: boolean
): Set<string> {
  const next = new Set(selected)
  const on = !selected.has(key)
  const a = range && anchor !== null ? keys.indexOf(anchor) : -1
  const b = keys.indexOf(key)
  if (a === -1 || b === -1) {
    if (on) next.add(key)
    else next.delete(key)
    return next
  }
  const [from, to] = a < b ? [a, b] : [b, a]
  for (const k of keys.slice(from, to + 1)) {
    if (on) next.add(k)
    else next.delete(k)
  }
  return next
}

// ——— Container ———

export type ContainerBulk = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove'

export const CONTAINER_BULK: readonly ContainerBulk[] = [
  'start',
  'stop',
  'restart',
  'pause',
  'unpause',
  'kill',
  'remove'
]

/** Đang có tiến trình chạy (dừng / kill được; xoá phải force). */
const LIVE = new Set(['running', 'restarting', 'paused'])

/** Thao tác có ý nghĩa với container ở trạng thái này không (không → bỏ qua, không gửi Engine). */
export function containerApplies(kind: ContainerBulk, c: Pick<ContainerRow, 'state'>): boolean {
  switch (kind) {
    case 'start':
      return c.state === 'exited' || c.state === 'created'
    case 'stop':
      return c.state === 'running' || c.state === 'restarting'
    case 'restart':
      return c.state !== 'removing' && c.state !== 'dead' && c.state !== 'paused'
    case 'pause':
      return c.state === 'running'
    case 'unpause':
      return c.state === 'paused'
    case 'kill':
      return LIVE.has(c.state)
    case 'remove':
      return c.state !== 'removing'
  }
}

/** Tách mục áp dụng được / bỏ qua (giữ thứ tự). */
export function splitTargets<T>(
  items: readonly T[],
  applies: (item: T) => boolean
): { targets: T[]; skipped: T[] } {
  const targets: T[] = []
  const skipped: T[] = []
  for (const i of items) (applies(i) ? targets : skipped).push(i)
  return { targets, skipped }
}

/** Lệnh gửi Session Host cho một container. Xoá container còn chạy → force (như `docker rm -f`). */
export function containerBulkOp(
  kind: ContainerBulk,
  c: Pick<ContainerRow, 'id' | 'state'>,
  options: { volumes?: boolean } = {}
): DockerOp {
  if (kind === 'remove')
    return {
      op: 'action',
      id: c.id,
      action: 'remove',
      force: LIVE.has(c.state),
      ...(options.volumes ? { volumes: true } : {})
    }
  return { op: 'action', id: c.id, action: kind }
}

// ——— Image ———

/** Các tag để kéo lại bản mới (image dangling / không tag bị bỏ qua); không trùng. */
export function pullRefs(images: readonly Pick<ImageRow, 'tags'>[]): string[] {
  return [...new Set(images.flatMap((i) => i.tags))]
}

// ——— Chạy ———

/** Chạy `fn` cho từng mục, tối đa `limit` việc cùng lúc; kết quả theo thứ tự đầu vào. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

export interface BulkResult {
  key: string
  ok: boolean
  error?: string
  /** Không chạy (người dùng đóng hộp thoại khi chưa tới lượt). */
  skipped?: boolean
}

/**
 * Chạy một thao tác cho mọi mục: song song có giới hạn, lỗi một mục không dừng các mục khác,
 * `isCancelled()` → các mục chưa bắt đầu được đánh dấu bỏ qua. `onResult` gọi ngay khi xong mỗi mục.
 */
export function runBulk<T>(
  items: readonly T[],
  options: {
    key: (item: T) => string
    run: (item: T) => Promise<unknown>
    parallel?: number
    isCancelled?: () => boolean
    onResult?: (r: BulkResult) => void
    errorText?: (e: unknown) => string
  }
): Promise<BulkResult[]> {
  const errorText =
    options.errorText ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)))
  return mapLimit(items, options.parallel ?? 4, async (item): Promise<BulkResult> => {
    const key = options.key(item)
    let r: BulkResult
    if (options.isCancelled?.()) r = { key, ok: false, skipped: true }
    else
      try {
        await options.run(item)
        r = { key, ok: true }
      } catch (e) {
        r = { key, ok: false, error: errorText(e) }
      }
    options.onResult?.(r)
    return r
  })
}

/**
 * Kéo một image và đợi xong (luồng sự kiện 'pull' của phiên). Nghe trước khi gửi lệnh: sự kiện
 * cuối có thể tới trước cả khi biết id đăng ký.
 */
export function pullAndWait(
  request: <T>(op: DockerOp) => Promise<T>,
  subscribe: (l: (event: string, data: unknown) => void) => () => void,
  ref: string,
  registry: string | null
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let sub: string | null = null
    const finished = new Map<string, { error?: string }>()
    const settle = (r: { error?: string }): void => {
      off()
      if (r.error) reject(new Error(r.error))
      else resolve()
    }
    const off = subscribe((event, data) => {
      if (event !== 'pull') return
      const d = data as { subscription?: string; done?: boolean; error?: string }
      if (!d.done || !d.subscription) return
      const r = d.error ? { error: d.error } : {}
      if (sub === d.subscription) settle(r)
      else if (sub === null) finished.set(d.subscription, r)
    })
    request<{ subscription: string }>({ op: 'image.pull', ref, registry }).then(
      (r) => {
        sub = r.subscription
        const early = finished.get(r.subscription)
        if (early) settle(early)
      },
      (e: unknown) => {
        off()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}
