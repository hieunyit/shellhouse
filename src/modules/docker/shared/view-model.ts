import { t, tn } from '@shared/i18n'
import { formatRelative } from '@shared/i18n/format'
import type { ContainerAction, ContainerRow, ImageRow, StatsSample } from './ops'

/**
 * Phần thuần (không React, không DOM) của tab Docker: lọc, sắp xếp, nhóm Compose, câu xác nhận.
 * Ở `shared/` để test chạy được trong Node.
 */

/** Như `nameOrder` của renderer: "web2" trước "web10", không phân biệt hoa thường. */
const nameOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

export type SortKey = 'name' | 'created' | 'size' | 'cpu' | 'mem'

/** "5 min ago", "yesterday", rồi ngày cụ thể (theo ngôn ngữ giao diện); 0 = không biết. */
export function ago(ms: number, now = Date.now()): string {
  return ms ? formatRelative(ms, now) : ''
}

export function portsText(c: ContainerRow): string {
  return [
    ...new Set(
      c.ports.map((p) =>
        p.publicPort ? `${p.publicPort}→${p.privatePort}/${p.type}` : `${p.privatePort}/${p.type}`
      )
    )
  ].join(', ')
}

export const imageName = (i: ImageRow): string =>
  i.tags[0] ?? i.id.replace(/^sha256:/, '').slice(0, 12)

/** Mẫu stats mới nhất của container (statsAll của CLI có thể khoá bằng id rút gọn). */
export function latestSample(
  samples: Readonly<Record<string, StatsSample[]>>,
  id: string
): StatsSample | undefined {
  return (samples[id] ?? samples[id.slice(0, 12)])?.at(-1)
}

export function sortList<T>(
  list: readonly T[],
  sort: { key: SortKey; dir: 'asc' | 'desc' },
  name: (x: T) => string,
  created: (x: T) => number,
  extra?: { size?: (x: T) => number; cpu?: (x: T) => number; mem?: (x: T) => number }
): T[] {
  const dir = sort.dir === 'asc' ? 1 : -1
  const f =
    sort.key === 'size'
      ? extra?.size
      : sort.key === 'cpu'
        ? extra?.cpu
        : sort.key === 'mem'
          ? extra?.mem
          : undefined
  return [...list].sort((a, b) => {
    if (sort.key === 'created') return (created(a) - created(b)) * dir
    if (f) return (f(a) - f(b)) * dir
    return nameOrder.compare(name(a), name(b)) * dir
  })
}

/** Khớp bộ lọc chữ (không phân biệt hoa thường; `q` đã lowercase + trim). */
export function matches(q: string, ...parts: (string | null | undefined)[]): boolean {
  return !q || parts.some((p) => p?.toLowerCase().includes(q))
}

export interface ComposeProject {
  name: string
  services: number
  running: number
  containers: ContainerRow[]
}

export function groupProjects(containers: readonly ContainerRow[], q: string): ComposeProject[] {
  const map = new Map<string, ContainerRow[]>()
  for (const c of containers)
    if (c.project) {
      const list = map.get(c.project)
      if (list) list.push(c)
      else map.set(c.project, [c])
    }
  return [...map.entries()]
    .map(([name, list]) => ({
      name,
      containers: list,
      services: new Set(list.map((c) => c.service ?? c.name)).size,
      running: list.filter((c) => c.state === 'running').length
    }))
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => nameOrder.compare(a.name, b.name))
}

/** Danh sách tên gọn cho câu xác nhận ("a, b, c and 4 more"). */
export function namesText(names: readonly string[], max = 3): string {
  if (names.length <= max) return names.join(', ')
  return t('{names} and {n} more', { names: names.slice(0, max).join(', '), n: names.length - max })
}

export interface ActionConfirm {
  title: string
  message: string
  confirmLabel: string
  danger: boolean
  /** remove: hỏi thêm "xoá cả volume ẩn danh". */
  volumesOption: boolean
}

/**
 * Thao tác cần hỏi lại: xoá / kill luôn hỏi; stop / restart hỏi khi bấm phím tắt một chữ (gõ
 * nhầm phím không được dừng dịch vụ). null = chạy luôn.
 */
export function confirmFor(
  action: ContainerAction,
  items: readonly ContainerRow[],
  viaShortcut: boolean
): ActionConfirm | null {
  const names = namesText(items.map((c) => c.name))
  const plural = items.length > 1
  if (action === 'remove') {
    const running = items.filter((c) => c.state === 'running')
    return {
      title: plural
        ? t('Remove {n} containers?', { n: items.length })
        : t('Remove {name}?', { name: names }),
      message: [
        plural
          ? t('{names} are deleted with their writable layer.', { names })
          : t('{names} is deleted with its writable layer.', { names }),
        running.length
          ? ` ${tn(
              running.length,
              '{names} is running and will be stopped first (force remove).',
              '{names} are running and will be stopped first (force remove).',
              { names: namesText(running.map((c) => c.name)) }
            )}`
          : '',
        ` ${t('Named volumes are kept.')}`
      ].join(''),
      confirmLabel: running.length ? t('Force remove') : t('Remove'),
      danger: true,
      volumesOption: true
    }
  }
  if (action === 'kill')
    return {
      title: plural
        ? t('Kill {n} containers?', { n: items.length })
        : t('Kill {name}?', { name: names }),
      message: plural
        ? t('{names} are stopped at once (SIGKILL) — the processes get no chance to clean up.', {
            names
          })
        : t('{names} is stopped at once (SIGKILL) — the processes get no chance to clean up.', {
            names
          }),
      confirmLabel: t('Kill'),
      danger: true,
      volumesOption: false
    }
  if (viaShortcut && (action === 'stop' || action === 'restart'))
    return {
      title:
        action === 'stop'
          ? t('Stop {name}?', { name: names })
          : t('Restart {name}?', { name: names }),
      message:
        action === 'stop'
          ? t('{names} stops; whatever it serves is unavailable until it is started again.', {
              names
            })
          : t('{names} restarts; whatever it serves is briefly unavailable.', { names }),
      confirmLabel: action === 'stop' ? t('Stop') : t('Restart'),
      danger: false,
      volumesOption: false
    }
  return null
}
