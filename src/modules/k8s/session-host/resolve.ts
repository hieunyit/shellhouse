import { lookup } from 'node:dns/promises'
import { isPublicHostname, isResolvableHostname } from '../shared/connections'

/**
 * Phân giải tên máy đã khai báo → IP để đối chiếu với kết nối quan sát được (Caretta / Hubble chỉ
 * thấy IP). Chạy trên MÁY NÀY, không phải trong cluster: split-horizon DNS có thể cho IP khác — giao
 * diện nói rõ. Chỉ phân giải tên CÔNG KHAI (TLD thật, không phải .internal / .corp / .svc…): tên nội
 * bộ không bao giờ bị gửi tới DNS công cộng.
 */

const TTL_MS = 10 * 60_000
/** Kết quả thất bại nhớ ngắn hơn (tên vừa được tạo / mạng chập chờn). */
const NEGATIVE_TTL_MS = 2 * 60_000
const TIMEOUT_MS = 2_500
const CONCURRENCY = 8
export const MAX_HOSTS = 64

export type Lookup = (host: string) => Promise<string[]>

export const systemLookup: Lookup = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address)

export interface ResolveResult {
  /** Tên → IP; tên không phân giải được không có mặt (người dùng thấy "chưa đối chiếu được"). */
  results: Record<string, string[]>
  /** Tên bị bỏ vì không phải tên công khai. */
  skipped: string[]
}

export class HostResolver {
  private readonly cache = new Map<string, { ips: string[]; until: number }>()

  constructor(private readonly doLookup: Lookup = systemLookup) {}

  async resolve(
    hosts: readonly string[],
    signal?: AbortSignal,
    internal = false
  ): Promise<ResolveResult> {
    const wanted = [...new Set(hosts.map((h) => h.toLowerCase().replace(/\.$/, '')))].slice(
      0,
      MAX_HOSTS
    )
    const results: Record<string, string[]> = {}
    const skipped: string[] = []
    const todo: string[] = []
    const now = Date.now()
    for (const h of wanted) {
      if (!(internal ? isResolvableHostname(h) : isPublicHostname(h))) {
        skipped.push(h)
        continue
      }
      const hit = this.cache.get(h)
      if (hit && hit.until > now) {
        if (hit.ips.length) results[h] = hit.ips
      } else todo.push(h)
    }
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
        while (next < todo.length && !signal?.aborted) {
          const h = todo[next++] as string
          let ips: string[] = []
          try {
            ips = await withTimeout(this.doLookup(h), TIMEOUT_MS)
          } catch {
            // Không phân giải được: nhớ ngắn, báo "chưa đối chiếu được".
          }
          this.cache.set(h, {
            ips,
            until: Date.now() + (ips.length ? TTL_MS : NEGATIVE_TTL_MS)
          })
          if (ips.length) results[h] = ips
        }
      })
    )
    return { results, skipped }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('DNS timeout'))
    }, ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}
