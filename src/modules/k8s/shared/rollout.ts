import { t } from '@shared/i18n'

/** Loại workload mà bước runbook "rollout sẵn sàng" kiểm được. */
export const ROLLOUT_KINDS = ['deployments.apps', 'statefulsets.apps', 'daemonsets.apps'] as const
export type RolloutKind = (typeof ROLLOUT_KINDS)[number]

export interface RolloutState {
  ready: boolean
  /** Một dòng: số bản sẵn sàng / mong muốn, hoặc đang chờ gì. */
  detail: string
}

interface Workload {
  metadata?: { generation?: number }
  spec?: { replicas?: number; paused?: boolean }
  status?: Record<string, unknown>
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback)

/**
 * Workload đã "xong" việc triển khai chưa — cùng ý nghĩa với `kubectl rollout status`: controller đã
 * thấy bản mới nhất, đủ bản mới (updated), đủ bản sẵn sàng, không còn bản cũ. Scale về 0 KHÔNG tính
 * là sẵn sàng (một kiểm tra "service đang chạy" không được đạt khi không có gì chạy).
 */
export function rolloutState(kind: RolloutKind, obj: unknown): RolloutState {
  const w = (obj ?? {}) as Workload
  const status = w.status ?? {}
  const generation = num(w.metadata?.generation)
  const observed = num(status['observedGeneration'], generation)
  if (observed < generation)
    return { ready: false, detail: t('Waiting for the controller to notice the latest change') }

  if (kind === 'daemonsets.apps') {
    const desired = num(status['desiredNumberScheduled'])
    const ready = num(status['numberReady'])
    const updated = num(status['updatedNumberScheduled'])
    if (desired === 0) return { ready: false, detail: t('No node runs this DaemonSet') }
    return {
      ready: ready === desired && updated === desired && num(status['numberUnavailable']) === 0,
      detail: t('{ready}/{desired} pods ready, {updated} updated', { ready, desired, updated })
    }
  }

  const desired = num(w.spec?.replicas, 1)
  if (desired === 0) return { ready: false, detail: t('Scaled to 0 — nothing is running') }
  const ready = num(status['readyReplicas'])
  const updated = num(status['updatedReplicas'])
  const base = {
    detail: t('{ready}/{desired} replicas ready, {updated} updated', { ready, desired, updated })
  }
  if (kind === 'statefulsets.apps')
    return { ready: ready === desired && updated === desired, ...base }
  // Deployment: còn bản cũ (replicas > desired) hoặc chưa đủ available → chưa xong.
  const total = num(status['replicas'])
  const available = num(status['availableReplicas'])
  const paused = w.spec?.paused === true
  return {
    ready:
      !paused &&
      ready === desired &&
      updated === desired &&
      available === desired &&
      total <= desired,
    detail: paused ? t('The rollout is paused') : base.detail
  }
}
