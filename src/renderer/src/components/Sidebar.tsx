import { toast } from '../stores/toasts'
import { t, tn } from '@shared/i18n'
import {
  forwardRef,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import {
  ChevronRight,
  EyeOff,
  ExternalLink,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  Columns2,
  Copy,
  CopyPlus,
  FileInput,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  Maximize2,
  Pencil,
  Play,
  Plus,
  Radio,
  Search,
  Server,
  Star,
  StarOff,
  Tags,
  Trash2,
  X
} from 'lucide-react'
import { bestScore } from '@shared/fuzzy'
import { countHostsRecursive, groupMoveProblem } from '@shared/group-tree'
import type { GroupSummary, HostSummary } from '@shared/hosts'
import { GroupForm, HostForm, ImportDialog } from '../lazy'
import { useHosts } from '../stores/hosts'
import { useSettings } from '../stores/settings'
import { moduleHostActions } from '../../../modules/registry/renderer-kit'
import { rdpAddress } from '@shared/rdp'
import { openRdpHost } from '../stores/rdp'
import { useContextMenu, type MenuEntry } from './ContextMenu'
import {
  CONFIRM_OPEN_OVER,
  connect,
  hostsInGroup,
  MAX_GRID,
  openMany,
  sshCommandFor
} from './sidebar/actions'
import {
  ConfirmDialog,
  DeleteHostsDialog,
  MoveHostsDialog,
  TagHostsDialog
} from './sidebar/dialogs'
import { DropLine, HostRow, type DropPos, type HostRowHandlers } from './sidebar/HostRow'
import { Button, cx, IconButton } from './ui'
import { useUiRequests } from '../stores/ui-requests'
import { EnvLabel } from '../ds'
import { findEnvironment } from '@shared/environments'
import { groupOwnEnvironment, useEnvironments } from '../stores/environments'
import { LocalModuleSuggestion } from './sidebar/LocalModuleSuggestion'

// ---------- Kéo thả ----------

const DRAG_HOSTS = 'application/x-shellhouse-hosts'
const DRAG_GROUP = 'application/x-shellhouse-group'
/** dataTransfer.getData() không đọc được trong dragover → nhớ thứ đang kéo ở đây. */
let dragging: { kind: 'hosts'; ids: string[] } | { kind: 'group'; id: string } | null = null

/** Vị trí thả theo độ cao con trỏ trong hàng. Nhóm: 25% trên/dưới = trước/sau, giữa = vào trong. */
function dropPosition(e: DragEvent, allowInto: boolean, allowOrder: boolean): DropPos | null {
  const rect = e.currentTarget.getBoundingClientRect()
  const ratio = (e.clientY - rect.top) / rect.height
  if (allowInto && !allowOrder) return 'into'
  if (!allowInto) return ratio < 0.5 ? 'before' : 'after'
  return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'into'
}

// ---------- Lưu trạng thái giao diện (theo từng máy) ----------

function stored<T>(key: string, parse: (raw: string) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : parse(raw)
  } catch {
    return fallback
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Không lưu được → chỉ mất trạng thái giao diện, không ảnh hưởng dữ liệu.
  }
}

const COLLAPSED_KEY = 'shellhouse.sidebar.collapsed'
/** Khoá "nhóm" giả cho hai mục đầu sidebar (dùng chung tập thu gọn với nhóm thật). */
const FAVORITES = '__favorites'
const RECENT = '__recent'
const RECENT_COUNT = 5

const NONE: readonly HostSummary[] = []

/** dragleave cũng bắn khi con trỏ đi vào phần tử con → chỉ tính là rời khi ra hẳn khỏi phần tử. */
const leftElement = (e: DragEvent): boolean =>
  !(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))

/** Nội dung hộp xác nhận mở nhiều phiên một lúc. */
function openManyMessage(n: number, layout: 'tabs' | 'grid', broadcast: boolean): string {
  if (broadcast)
    return tn(
      n,
      'This connects to {n} host at once in a grid, and shows them all in MultiExec.',
      'This connects to {n} hosts at once in a grid, and shows them all in MultiExec.'
    )
  return layout === 'grid'
    ? tn(
        n,
        'This connects to {n} host at once in a grid.',
        'This connects to {n} hosts at once in a grid.'
      )
    : tn(n, 'This connects to {n} host at once.', 'This connects to {n} hosts at once.')
}

type Dialog =
  | { kind: 'host'; host: HostSummary | null; groupId: string | null }
  | { kind: 'group'; group: GroupSummary | null; parentId?: string | null; confirmDelete?: boolean }
  | { kind: 'import' }
  | { kind: 'delete'; hosts: HostSummary[] }
  | { kind: 'move'; hosts: HostSummary[] }
  | { kind: 'tags'; hosts: HostSummary[] }
  | { kind: 'open-many'; hosts: HostSummary[]; layout: 'tabs' | 'grid'; broadcast: boolean }

/**
 * Cây host trong Explorer của khu vực Hosts (khung app mới — shell/Explorer): ô tìm, Favorites /
 * Recent, cây nhóm lồng nhau, kéo thả, chọn nhiều, các hộp thoại host / nhóm / import.
 * memo: App vẽ lại mỗi lần đổi tab — cây (hàng nghìn host) không cần vẽ lại theo.
 */
