import {
  ArrowLeftRight,
  Ban,
  FileCode,
  FileText,
  History,
  Pause,
  Pencil,
  Play,
  PlayCircle,
  RefreshCcwDot,
  RotateCw,
  Scale,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Unlock,
  Wind,
  Zap,
  Bug,
  TerminalSquare
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { MenuEntry } from '../../../renderer/src/components/ContextMenu'
import type { K8sObject } from '../shared/resources'
import { t } from '../../registry/renderer-kit'

/**
 * Thao tác trên một tài nguyên — một nguồn cho menu chuột phải, phím tắt (kiểu k9s) và thanh công
 * cụ của trang chi tiết.
 */
export interface K8sAction {
  id: string
  label: string
  icon: ReactNode
  /** Phím tắt (khớp `event.key`, có thể kèm "ctrl+"). */
  key?: string
  danger?: boolean
  /** Chỉ trong menu "…" / phím tắt — không thành nút chính của bảng chi tiết. */
  secondary?: boolean
  run(): void
}

export interface ActionHandlers {
  logs(obj: K8sObject, opts?: { allContainers?: boolean; selector?: string }): void
  shell(obj: K8sObject, container?: string): void
  yaml(obj: K8sObject): void
  edit(obj: K8sObject): void
  editExternal(obj: K8sObject): void
  forward(obj: K8sObject): void
  /** kubectl debug: container debug trong pod / pod debug trên node. */
  debug(obj: K8sObject): void
  scale(obj: K8sObject): void
  restart(obj: K8sObject): void
  pause(obj: K8sObject, paused: boolean): void
  history(obj: K8sObject): void
  /** Quét cấu hình bằng Trivy (`trivy config` trên YAML của đối tượng). */
  scan(obj: K8sObject): void
  remove(obj: K8sObject, force: boolean): void
  cordon(obj: K8sObject, unschedulable: boolean): void
  drain(obj: K8sObject): void
  trigger(obj: K8sObject): void
  suspend(obj: K8sObject, suspend: boolean): void
  /** Argo CD Application. */
  argoSync(obj: K8sObject, prune: boolean): void
  argoRefresh(obj: K8sObject, hard: boolean): void
  /** "Copy as command": lệnh kubectl tương đương (get / describe / logs / exec…). */
  copyCommand(obj: K8sObject): void
}

/** Loại có pod template (hoặc là pod): Trivy có luật cấu hình cho chúng. */
const SCANNABLE = [
  'pods',
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'replicasets.apps',
  'jobs.batch',
  'cronjobs.batch'
]
const WORKLOADS = ['deployments.apps', 'statefulsets.apps', 'daemonsets.apps']
const SCALABLE = ['deployments.apps', 'statefulsets.apps', 'replicasets.apps']
/** Loại có selector → xem log của mọi pod. */
export const HAS_PODS = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'replicasets.apps',
  'jobs.batch',
  'services'
]

export function containersOf(obj: K8sObject): string[] {
  return ((obj.spec?.['containers'] as { name: string }[] | undefined) ?? []).map((c) => c.name)
}

