import { t, tn } from '@shared/i18n'
import { formatRelative } from '@shared/i18n/format'
import type { ContainerAction, ContainerRow, Health, ImageRow, StatsSample } from './ops'

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

export interface ComposeService {
  name: string
  /** Image của container đầu tiên (các replica thường cùng image). */
  image: string
  containers: ContainerRow[]
  running: number
  /** Healthcheck gộp (xấu nhất trong các replica). */
  health: Health
  ports: string
}

export interface ComposeProject {
  name: string
  services: number
  running: number
  containers: ContainerRow[]
  serviceList: ComposeService[]
  /** Nhãn `com.docker.compose.project.working_dir` / `config_files` (nếu có). */
  workingDir: string | null
  configFiles: string[]
  /** Lần tạo container gần nhất (ms) — "cập nhật lần cuối" của project. */
  updated: number
  /** Container unhealthy / restarting / dead. */
  unhealthy: number
  status: 'running' | 'partial' | 'stopped'
}

/** Healthcheck xấu nhất: unhealthy > starting > healthy > không có. */
export function worstHealth(list: readonly Health[]): Health {
  if (list.includes('unhealthy')) return 'unhealthy'
  if (list.includes('starting')) return 'starting'
  if (list.includes('healthy')) return 'healthy'
  return null
}

export const isUnhealthy = (c: Pick<ContainerRow, 'health' | 'state'>): boolean =>
  c.health === 'unhealthy' || c.state === 'restarting' || c.state === 'dead'

function project(name: string, list: ContainerRow[]): ComposeProject {
  const byService = new Map<string, ContainerRow[]>()
  for (const c of list) {
    const key = c.service ?? c.name
    const s = byService.get(key)
    if (s) s.push(c)
    else byService.set(key, [c])
  }
  const serviceList = [...byService.entries()]
    .map(([service, cs]) => {
      const sorted = [...cs].sort((a, b) => nameOrder.compare(a.name, b.name))
      return {
        name: service,
        image: sorted[0]?.image ?? '',
        containers: sorted,
        running: sorted.filter((c) => c.state === 'running').length,
        health: worstHealth(sorted.map((c) => c.health)),
        ports: [...new Set(sorted.map(portsText).filter(Boolean))].join(', ')
      }
    })
    .sort((a, b) => nameOrder.compare(a.name, b.name))
  const running = list.filter((c) => c.state === 'running').length
  const withDir = list.find((c) => c.composeDir)
  const files = list.find((c) => c.composeFiles)?.composeFiles
  return {
    name,
    containers: list,
    services: serviceList.length,
    running,
    serviceList,
    workingDir: withDir?.composeDir ?? null,
    configFiles: files
      ? files
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean)
      : [],
    updated: Math.max(0, ...list.map((c) => c.created)),
    unhealthy: list.filter(isUnhealthy).length,
    status: running === 0 ? 'stopped' : running === list.length ? 'running' : 'partial'
  }
}

/** Nhóm container theo Compose project; lọc theo tên project, service hoặc image. */
export function groupProjects(containers: readonly ContainerRow[], q: string): ComposeProject[] {
  const map = new Map<string, ContainerRow[]>()
  for (const c of containers)
    if (c.project) {
      const list = map.get(c.project)
      if (list) list.push(c)
      else map.set(c.project, [c])
    }
  return [...map.entries()]
    .map(([name, list]) => project(name, list))
    .filter(
      (p) =>
        !q ||
        matches(q, p.name, p.workingDir) ||
        p.serviceList.some((s) => matches(q, s.name, s.image))
    )
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
 * nhầm phím không được dừng dịch vụ). Production: stop / restart / pause luôn hỏi và là thao tác
 * nguy hiểm (gõ lại tên — như scale về 0 / restart bên Kubernetes). null = chạy luôn.
 */
export function confirmFor(
  action: ContainerAction,
  items: readonly ContainerRow[],
  viaShortcut: boolean,
  production = false
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
  if (production && action === 'pause')
    return {
      title: t('Pause {name}?', { name: names }),
      message: t('{names} is frozen; whatever it serves stops answering until it is resumed.', {
        names
      }),
      confirmLabel: t('Pause'),
      danger: true,
      volumesOption: false
    }
  if ((viaShortcut || production) && (action === 'stop' || action === 'restart'))
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
      danger: production,
      volumesOption: false
    }
  return null
}