export const Sidebar = memo(
  forwardRef<HTMLInputElement>(function Sidebar(_props, searchRef) {
    const { groups, hosts } = useHosts((s) => s.tree)
    const tree = useHosts((s) => s.groupTree)
    const environments = useEnvironments()
    const [query, setQuery] = useState('')
    const [cursor, setCursor] = useState(0)
    const [collapsed, setCollapsed] = useState<Set<string>>(() =>
      stored(
        COLLAPSED_KEY,
        (raw) => {
          const list: unknown = JSON.parse(raw)
          return new Set(
            Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
          )
        },
        new Set<string>()
      )
    )
    const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
    const anchor = useRef<string | null>(null)
    const [drop, setDrop] = useState<{ key: string; pos: DropPos } | null>(null)
    const [dialog, setDialog] = useState<Dialog | null>(null)
    // Màn chào / bảng lệnh yêu cầu mở "New host" hoặc "Import".
    useEffect(
      () =>
        useUiRequests.subscribe((state, prev) => {
          const req = state.sidebar
          if (!req || req === prev.sidebar) return
          if (req.kind === 'edit-host') {
            const host = useHosts.getState().tree.hosts.find((h) => h.id === req.hostId)
            if (host) setDialog({ kind: 'host', host, groupId: host.groupId })
            return
          }
          setDialog(
            req.kind === 'new-host'
              ? { kind: 'host', host: null, groupId: null }
              : { kind: 'import' }
          )
        }),
      []
    )
    const { menu, open: openMenu } = useContextMenu()
    const expandTimer = useRef<number | null>(null)

    const counts = useMemo(() => countHostsRecursive(tree, hosts), [tree, hosts])
    const byId = useMemo(() => new Map(hosts.map((h) => [h.id, h])), [hosts])
    const groupPath = (groupId: string | null): string =>
      groupId === null ? '' : tree.path(groupId).join(' / ')
    // Host theo nhóm, tính một lần (trước đây mỗi nhóm lọc lại toàn bộ host: O(nhóm × host)).
    const byGroup = useMemo(() => {
      const map = new Map<string | null, HostSummary[]>()
      for (const h of hosts) {
        const list = map.get(h.groupId)
        if (list) list.push(h)
        else map.set(h.groupId, [h])
      }
      return map
    }, [hosts])
    const hostsIn = (groupId: string | null): readonly HostSummary[] => byGroup.get(groupId) ?? NONE

    useEffect(() => {
      store(COLLAPSED_KEY, JSON.stringify([...collapsed]))
    }, [collapsed])
    // Host bị xoá → bỏ khỏi vùng chọn.
    useEffect(() => {
      setSelection((prev) => {
        const next = new Set([...prev].filter((id) => byId.has(id)))
        return next.size === prev.size ? prev : next
      })
    }, [byId])

    const setOpen = (id: string, open: boolean): void => {
      setCollapsed((prev) => {
        if (open !== prev.has(id)) return prev
        const next = new Set(prev)
        if (open) next.delete(id)
        else next.add(id)
        return next
      })
    }
    const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.id))

    const favorites = useMemo(() => hosts.filter((h) => h.favorite), [hosts])
    const showFavorites = useSettings((s) => s.settings.appearance.showFavorites)
    const showRecent = useSettings((s) => s.settings.appearance.showRecent)
    // Recent bỏ host đã nằm trong Favorites (đang hiện) — không lặp một host hai lần ngay trên đầu.
    const recent = useMemo(
      () =>
        hosts
          .filter((h) => h.lastUsedAt !== null && !(showFavorites && h.favorite))
          .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
          .slice(0, RECENT_COUNT),
      [hosts, showFavorites]
    )

    // Ô tìm luôn nhận phím ngay; chấm điểm hàng nghìn host chạy ở lượt vẽ ưu tiên thấp.
    const search = useDeferredValue(query)
    const searchHosts = useCallback(
      (query: string): HostSummary[] | null => {
        if (!query.trim()) return null
        return hosts
          .map((h) => ({
            h,
            // Tìm được theo cả tên nhóm: "prod db" khớp host trong Prod / DB.
            s: bestScore(query, [
              h.label,
              h.hostname,
              `${h.username}@${h.hostname}`,
              ...h.tags,
              `${h.groupId === null ? '' : tree.path(h.groupId).join(' ')} ${h.label}`
            ])
          }))
          .filter((r): r is { h: HostSummary; s: number } => r.s !== null)
          .sort((a, b) => b.s - a.s)
          .map((r) => r.h)
      },
      [hosts, tree]
    )
    const results = useMemo(() => searchHosts(search), [searchHosts, search])
    /**
     * Kết quả theo đúng chữ đang gõ — phím Enter / mũi tên dùng cái này: gõ nhanh rồi Enter khi
     * danh sách (hoãn) chưa kịp vẽ lại thì vẫn mở đúng host, không phải host của chữ cũ.
     */
    const currentResults = (): HostSummary[] | null =>
      search === query ? results : searchHosts(query)

    /** Thứ tự host đang nhìn thấy trong cây (cho Shift+click chọn dải). */
    const visibleOrder = useMemo(() => {
      if (results) return results.map((h) => h.id)
      const out: string[] = []
      const walk = (parentId: string | null): void => {
        for (const g of tree.children(parentId)) if (!collapsed.has(g.id)) walk(g.id)
        for (const h of byGroup.get(parentId) ?? NONE) out.push(h.id)
      }
      walk(null)
      return out
    }, [results, tree, byGroup, collapsed])

    const selectedHosts = (): HostSummary[] =>
      [...selection].map((id) => byId.get(id)).filter((h): h is HostSummary => !!h)

    const select = (host: HostSummary, e: MouseEvent | React.KeyboardEvent): void => {
      if (e.shiftKey && anchor.current) {
        const a = visibleOrder.indexOf(anchor.current)
        const b = visibleOrder.indexOf(host.id)
        if (a !== -1 && b !== -1) {
          const [from, to] = a < b ? [a, b] : [b, a]
          setSelection(new Set(visibleOrder.slice(from, to + 1)))
          return
        }
      }
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(selection)
        if (next.has(host.id)) next.delete(host.id)
        else next.add(host.id)
        setSelection(next)
      } else {
        setSelection(new Set([host.id]))
      }
      anchor.current = host.id
    }

    // ---------- Mở nhiều phiên ----------

    const requestOpen = (
      targets: HostSummary[],
      layout: 'tabs' | 'grid',
      broadcast = false
    ): void => {
      if (targets.length === 0) return
      if (targets.length > CONFIRM_OPEN_OVER)
        setDialog({ kind: 'open-many', hosts: targets, layout, broadcast })
      else openMany(targets, layout, broadcast)
    }

    // ---------- Menu chuột phải ----------

    const hostMenu = (e: MouseEvent, host: HostSummary): void => {
      // Chuột phải lên host chưa được chọn → chỉ chọn host đó (như trình quản lý file).
      let targets = selectedHosts()
      if (!selection.has(host.id)) {
        setSelection(new Set([host.id]))
        anchor.current = host.id
        targets = [host]
      }
      const allFavorite = targets.every((h) => h.favorite)
      const favorite: MenuEntry = {
        id: 'favorite',
        label: allFavorite ? t('Remove from favorites') : t('Add to favorites'),
        icon: allFavorite ? <StarOff size={14} /> : <Star size={14} />,
        onSelect: () =>
          void window.shellhouse.setFavorite(
            targets.map((h) => h.id),
            !allFavorite
          )
      }
      const organize: MenuEntry[] = [
        {
          id: 'move',
          label: t('Move to…'),
          icon: <FolderInput size={14} />,
          onSelect: () => {
            setDialog({ kind: 'move', hosts: targets })
          }
        },
        {
          id: 'tags',
          label: t('Tags…'),
          icon: <Tags size={14} />,
          onSelect: () => {
            setDialog({ kind: 'tags', hosts: targets })
          }
        }
      ]
      const remove: MenuEntry = {
        id: 'delete',
        label:
          targets.length === 1
            ? t('Delete…')
            : tn(targets.length, 'Delete {n} host…', 'Delete {n} hosts…'),
        icon: <Trash2 size={14} />,
        hint: 'Del',
        danger: true,
        onSelect: () => {
          setDialog({ kind: 'delete', hosts: targets })
        }
      }
      if (targets.length === 1) {
        openMenu(e, [
          {
            id: 'connect',
            label: t('Connect'),
            icon: <Play size={14} />,
            hint: 'Enter',
            onSelect: () => {
              connect(host)
            }
          },
          // Remote Desktop không có tab để chia đôi — thay bằng mở toàn màn hình.
          host.protocol === 'rdp'
            ? {
                id: 'connect-full',
                label: t('Connect full screen'),
                icon: <Maximize2 size={14} />,
                onSelect: () => {
                  openRdpHost(host.id, { fullScreen: true })
                }
              }
            : {
                id: 'split',
                label: t('Connect in split'),
                icon: <Columns2 size={14} />,
                onSelect: () => {
                  connect(host, { split: 'right' })
                }
              },
          ...(host.protocol === 'rdp' && host.rdp?.openWith !== 'native'
            ? [
                {
                  id: 'connect-external',
                  label: t('Open in external client'),
                  icon: <ExternalLink size={14} />,
                  onSelect: () => {
                    openRdpHost(host.id, { external: true })
                  }
                }
              ]
            : []),
          // SFTP và lệnh ssh chỉ có với host SSH.
          ...(host.protocol === 'ssh'
            ? [
                {
                  id: 'sftp',
                  label: t('Open SFTP'),
                  icon: <FolderOpen size={14} />,
                  onSelect: () => {
                    connect(host, { view: 'files' })
                  }
                }
              ]
            : []),
          // Docker…, Kubernetes… của các module đang bật.
          ...moduleHostActions({ hostId: host.id, label: host.label, protocol: host.protocol }),
          'separator',
          favorite,
          ...(host.protocol === 'ssh'
            ? [
                {
                  id: 'copy-ssh',
                  label: t('Copy SSH command'),
                  icon: <Copy size={14} />,
                  onSelect: () =>
                    void window.shellhouse.writeClipboard(sshCommandFor(host)).then(() => {
                      toast.success(t('SSH command copied'), { description: sshCommandFor(host) })
                    })
                }
              ]
            : []),
          ...(host.protocol === 'rdp'
            ? [
                {
                  id: 'copy-address',
                  label: t('Copy address'),
                  icon: <Copy size={14} />,
                  onSelect: () =>
                    void window.shellhouse.writeClipboard(rdpAddress(host)).then(() => {
                      toast.success(t('Address copied'), { description: rdpAddress(host) })
                    })
                }
              ]
            : []),
          {
            id: 'duplicate',
            label: t('Duplicate'),
            icon: <CopyPlus size={14} />,
            onSelect: () =>
              void window.shellhouse.duplicateHost(host.id).then((r) => {
                if (r.ok) {
                  setSelection(new Set([r.id]))
                  toast.success(t('Duplicated {name}', { name: host.label }))
                } else toast.error(t('Could not duplicate {name}', { name: host.label }))
              })
          },
          'separator',
          {
            id: 'edit',
            label: t('Edit…'),
            icon: <Pencil size={14} />,
            onSelect: () => {
              setDialog({ kind: 'host', host, groupId: host.groupId })
            }
          },
          ...organize,
          'separator',
          remove
        ])
      } else {
        openMenu(e, [
          {
            id: 'open-tabs',
            label: t('Open {n} in tabs', { n: targets.length }),
            icon: <Play size={14} />,
            onSelect: () => {
              requestOpen(targets, 'tabs')
            }
          },
          {
            id: 'open-grid',
            label: t('Open {n} in a grid', { n: targets.length }),
            icon: <LayoutGrid size={14} />,
            disabled: targets.length > MAX_GRID,
            onSelect: () => {
              requestOpen(targets, 'grid')
            }
          },
          {
            id: 'open-multiexec',
            label: t('Open in MultiExec (type into all)'),
            icon: <Radio size={14} />,
            disabled: targets.length > MAX_GRID,
            onSelect: () => {
              requestOpen(targets, 'grid', true)
            }
          },
          'separator',
          favorite,
          ...organize,
          'separator',
          remove
        ])
      }
    }

    const groupMenu = (e: MouseEvent, group: GroupSummary): void => {
      const inside = hostsInGroup(group.id)
      const n = inside.length
      const canNest = groupMoveProblem(tree, null, group.id) === null
      const descendants = [group.id, ...tree.descendants(group.id)]
      openMenu(e, [
        {
          id: 'open-tabs',
          label: n ? t('Open all {n} in tabs', { n }) : t('Open all in tabs'),
          icon: <Play size={14} />,
          disabled: n === 0,
          onSelect: () => {
            requestOpen(inside, 'tabs')
          }
        },
        {
          id: 'open-grid',
          label: t('Open all in a grid'),
          icon: <LayoutGrid size={14} />,
          disabled: n === 0 || n > MAX_GRID,
          onSelect: () => {
            requestOpen(inside, 'grid')
          }
        },
        {
          id: 'open-multiexec',
          label: t('Open all in MultiExec (type into all)'),
          icon: <Radio size={14} />,
          disabled: n < 2 || n > MAX_GRID,
          onSelect: () => {
            requestOpen(inside, 'grid', true)
          }
        },
        'separator',
        {
          id: 'add-host',
          label: t('New host here'),
          icon: <Plus size={14} />,
          onSelect: () => {
            setDialog({ kind: 'host', host: null, groupId: group.id })
          }
        },
        {
          id: 'add-subgroup',
          label: t('New subgroup'),
          icon: <FolderPlus size={14} />,
          disabled: !canNest,
          onSelect: () => {
            setDialog({ kind: 'group', group: null, parentId: group.id })
          }
        },
        'separator',
        {
          id: 'edit',
          label: t('Edit group and defaults…'),
          icon: <Pencil size={14} />,
          onSelect: () => {
            setDialog({ kind: 'group', group })
          }
        },
        {
          id: 'expand',
          label: t('Expand all inside'),
          icon: <ChevronsUpDown size={14} />,
          onSelect: () => {
            setCollapsed((prev) => new Set([...prev].filter((id) => !descendants.includes(id))))
          }
        },
        {
          id: 'collapse',
          label: t('Collapse all inside'),
          icon: <ChevronsDownUp size={14} />,
          onSelect: () => {
            setCollapsed((prev) => new Set([...prev, ...descendants]))
          }
        },
        'separator',
        {
          id: 'delete',
          label: t('Delete group…'),
          icon: <Trash2 size={14} />,
          danger: true,
          onSelect: () => {
            setDialog({ kind: 'group', group, confirmDelete: true })
          }
        }
      ])
    }

    // ---------- Kéo thả: nguồn ----------

    const clearDrop = (): void => {
      setDrop(null)
      if (expandTimer.current !== null) window.clearTimeout(expandTimer.current)
      expandTimer.current = null
    }

    /** Đặt chỗ thả; không đổi thì giữ nguyên object (không vẽ lại thanh bên mỗi lần dragover). */
    const showDrop = (key: string, pos: DropPos): void => {
      setDrop((prev) => (prev?.key === key && prev.pos === pos ? prev : { key, pos }))
    }
    const leaveDrop = (e: DragEvent): void => {
      if (leftElement(e)) clearDrop()
    }

    const hostDragStart = (host: HostSummary, e: DragEvent): void => {
      e.stopPropagation()
      // Kéo một host đang nằm trong vùng chọn → kéo cả vùng chọn.
      const ids = selection.has(host.id) ? [...selection] : [host.id]
      dragging = { kind: 'hosts', ids }
      e.dataTransfer.setData(DRAG_HOSTS, JSON.stringify(ids))
      e.dataTransfer.effectAllowed = 'move'
    }
    const dragEnd = (): void => {
      dragging = null
      clearDrop()
    }

    /** Kéo nhóm tới vị trí mới (trong `parentId`): hợp lệ không? */
    const groupFits = (movingId: string, parentId: string | null): boolean => {
      const moving = tree.byId.get(movingId)
      if (!moving) return false
      if (moving.parentId === parentId) return true
      if (groupMoveProblem(tree, movingId, parentId)) return false
      return !tree
        .children(parentId)
        .some(
          (g) =>
            g.id !== movingId &&
            g.name.localeCompare(moving.name, undefined, { sensitivity: 'base' }) === 0
        )
    }

    // ---------- Kéo thả: đích ----------

    /** Thả lên một host trong cây: sắp xếp (trước / sau host đó, trong nhóm của nó). */
    const hostDragOver = (target: HostSummary, e: DragEvent): void => {
      if (dragging?.kind !== 'hosts' || dragging.ids.includes(target.id)) return
      e.preventDefault()
      e.stopPropagation()
      const pos = dropPosition(e, false, true)
      if (pos) showDrop(target.id, pos)
    }
    const hostDropOn = (target: HostSummary, e: DragEvent): void => {
      if (dragging?.kind !== 'hosts') return
      e.preventDefault()
      e.stopPropagation()
      const pos = dropPosition(e, false, true)
      const ids = dragging.ids
      const order = hostsIn(target.groupId)
        .map((h) => h.id)
        .filter((id) => !ids.includes(id))
      let index = order.indexOf(target.id)
      if (pos === 'after') index++
      order.splice(index, 0, ...ids)
      clearDrop()
      void window.shellhouse.reorderHosts(target.groupId, order)
    }

    /** Thả lên một nhóm: host → vào nhóm; nhóm → trước / vào trong / sau. */
    const groupDrop = (group: GroupSummary) => {
      const accept = (e: DragEvent): DropPos | null => {
        if (dragging?.kind === 'hosts') return 'into'
        if (dragging?.kind !== 'group' || dragging.id === group.id) return null
        const pos = dropPosition(e, true, true)
        if (pos === 'into') return groupFits(dragging.id, group.id) ? 'into' : null
        return pos && groupFits(dragging.id, group.parentId) ? pos : null
      }
      return {
        onDragOver: (e: DragEvent) => {
          const pos = accept(e)
          if (!pos) return
          e.preventDefault()
          e.stopPropagation()
          if (drop?.key !== group.id || drop.pos !== pos) {
            showDrop(group.id, pos)
            // Giữ lâu trên nhóm đang thu gọn → tự mở ra để thả vào sâu hơn.
            if (expandTimer.current !== null) window.clearTimeout(expandTimer.current)
            expandTimer.current =
              pos === 'into' && collapsed.has(group.id)
                ? window.setTimeout(() => {
                    setOpen(group.id, true)
                  }, 700)
                : null
          }
        },
        onDragLeave: leaveDrop,
        onDrop: (e: DragEvent) => {
          const pos = accept(e)
          const current = dragging
          clearDrop()
          if (!pos || !current) return
          e.preventDefault()
          e.stopPropagation()
          if (current.kind === 'hosts') {
            void window.shellhouse.moveHosts(current.ids, group.id)
            setOpen(group.id, true)
          } else if (pos === 'into') {
            void window.shellhouse.moveGroup(current.id, group.id)
            setOpen(group.id, true)
          } else {
            const order = tree
              .children(group.parentId)
              .map((g) => g.id)
              .filter((id) => id !== current.id)
            let index = order.indexOf(group.id)
            if (pos === 'after') index++
            order.splice(index, 0, current.id)
            void window.shellhouse.reorderGroups(group.parentId, order)
          }
        }
      }
    }

    /** Vùng "không nhóm" (cuối cây): host / nhóm ra cấp cao nhất. */
    const rootDrop = {
      onDragOver: (e: DragEvent) => {
        if (!dragging) return
        if (dragging.kind === 'group' && !groupFits(dragging.id, null)) return
        e.preventDefault()
        showDrop('root', 'into')
      },
      onDragLeave: leaveDrop,
      onDrop: (e: DragEvent) => {
        const current = dragging
        clearDrop()
        if (!current) return
        e.preventDefault()
        if (current.kind === 'hosts') void window.shellhouse.moveHosts(current.ids, null)
        else void window.shellhouse.moveGroup(current.id, null)
      }
    }

    /** Thả host lên tiêu đề Favorites → đánh dấu yêu thích. */
    const favoritesDrop = {
      onDragOver: (e: DragEvent) => {
        if (dragging?.kind !== 'hosts') return
        e.preventDefault()
        showDrop(FAVORITES, 'into')
      },
      onDragLeave: leaveDrop,
      onDrop: (e: DragEvent) => {
        const current = dragging
        clearDrop()
        if (current?.kind !== 'hosts') return
        e.preventDefault()
        void window.shellhouse.setFavorite(current.ids, true)
        setOpen(FAVORITES, true)
      }
    }

    // ---------- Vẽ ----------

    // Thao tác mới nhất (đọc state hiện tại) sau một object ổn định → HostRow (memo) chỉ vẽ lại khi
    // chính hàng đó đổi (chọn / chỗ thả / dữ liệu host), không phải cả cây mỗi lần thanh bên vẽ lại.
    const latest = {
      select,
      open: (host: HostSummary) => {
        connect(host)
      },
      edit: (host: HostSummary) => {
        setDialog({ kind: 'host', host, groupId: host.groupId })
      },
      contextMenu: (host: HostSummary, e: MouseEvent) => {
        hostMenu(e, host)
      },
      dragStart: hostDragStart,
      dragEnd,
      dragOver: hostDragOver,
      dragLeave: leaveDrop,
      drop: hostDropOn
    } satisfies HostRowHandlers
    const latestRef = useRef(latest)
    useLayoutEffect(() => {
      latestRef.current = latest
    })
    const handlers = useMemo<HostRowHandlers>(
      () => ({
        select: (h, e) => {
          latestRef.current.select(h, e)
        },
        open: (h) => {
          latestRef.current.open(h)
        },
        edit: (h) => {
          latestRef.current.edit(h)
        },
        contextMenu: (h, e) => {
          latestRef.current.contextMenu(h, e)
        },
        dragStart: (h, e) => {
          latestRef.current.dragStart(h, e)
        },
        dragEnd: () => {
          latestRef.current.dragEnd()
        },
        dragOver: (h, e) => {
          latestRef.current.dragOver(h, e)
        },
        dragLeave: (e) => {
          latestRef.current.dragLeave(e)
        },
        drop: (h, e) => {
          latestRef.current.drop(h, e)
        }
      }),
      []
    )
    const rowProps = (host: HostSummary) => ({
      host,
      selected: selection.has(host.id),
      handlers
    })

    const renderGroup = (group: GroupSummary): React.JSX.Element => {
      const open = !collapsed.has(group.id)
      const count = counts.get(group.id) ?? 0
      const children = tree.children(group.id)
      const members = hostsIn(group.id)
      const empty = children.length === 0 && members.length === 0
      const canNest = groupMoveProblem(tree, null, group.id) === null
      const groupEnv = findEnvironment(environments, groupOwnEnvironment(group.defaults))
      const hint = drop?.key === group.id ? drop.pos : null
      const FolderIcon = open && !empty ? FolderOpen : Folder
      return (
        <div
          key={group.id}
          role="treeitem"
          aria-expanded={open}
          aria-label={group.name}
          data-tree-item=""
          data-tree-key={`group:${group.id}`}
          data-group-id={group.id}
          className="rounded-ds-md outline-none [&:focus-visible>div:first-child]:shadow-ds-focus"
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || e.key !== 'Enter') return
            e.preventDefault()
            setOpen(group.id, !open)
          }}
        >
          <div
            className={cx(
              'group relative flex h-(--ds-tree-row-h) cursor-default items-center gap-1.5 rounded-ds-md pr-1 pl-1 text-[13px] text-fg transition-colors duration-100 hover:bg-ds-hover',
              hint === 'into' && 'bg-accent-soft ring-1 ring-accent'
            )}
            draggable
            data-testid="group-row"
            data-group-name={group.name}
            data-group-path={groupPath(group.id)}
            onDragStart={(e) => {
              dragging = { kind: 'group', id: group.id }
              e.dataTransfer.setData(DRAG_GROUP, group.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => {
              dragging = null
              clearDrop()
            }}
            onDoubleClick={() => {
              setOpen(group.id, !open)
            }}
            onContextMenu={(e) => {
              groupMenu(e, group)
            }}
            {...groupDrop(group)}
          >
            <DropLine pos={hint} />
            <button
              type="button"
              tabIndex={-1}
              aria-label={
                open
                  ? t('Collapse {name}', { name: group.name })
                  : t('Expand {name}', { name: group.name })
              }
              className="flex size-5 shrink-0 items-center justify-center rounded text-faint hover:text-fg"
              onClick={() => {
                setOpen(group.id, !open)
              }}
            >
              <ChevronRight
                size={14}
                className={cx('transition-transform duration-150', open && 'rotate-90')}
              />
            </button>
            <FolderIcon size={15} strokeWidth={1.6} className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate">{group.name}</span>
            {/* Môi trường đặt ở nhóm (thiết kế v0.5): nhãn ô vuông — Prod magenta, còn lại trung
                tính; nhóm con / host kế thừa, không lặp nhãn. */}
            {groupEnv && <EnvLabel env={groupEnv} className="group-hover:hidden" />}
            <span
              className="min-w-4 text-right text-xs text-faint tabular-nums group-hover:hidden"
              data-testid="group-count"
              title={tn(count, '{n} host including subgroups', '{n} hosts including subgroups')}
            >
              {count}
            </span>
            <span className="hidden items-center group-hover:flex">
              <IconButton
                label={t('Add host to {name}', { name: group.name })}
                size="sm"
                data-testid="group-add-host"
                onClick={() => {
                  setDialog({ kind: 'host', host: null, groupId: group.id })
                }}
              >
                <Plus size={13} />
              </IconButton>
              {canNest && (
                <IconButton
                  label={t('New subgroup in {name}', { name: group.name })}
                  size="sm"
                  data-testid="group-add-subgroup"
                  onClick={() => {
                    setDialog({ kind: 'group', group: null, parentId: group.id })
                  }}
                >
                  <FolderPlus size={13} />
                </IconButton>
              )}
              <IconButton
                label={t('Edit group {name}', { name: group.name })}
                size="sm"
                data-testid="group-edit"
                onClick={() => {
                  setDialog({ kind: 'group', group })
                }}
              >
                <Pencil size={12} />
              </IconButton>
            </span>
          </div>
          {open && (
            // Đường kẻ dọc nối các mục cùng nhóm → nhìn ra ngay cấp của từng mục.
            <div role="group" className="ml-[13px] border-l border-line pl-1.5">
              {children.map((g) => renderGroup(g))}
              {members.map((h) => (
                <HostRow
                  key={h.id}
                  {...rowProps(h)}
                  dropPos={drop?.key === h.id ? drop.pos : null}
                  dnd="sort"
                />
              ))}
              {empty && <p className="py-1 pl-2 text-xs text-faint italic">{t('Empty')}</p>}
            </div>
          )}
        </div>
      )
    }

    const section = (
      id: string,
      title: string,
      icon: ReactNode,
      items: HostSummary[],
      testId: string,
      dropTarget?: typeof favoritesDrop
    ): React.JSX.Element | null => {
      // Mục trống thì ẩn. (Không tự hiện khi bắt đầu kéo: danh sách sẽ bị đẩy xuống giữa lúc kéo.)
      if (items.length === 0) return null
      const open = !collapsed.has(id)
      return (
        <div className="mb-1" data-testid={`section-${testId}`}>
          <button
            type="button"
            aria-expanded={open}
            className={cx(
              'flex h-7 w-full items-center gap-1.5 rounded-ds-md px-1 text-xs font-medium text-faint hover:text-muted',
              drop?.key === id && 'bg-accent-soft text-accent ring-1 ring-accent'
            )}
            onClick={() => {
              setOpen(id, !open)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              openMenu(e, [
                {
                  id: `hide-${testId}`,
                  label: id === RECENT ? t('Hide Recent') : t('Hide Favorites'),
                  icon: <EyeOff size={14} />,
                  hint: t('Settings → Appearance'),
                  onSelect: () =>
                    void useSettings.getState().update({
                      appearance: id === RECENT ? { showRecent: false } : { showFavorites: false }
                    })
                }
              ])
            }}
            {...(dropTarget ?? {})}
          >
            <ChevronRight
              size={13}
              className={cx('transition-transform duration-150', open && 'rotate-90')}
            />
            {icon}
            <span className="flex-1 text-left">{title}</span>
            <span className="tabular-nums">{items.length || ''}</span>
          </button>
          {open &&
            items.map((h) => (
              <HostRow
                key={h.id}
                {...rowProps(h)}
                testId={testId}
                groupPath={groupPath(h.groupId)}
                dnd="drag"
                compact
              />
            ))}
        </div>
      )
    }

    // ---------- Bàn phím trong cây (roving tabindex, ↑/↓, ←/→, Home/End) ----------

    const treeRef = useRef<HTMLDivElement>(null)
    const rovingKey = useRef<string | null>(null)
    // Sau mỗi lần vẽ: đúng MỘT mục có tabindex=0 (mục focus gần nhất, không còn thì mục đầu). Đặt
    // thẳng lên DOM — không phải vẽ lại hàng nào; ~2000 phần tử mất dưới 1 ms.
    useLayoutEffect(() => {
      const root = treeRef.current
      if (!root) return
      const items = root.querySelectorAll<HTMLElement>('[data-tree-item]')
      let current: HTMLElement | null = null
      if (rovingKey.current)
        current = root.querySelector<HTMLElement>(
          `[data-tree-key="${CSS.escape(rovingKey.current)}"]`
        )
      current ??= items[0] ?? null
      for (const el of items) {
        const want = el === current ? '0' : '-1'
        if (el.getAttribute('tabindex') !== want) el.setAttribute('tabindex', want)
      }
    })

    /** Phím điều hướng trong cây; true = đã xử lý. */
    const treeNavigate = (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
      const item = e.target
      if (!(item instanceof HTMLElement) || !item.hasAttribute('data-tree-item')) return false
      const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-tree-item]')]
      const index = items.indexOf(item)
      const groupId = item.dataset['groupId']
      const focus = (el: HTMLElement | null | undefined): void => {
        el?.focus()
        el?.scrollIntoView({ block: 'nearest' })
      }
      const parentGroup = (): HTMLElement | null =>
        item.parentElement?.closest<HTMLElement>('[data-tree-item][data-group-id]') ?? null
      switch (e.key) {
        case 'ArrowDown':
          focus(items[index + 1])
          break
        case 'ArrowUp':
          focus(items[index - 1])
          break
        case 'Home':
          focus(items[0])
          break
        case 'End':
          focus(items.at(-1))
          break
        case 'ArrowRight':
          if (!groupId) return false
          if (collapsed.has(groupId)) setOpen(groupId, true)
          else {
            const next = items[index + 1]
            if (next && item.contains(next)) focus(next)
          }
          break
        case 'ArrowLeft':
          if (groupId && !collapsed.has(groupId)) setOpen(groupId, false)
          else focus(parentGroup())
          break
        default:
          return false
      }
      e.preventDefault()
      return true
    }

    const selected = selectedHosts()
    const closeDialog = (): void => {
      setDialog(null)
    }

    return (
      <aside className="relative flex min-h-0 flex-1" data-testid="sidebar">
        <div data-testid="sidebar-panel" className="relative flex min-w-0 flex-1 flex-col">
          <div className="flex flex-col gap-2 px-2.5 pb-1">
            <div className="flex h-ds-ctl items-center gap-2 rounded-ds-md border border-ds-border-control bg-ds-surface-1 px-2 transition-[border-color,box-shadow] duration-(--ds-dur-fast) focus-within:border-ds-accent focus-within:ring-3 focus-within:ring-ds-accent-soft hover:border-faint">
              <Search size={14} className="text-faint" />
              <input
                ref={searchRef}
                type="search"
                spellCheck={false}
                placeholder={t('Search hosts…')}
                data-testid="host-search"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setCursor(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    if (query) setQuery('')
                    return
                  }
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return
                  const current = currentResults()
                  if (!current) return
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setCursor((c) => Math.min(c + 1, current.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setCursor((c) => Math.max(c - 1, 0))
                  } else {
                    const host = current[Math.min(cursor, current.length - 1)]
                    if (host) {
                      connect(host)
                      setQuery('')
                    }
                  }
                }}
              />
            </div>
            {/* Tiêu đề "Groups" + thao tác (thiết kế v0.5): nhóm mới, nhập host, gập / mở hết. */}
            <div className="-mb-1 flex h-7 items-center gap-0.5 pl-2 text-xs font-medium text-faint">
              <span className="flex-1">{t('Groups')}</span>
              <IconButton
                label={t('New group')}
                size="sm"
                data-testid="add-group"
                onClick={() => {
                  setDialog({ kind: 'group', group: null })
                }}
              >
                <FolderPlus size={14} />
              </IconButton>
              <IconButton
                label={t('Import hosts from ~/.ssh/config, MobaXterm or CSV')}
                size="sm"
                data-testid="import-ssh-config"
                onClick={() => {
                  setDialog({ kind: 'import' })
                }}
              >
                <FileInput size={14} />
              </IconButton>
              <IconButton
                label={allCollapsed ? t('Expand all groups') : t('Collapse all groups')}
                size="sm"
                data-testid="toggle-all-groups"
                disabled={groups.length === 0}
                onClick={() => {
                  setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.id)))
                }}
              >
                {allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
              </IconButton>
            </div>
          </div>

          <div
            ref={treeRef}
            role="tree"
            aria-label={t('Hosts')}
            aria-multiselectable
            className="min-h-0 flex-1 overflow-auto px-2 pb-2"
            onFocus={(e) => {
              // Roving tabindex: mục vừa nhận focus (chuột hoặc phím) là điểm dừng Tab duy nhất.
              const item = e.target
              if (!(item instanceof HTMLElement) || !item.hasAttribute('data-tree-item')) return
              rovingKey.current = item.dataset['treeKey'] ?? null
              for (const el of e.currentTarget.querySelectorAll<HTMLElement>(
                '[data-tree-item][tabindex="0"]'
              ))
                if (el !== item) el.tabIndex = -1
              item.tabIndex = 0
            }}
            onKeyDown={(e) => {
              if (e.target instanceof HTMLInputElement) return
              if (treeNavigate(e)) return
              if (e.key === 'Escape' && selection.size > 0) {
                e.stopPropagation()
                setSelection(new Set())
              } else if (e.key === 'Delete' && selection.size > 0) {
                e.preventDefault()
                setDialog({ kind: 'delete', hosts: selected })
              } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') {
                e.preventDefault()
                setSelection(new Set(visibleOrder))
              }
            }}
            onClick={(e) => {
              // Bấm vào chỗ trống → bỏ chọn.
              if (e.target === e.currentTarget) setSelection(new Set())
            }}
          >
            {results ? (
              results.length === 0 ? (
                <p className="px-2 py-3 text-xs text-faint">{t('No matching hosts.')}</p>
              ) : (
                results.map((h, i) => (
                  <HostRow
                    key={h.id}
                    {...rowProps(h)}
                    active={i === cursor}
                    groupPath={groupPath(h.groupId)}
                  />
                ))
              )
            ) : (
              <>
                {showFavorites &&
                  section(
                    FAVORITES,
                    t('Favorites'),
                    <Star size={12} />,
                    favorites,
                    'favorite-row',
                    favoritesDrop
                  )}
                {showRecent &&
                  section(RECENT, t('Recent'), <Clock size={12} />, recent, 'recent-row')}
                {((showFavorites && favorites.length > 0) || (showRecent && recent.length > 0)) && (
                  <div className="mx-1 mb-1.5 h-px bg-line" />
                )}
                {tree.children(null).map((g) => renderGroup(g))}
                <div
                  className={cx(
                    // Chưa có host nào: không cần chừa chỗ thả (thẻ "Add your servers" nằm ngay dưới).
                    'rounded-md',
                    (hosts.length > 0 || groups.length > 0) && 'min-h-8',
                    drop?.key === 'root' && 'bg-accent-soft ring-1 ring-accent'
                  )}
                  data-testid="ungrouped"
                  {...rootDrop}
                >
                  {hostsIn(null).map((h) => (
                    <HostRow
                      key={h.id}
                      {...rowProps(h)}
                      dropPos={drop?.key === h.id ? drop.pos : null}
                      dnd="sort"
                    />
                  ))}
                </div>
                {hosts.length === 0 && groups.length === 0 && (
                  <div
                    className="mx-1 mt-1 rounded-lg border border-line bg-subtle/50 p-3"
                    data-testid="sidebar-get-started"
                  >
                    <p className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                      <Server size={14} className="text-accent" /> {t('Add your servers')}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {t('Save a host once, then connect with a double-click.')}
                    </p>
                    <div className="mt-2.5 flex gap-1.5">
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<Plus size={13} />}
                        className="flex-1"
                        data-testid="empty-add-host"
                        onClick={() => {
                          setDialog({ kind: 'host', host: null, groupId: null })
                        }}
                      >
                        {t('Add host')}
                      </Button>
                      <Button
                        size="sm"
                        icon={<FileInput size={13} />}
                        className="flex-1"
                        data-testid="empty-import"
                        onClick={() => {
                          setDialog({ kind: 'import' })
                        }}
                      >
                        {t('Import')}
                      </Button>
                    </div>
                  </div>
                )}
                <LocalModuleSuggestion />
              </>
            )}
          </div>

          {selected.length > 1 && (
            <div
              className="animate-fade-in flex items-center gap-0.5 border-t border-line bg-subtle/60 px-2 py-1.5"
              data-testid="selection-bar"
            >
              <span className="mr-auto pl-1 text-xs font-medium text-fg">
                {t('{n} selected', { n: selected.length })}
              </span>
              <IconButton
                label={t('Open {n} in tabs', { n: selected.length })}
                size="sm"
                className="size-7"
                onClick={() => {
                  requestOpen(selected, 'tabs')
                }}
              >
                <Play size={14} />
              </IconButton>
              <IconButton
                label={t('Move to…')}
                size="sm"
                className="size-7"
                data-testid="selection-move"
                onClick={() => {
                  setDialog({ kind: 'move', hosts: selected })
                }}
              >
                <FolderInput size={14} />
              </IconButton>
              <IconButton
                label={t('Tags…')}
                size="sm"
                className="size-7"
                data-testid="selection-tags"
                onClick={() => {
                  setDialog({ kind: 'tags', hosts: selected })
                }}
              >
                <Tags size={14} />
              </IconButton>
              <IconButton
                label={t('Delete…')}
                size="sm"
                className="size-7 hover:text-danger"
                data-testid="selection-delete"
                onClick={() => {
                  setDialog({ kind: 'delete', hosts: selected })
                }}
              >
                <Trash2 size={14} />
              </IconButton>
              <IconButton
                label={t('Clear selection')}
                size="sm"
                className="size-7"
                onClick={() => {
                  setSelection(new Set())
                }}
              >
                <X size={14} />
              </IconButton>
            </div>
          )}
        </div>

        {menu}
        {dialog?.kind === 'host' && (
          <HostForm host={dialog.host} defaultGroupId={dialog.groupId} onClose={closeDialog} />
        )}
        {dialog?.kind === 'group' && (
          <GroupForm
            group={dialog.group}
            defaultParentId={dialog.parentId ?? null}
            startWithDelete={dialog.confirmDelete ?? false}
            onClose={closeDialog}
          />
        )}
        {dialog?.kind === 'import' && <ImportDialog onClose={closeDialog} />}
        {dialog?.kind === 'delete' && (
          <DeleteHostsDialog
            hosts={dialog.hosts}
            onDone={() => {
              setSelection(new Set())
            }}
            onClose={closeDialog}
          />
        )}
        {dialog?.kind === 'move' && <MoveHostsDialog hosts={dialog.hosts} onClose={closeDialog} />}
        {dialog?.kind === 'tags' && <TagHostsDialog hosts={dialog.hosts} onClose={closeDialog} />}
        {dialog?.kind === 'open-many' && (
          <ConfirmDialog
            title={tn(dialog.hosts.length, 'Open {n} session?', 'Open {n} sessions?')}
            message={openManyMessage(dialog.hosts.length, dialog.layout, dialog.broadcast)}
            confirmLabel={t('Open all')}
            onConfirm={() => {
              openMany(dialog.hosts, dialog.layout, dialog.broadcast)
            }}
            onClose={closeDialog}
          />
        )}
      </aside>
    )
  })
)
