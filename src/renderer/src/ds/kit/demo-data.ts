import type { StatusTone } from '../Status'

/** Dữ liệu giả cho Design kit (tất định — ảnh chụp ổn định giữa các lần chạy). */
export interface DemoPod {
  name: string
  namespace: string
  status: string
  tone: StatusTone
  /** Mức nghiêm trọng để "vấn đề lên đầu" khi sắp xếp theo trạng thái. */
  severity: number
  restarts: number
  cpu: number
  node: string
  age: string
  ageMinutes: number
}

const STATUSES: readonly { status: string; tone: StatusTone; severity: number; weight: number }[] =
  [
    { status: 'Running', tone: 'ok', severity: 0, weight: 80 },
    { status: 'Completed', tone: 'off', severity: 0, weight: 6 },
    { status: 'ContainerCreating', tone: 'progress', severity: 1, weight: 5 },
    { status: 'Pending', tone: 'warning', severity: 2, weight: 5 },
    { status: 'CrashLoopBackOff', tone: 'danger', severity: 3, weight: 4 }
  ]

const NAMESPACES = ['shop', 'payments', 'auth', 'monitoring', 'kube-system']
const APPS = ['web', 'api', 'worker', 'cart', 'checkout', 'search', 'redis', 'gateway']

/** Bộ sinh số giả ngẫu nhiên tất định (mulberry32). */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function pickStatus(r: number): (typeof STATUSES)[number] {
  let acc = 0
  const total = STATUSES.reduce((s, x) => s + x.weight, 0)
  for (const s of STATUSES) {
    acc += s.weight / total
    if (r < acc) return s
  }
  return STATUSES[0] ?? { status: 'Running', tone: 'ok', severity: 0, weight: 1 }
}

export function makePods(count: number): DemoPod[] {
  const random = rng(42)
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const suffix = (n: number): string =>
    Array.from({ length: n }, () => chars[Math.floor(random() * chars.length)] ?? 'x').join('')
  return Array.from({ length: count }, (_, i) => {
    const s = pickStatus(random())
    const app = APPS[i % APPS.length] ?? 'web'
    const ageMinutes = Math.floor(random() * 60 * 24 * 9) + 1
    const age =
      ageMinutes < 60
        ? `${String(ageMinutes)}m`
        : ageMinutes < 60 * 24
          ? `${String(Math.floor(ageMinutes / 60))}h`
          : `${String(Math.floor(ageMinutes / 60 / 24))}d`
    return {
      name: `${app}-${suffix(9)}-${suffix(5)}`,
      namespace: NAMESPACES[Math.floor(random() * NAMESPACES.length)] ?? 'shop',
      status: s.status,
      tone: s.tone,
      severity: s.severity,
      restarts: s.severity === 3 ? 5 + Math.floor(random() * 30) : random() < 0.1 ? 1 : 0,
      cpu: s.severity === 0 ? random() * 0.95 : random() * 0.3,
      node: `pool-a-${suffix(4)}`,
      age,
      ageMinutes
    }
  })
}
