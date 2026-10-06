/**
 * Thời hạn hỗ trợ của Kubernetes (bản upstream — kubernetes.io/releases): mỗi bản minor được vá
 * khoảng 14 tháng. Bảng đóng gói theo app (không gọi mạng), cập nhật theo mỗi bản phát hành. EKS /
 * GKE / AKS có lịch riêng (thường dài hơn) — bảng này là mốc chung, nhà cung cấp có thể còn hỗ trợ.
 */
export const K8S_END_OF_LIFE: Readonly<Record<string, string>> = {
  '1.25': '2023-10-28',
  '1.26': '2024-02-28',
  '1.27': '2024-06-28',
  '1.28': '2024-10-28',
  '1.29': '2025-02-28',
  '1.30': '2025-06-28',
  '1.31': '2025-10-28',
  '1.32': '2026-02-28',
  '1.33': '2026-06-28',
  '1.34': '2026-10-27',
  '1.35': '2027-02-28',
  '1.36': '2027-06-28'
}

/** Còn ít hơn chừng này ngày → nhắc nâng cấp. */
export const SUPPORT_WARN_DAYS = 60

export type SupportStatus = 'supported' | 'ending' | 'ended' | 'unknown'

export interface K8sSupport {
  /** "1.34" — '' nếu không đọc được phiên bản. */
  minor: string
  status: SupportStatus
  /** Ngày hết hỗ trợ (ISO date) nếu có trong bảng. */
  endOfLife?: string
  /** Số ngày còn lại (âm = đã hết). */
  daysLeft?: number
  /** Nhà cung cấp nhận ra từ gitVersion (eks / gke) — lịch của họ có thể khác. */
  provider?: 'EKS' | 'GKE'
}

const DAY_MS = 86_400_000

/** Đọc "v1.34.2-eks-113cf36" → hỗ trợ tới đâu. */
export function k8sSupport(gitVersion: string, now = Date.now()): K8sSupport {
  const m = /^v?(\d+)\.(\d+)/.exec(gitVersion.trim())
  const provider = /-eks-/.test(gitVersion) ? 'EKS' : /-gke\./.test(gitVersion) ? 'GKE' : undefined
  if (!m) return { minor: '', status: 'unknown', ...(provider ? { provider } : {}) }
  const minor = `${m[1] ?? ''}.${m[2] ?? ''}`
  const eol = K8S_END_OF_LIFE[minor]
  if (!eol) {
    // Mới hơn bảng → còn hỗ trợ; cũ hơn bảng → đã hết từ lâu.
    const known = Object.keys(K8S_END_OF_LIFE).map((v) => Number(v.split('.')[1]))
    const n = Number(m[2])
    const status: SupportStatus =
      m[1] !== '1' ? 'unknown' : n > Math.max(...known) ? 'supported' : 'ended'
    return { minor, status, ...(provider ? { provider } : {}) }
  }
  const daysLeft = Math.floor((Date.parse(`${eol}T23:59:59Z`) - now) / DAY_MS)
  return {
    minor,
    status: daysLeft < 0 ? 'ended' : daysLeft < SUPPORT_WARN_DAYS ? 'ending' : 'supported',
    endOfLife: eol,
    daysLeft,
    ...(provider ? { provider } : {})
  }
}