export function actionsFor(
  kindId: string,
  obj: K8sObject,
  readOnly: boolean,
  h: ActionHandlers
): K8sAction[] {
  const out: K8sAction[] = []
  const ns = obj.metadata.namespace
  if (kindId === 'pods') {
    const containers = containersOf(obj)
    out.push({
      id: 'logs',
      label: t('Logs'),
      icon: <FileText size={14} />,
      key: 'l',
      run: () => {
        h.logs(obj)
      }
    })
    if (containers.length > 1)
      out.push({
        id: 'logs-all',
        label: t('Logs (all containers)'),
        icon: <FileText size={14} />,
        run: () => {
          h.logs(obj, { allContainers: true })
        }
      })
    // Chỉ đọc: Session Host từ chối shell / port-forward (mở đường vào cluster) → không hiện.
    if (!readOnly)
      out.push({
        id: 'shell',
        label: t('Open shell'),
        icon: <SquareTerminal size={14} />,
        key: 's',
        run: () => {
          h.shell(obj)
        }
      })
    for (const c of !readOnly && containers.length > 1 ? containers : [])
      out.push({
        id: `shell-${c}`,
        label: t('Shell in {container}', { container: c }),
        icon: <SquareTerminal size={14} />,
        run: () => {
          h.shell(obj, c)
        }
      })
    if (!readOnly)
      out.push({
        id: 'debug',
        label: t('Debug…'),
        icon: <Bug size={14} />,
        key: 'b',
        secondary: true,
        run: () => {
          h.debug(obj)
        }
      })
  }
  if (HAS_PODS.includes(kindId) && ns)
    out.push({
      id: 'logs',
      label: t('Logs of all pods'),
      icon: <FileText size={14} />,
      key: 'l',
      run: () => {
        h.logs(obj)
      }
    })
  if ((kindId === 'pods' || kindId === 'services') && ns && !readOnly)
    out.push({
      id: 'forward',
      label: t('Forward a port…'),
      icon: <ArrowLeftRight size={14} />,
      key: 'f',
      run: () => {
        h.forward(obj)
      }
    })
  out.push({
    id: 'yaml',
    label: t('View YAML'),
    icon: <FileCode size={14} />,
    key: 'y',
    // Bảng chi tiết đã có tab YAML.
    secondary: true,
    run: () => {
      h.yaml(obj)
    }
  })
  if (kindId === 'deployments.apps')
    out.push({
      id: 'history',
      label: t('Rollout history'),
      icon: <History size={14} />,
      key: 'h',
      run: () => {
        h.history(obj)
      }
    })
  if (SCANNABLE.includes(kindId))
    out.push({
      id: 'scan',
      label: t('Scan configuration…'),
      icon: <ShieldCheck size={14} />,
      run: () => {
        h.scan(obj)
      }
    })
  out.push({
    id: 'copy-command',
    label: t('Copy as command…'),
    icon: <TerminalSquare size={14} />,
    secondary: true,
    run: () => {
      h.copyCommand(obj)
    }
  })
  if (readOnly) return out
  if (kindId !== 'secrets') {
    out.push({
      id: 'edit',
      label: t('Edit YAML'),
      icon: <Pencil size={14} />,
      key: 'e',
      run: () => {
        h.edit(obj)
      }
    })
    out.push({
      id: 'edit-external',
      label: t('Edit in external editor'),
      icon: <Pencil size={14} />,
      run: () => {
        h.editExternal(obj)
      }
    })
  }
  if (SCALABLE.includes(kindId))
    out.push({
      id: 'scale',
      label: t('Scale…'),
      icon: <Scale size={14} />,
      key: 'S',
      run: () => {
        h.scale(obj)
      }
    })
  if (WORKLOADS.includes(kindId))
    out.push({
      id: 'restart',
      label: t('Rollout restart'),
      icon: <RotateCw size={14} />,
      key: 'r',
      run: () => {
        h.restart(obj)
      }
    })
  if (kindId === 'deployments.apps') {
    const paused = obj.spec?.['paused'] === true
    out.push({
      id: 'pause',
      label: paused ? t('Resume rollout') : t('Pause rollout'),
      icon: paused ? <Play size={14} /> : <Pause size={14} />,
      run: () => {
        h.pause(obj, !paused)
      }
    })
  }
  if (kindId === 'nodes') {
    const cordoned = obj.spec?.['unschedulable'] === true
    out.push({
      id: 'cordon',
      label: cordoned ? t('Uncordon') : t('Cordon'),
      icon: cordoned ? <Unlock size={14} /> : <Ban size={14} />,
      key: 'c',
      run: () => {
        h.cordon(obj, !cordoned)
      }
    })
    out.push({
      id: 'debug',
      label: t('Debug node…'),
      icon: <Bug size={14} />,
      key: 'b',
      secondary: true,
      run: () => {
        h.debug(obj)
      }
    })
    out.push({
      id: 'drain',
      label: t('Drain…'),
      icon: <Wind size={14} />,
      key: 'r',
      danger: true,
      run: () => {
        h.drain(obj)
      }
    })
  }
  if (kindId === 'applications.argoproj.io') {
    out.push(
      {
        id: 'argo-sync',
        label: t('Sync'),
        icon: <RefreshCcwDot size={14} />,
        run: () => {
          h.argoSync(obj, false)
        }
      },
      {
        id: 'argo-refresh',
        label: t('Refresh'),
        icon: <RotateCw size={14} />,
        key: 'r',
        run: () => {
          h.argoRefresh(obj, false)
        }
      },
      {
        id: 'argo-hard-refresh',
        label: t('Hard refresh'),
        icon: <RotateCw size={14} />,
        run: () => {
          h.argoRefresh(obj, true)
        }
      },
      {
        id: 'argo-sync-prune',
        label: t('Sync and prune…'),
        icon: <RefreshCcwDot size={14} />,
        danger: true,
        run: () => {
          h.argoSync(obj, true)
        }
      }
    )
  }
  if (kindId === 'cronjobs.batch') {
    const suspended = obj.spec?.['suspend'] === true
    out.push({
      id: 'trigger',
      label: t('Run now'),
      icon: <PlayCircle size={14} />,
      key: 't',
      run: () => {
        h.trigger(obj)
      }
    })
    out.push({
      id: 'suspend',
      label: suspended ? t('Resume schedule') : t('Suspend schedule'),
      icon: suspended ? <Play size={14} /> : <Pause size={14} />,
      run: () => {
        h.suspend(obj, !suspended)
      }
    })
  }
  if (kindId !== 'nodes' && kindId !== 'namespaces' && kindId !== 'events') {
    out.push({
      id: 'delete',
      label: t('Delete…'),
      icon: <Trash2 size={14} />,
      key: 'ctrl+d',
      danger: true,
      run: () => {
        h.remove(obj, false)
      }
    })
    if (kindId === 'pods')
      out.push({
        id: 'kill',
        label: t('Kill (no grace period)'),
        icon: <Zap size={14} />,
        key: 'ctrl+k',
        danger: true,
        run: () => {
          h.remove(obj, true)
        }
      })
  }
  return out
}

/** Hiển thị phím tắt ("ctrl+d" → "Ctrl+D"). */
export function keyLabel(key: string): string {
  return key
    .split('+')
    .map((p) =>
      p === 'ctrl' ? 'Ctrl' : p.length === 1 ? p : `${(p[0] ?? '').toUpperCase()}${p.slice(1)}`
    )
    .join('+')
}

export function toMenu(actions: readonly K8sAction[]): MenuEntry[] {
  const out: MenuEntry[] = []
  let dangerStarted = false
  for (const a of actions) {
    if (a.danger && !dangerStarted && out.length) {
      out.push('separator')
      dangerStarted = true
    }
    out.push({
      id: a.id,
      label: a.label,
      icon: a.icon,
      ...(a.key ? { hint: keyLabel(a.key) } : {}),
      ...(a.danger ? { danger: true } : {}),
      onSelect: () => {
        a.run()
      }
    })
  }
  return out
}

/** Phím tắt của sự kiện bàn phím ("l", "ctrl+d", "S"…). */
export function eventKey(e: KeyboardEvent | React.KeyboardEvent): string {
  return `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.ctrlKey || e.metaKey ? e.key.toLowerCase() : e.key}`
}
