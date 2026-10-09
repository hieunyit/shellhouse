import { t } from '@shared/i18n'
import type { ContainerRow } from './ops'

export const CONTAINER_EXPECTS = ['running', 'healthy'] as const
export type ContainerExpect = (typeof CONTAINER_EXPECTS)[number]

export interface ContainerCheck {
  ok: boolean
  /** Một dòng: container ở trạng thái nào, hoặc vì sao chưa đạt. */
  detail: string
  /** Chưa đạt nhưng có thể tự đạt nếu chờ (đang khởi động, chưa có healthcheck kết quả). */
  waiting: boolean
  /** Chờ thêm cũng không đổi (container không có healthcheck mà đòi "healthy") — dừng sớm. */
  hopeless?: true
}

/** Tìm container theo tên chính xác (hoặc tiền tố id từ 4 ký tự). */
export function findContainer(
  rows: readonly ContainerRow[],
  name: string
): ContainerRow | undefined {
  const wanted = name.trim().replace(/^\//, '')
  if (!wanted) return undefined
  return (
    rows.find((r) => r.name === wanted) ??
    (wanted.length >= 4 ? rows.find((r) => r.id.startsWith(wanted)) : undefined)
  )
}

/**
 * Container có đạt điều kiện không. `running` = đang chạy; `healthy` = đang chạy VÀ healthcheck báo
 * healthy (container không có healthcheck không thể "healthy" — nói rõ thay vì đạt ngầm).
 */
export function containerCheck(
  rows: readonly ContainerRow[],
  name: string,
  expect: ContainerExpect
): ContainerCheck {
  const row = findContainer(rows, name)
  if (!row)
    return {
      ok: false,
      waiting: false,
      detail: t('No container named “{name}”', { name: name.trim() })
    }
  if (row.state !== 'running')
    return {
      ok: false,
      // Đang khởi động lại / vừa tạo thì có thể sắp chạy.
      waiting: row.state === 'restarting' || row.state === 'created',
      detail: t('State: {state}', { state: row.state })
    }
  if (expect === 'running') return { ok: true, waiting: false, detail: row.status }
  switch (row.health) {
    case 'healthy':
      return { ok: true, waiting: false, detail: row.status }
    case 'starting':
      return { ok: false, waiting: true, detail: t('Running, health check is still starting') }
    case 'unhealthy':
      return { ok: false, waiting: true, detail: t('Running, but the health check fails') }
    case null:
      return {
        ok: false,
        waiting: false,
        hopeless: true,
        detail: t('Running, but this container has no health check — check “running” instead')
      }
  }
}
