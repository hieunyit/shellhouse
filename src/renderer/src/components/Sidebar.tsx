import {
  forwardRef,
  useEffect,
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
import { Logo } from './Logo'
import { useHosts } from '../stores/hosts'
import { useSettings } from '../stores/settings'
import { S3Section } from '../s3/S3Section'
import { useContextMenu, type MenuEntry } from './ContextMenu'
import { hostTextClass } from './hostColors'
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
import { DropLine, HostRow, type DropPos } from './sidebar/HostRow'
import { Button, cx, IconButton } from './ui'
import { useUiRequests } from '../stores/ui-requests'

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

const WIDTH_KEY = 'shellhouse.sidebar.width'
const WIDTH = { min: 208, default: 272, max: 520 }
const COLLAPSED_KEY = 'shellhouse.sidebar.collapsed'
/** Khoá "nhóm" giả cho hai mục đầu sidebar (dùng chung tập thu gọn với nhóm thật). */
const FAVORITES = '__favorites'
const RECENT = '__recent'
const RECENT_COUNT = 5

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

type Dialog =
  | { kind: 'host'; host: HostSummary | null; groupId: string | null }
  | { kind: 'group'; group: GroupSummary | null; parentId?: string | null; confirmDelete?: boolean }
  | { kind: 'import' }
  | { kind: 'delete'; hosts: HostSummary[] }
  | { kind: 'move'; hosts: HostSummary[] }
  | { kind: 'tags'; hosts: HostSummary[] }
  | { kind: 'open-many'; hosts: HostSummary[]; layout: 'tabs' | 'grid'; broadcast: boolean }

export const Sidebar = forwardRef<HTMLInputElement>(function Sidebar(_props, searchRef) {
  const { groups, hosts } = useHosts((s) => s.tree)
  const tree = useHosts((s) => s.groupTree)
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
  const [width, setWidth] = useState(() =>
    stored(
      WIDTH_KEY,
      (raw) => {
        const n = Number(raw)
        return n >= WIDTH.min && n <= WIDTH.max ? n : WIDTH.default
      },
      WIDTH.default
    )
  )
  const [resizing, setResizing] = useState(false)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const anchor = useRef<string | null>(null)
  const [drop, setDrop] = useState<{ key: string; pos: DropPos } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  // Màn chào / bảng lệnh yêu cầu mở "New host" hoặc "Import".
  useEffect(
    () =>
      useUiRequests.subscribe((state, prev) => {
        if (!state.sidebar || state.sidebar === prev.sidebar) return
        setDialog(
          state.sidebar.kind === 'new-host'
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
  const hostsIn = (groupId: string | null): HostSummary[] =>
    hosts.filter((h) => h.groupId === groupId)

  useEffect(() => {
    store(COLLAPSED_KEY, JSON.stringify([...collapsed]))
  }, [collapsed])
  useEffect(() => {
    store(WIDTH_KEY, String(width))
  }, [width])
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
  const recent = useMemo(
    () =>
      hosts
        .filter((h) => h.lastUsedAt !== null)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, RECENT_COUNT),
    [hosts]
  )

  const results = useMemo(() => {
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
  }, [hosts, query, tree])

  /** Thứ tự host đang nhìn thấy trong cây (cho Shift+click chọn dải). */
  const visibleOrder = useMemo(() => {
    if (results) return results.map((h) => h.id)
    const out: string[] = []
    const walk = (parentId: string | null): void => {
      for (const g of tree.children(parentId)) if (!collapsed.has(g.id)) walk(g.id)
      out.push(...hosts.filter((h) => h.groupId === parentId).map((h) => h.id))
    }
    walk(null)
    return out
  }, [results, tree, hosts, collapsed])

  const selectedHosts = (): HostSummary[] =>
    [...selection].map((id) => byId.get(id)).filter((h): h is HostSummary => !!h)

  const select = (host: HostSummary, e: MouseEvent): void => {
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
      label: allFavorite ? 'Remove from favorites' : 'Add to favorites',
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
        label: 'Move to…',
        icon: <FolderInput size={14} />,
        onSelect: () => {
          setDialog({ kind: 'move', hosts: targets })
        }
      },
      {
        id: 'tags',
        label: 'Tags…',
        icon: <Tags size={14} />,
        onSelect: () => {
          setDialog({ kind: 'tags', hosts: targets })
        }
      }
    ]
    const remove: MenuEntry = {
      id: 'delete',
      label: targets.length === 1 ? 'Delete…' : `Delete ${plural(targets.length, 'host')}…`,
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
          label: 'Connect',
          icon: <Play size={14} />,
          hint: 'Enter',
          onSelect: () => {
            connect(host)
          }
        },
        {
          id: 'split',
          label: 'Connect in split',
          icon: <Columns2 size={14} />,
          onSelect: () => {
            connect(host, { split: 'right' })
          }
        },
        // SFTP và lệnh ssh chỉ có với host SSH.
        ...(host.protocol === 'ssh'
          ? [
              {
                id: 'sftp',
                label: 'Open SFTP',
                icon: <FolderOpen size={14} />,
                onSelect: () => {
                  connect(host, { view: 'files' })
                }
              }
            ]
          : []),
        'separator',
        favorite,
        ...(host.protocol === 'ssh'
          ? [
              {
                id: 'copy-ssh',
                label: 'Copy SSH command',
                icon: <Copy size={14} />,
                onSelect: () => void window.shellhouse.writeClipboard(sshCommandFor(host))
              }
            ]
          : []),
        {
          id: 'duplicate',
          label: 'Duplicate',
          icon: <CopyPlus size={14} />,
          onSelect: () =>
            void window.shellhouse.duplicateHost(host.id).then((r) => {
              if (r.ok) setSelection(new Set([r.id]))
            })
        },
        'separator',
        {
          id: 'edit',
          label: 'Edit…',
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
          label: `Open ${targets.length} in tabs`,
          icon: <Play size={14} />,
          onSelect: () => {
            requestOpen(targets, 'tabs')
          }
        },
        {
          id: 'open-grid',
          label: `Open ${targets.length} in a grid`,
          icon: <LayoutGrid size={14} />,
          disabled: targets.length > MAX_GRID,
          onSelect: () => {
            requestOpen(targets, 'grid')
          }
        },
        {
          id: 'open-multiexec',
          label: 'Open in MultiExec (type into all)',
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
        label: n ? `Open all ${n} in tabs` : 'Open all in tabs',
        icon: <Play size={14} />,
        disabled: n === 0,
        onSelect: () => {
          requestOpen(inside, 'tabs')
        }
      },
      {
        id: 'open-grid',
        label: 'Open all in a grid',
        icon: <LayoutGrid size={14} />,
        disabled: n === 0 || n > MAX_GRID,
        onSelect: () => {
          requestOpen(inside, 'grid')
        }
      },
      {
        id: 'open-multiexec',
        label: 'Open all in MultiExec (type into all)',
        icon: <Radio size={14} />,
        disabled: n < 2 || n > MAX_GRID,
        onSelect: () => {
          requestOpen(inside, 'grid', true)
        }
      },
      'separator',
      {
        id: 'add-host',
        label: 'New host here',
        icon: <Plus size={14} />,
        onSelect: () => {
          setDialog({ kind: 'host', host: null, groupId: group.id })
        }
      },
      {
        id: 'add-subgroup',
        label: 'New subgroup',
        icon: <FolderPlus size={14} />,
        disabled: !canNest,
        onSelect: () => {
          setDialog({ kind: 'group', group: null, parentId: group.id })
        }
      },
      'separator',
      {
        id: 'edit',
        label: 'Edit group and defaults…',
        icon: <Pencil size={14} />,
        onSelect: () => {
          setDialog({ kind: 'group', group })
        }
      },
      {
        id: 'expand',
        label: 'Expand all inside',
        icon: <ChevronsUpDown size={14} />,
        onSelect: () => {
          setCollapsed((prev) => new Set([...prev].filter((id) => !descendants.includes(id))))
        }
      },
      {
        id: 'collapse',
        label: 'Collapse all inside',
        icon: <ChevronsDownUp size={14} />,
        onSelect: () => {
          setCollapsed((prev) => new Set([...prev, ...descendants]))
        }
      },
      'separator',
      {
        id: 'delete',
        label: 'Delete group…',
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

  const hostDrag = (host: HostSummary) => ({
    onDragStart: (e: DragEvent) => {
      e.stopPropagation()
      // Kéo một host đang nằm trong vùng chọn → kéo cả vùng chọn.
      const ids = selection.has(host.id) ? [...selection] : [host.id]
      dragging = { kind: 'hosts', ids }
      e.dataTransfer.setData(DRAG_HOSTS, JSON.stringify(ids))
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragEnd: () => {
      dragging = null
      clearDrop()
    }
  })

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
  const hostDrop = (target: HostSummary) => ({
    onDragOver: (e: DragEvent) => {
      if (dragging?.kind !== 'hosts' || dragging.ids.includes(target.id)) return
      e.preventDefault()
      e.stopPropagation()
      const pos = dropPosition(e, false, true)
      if (pos && (drop?.key !== target.id || drop.pos !== pos)) setDrop({ key: target.id, pos })
    },
    onDragLeave: clearDrop,
    onDrop: (e: DragEvent) => {
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
  })

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
          setDrop({ key: group.id, pos })
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
      onDragLeave: clearDrop,
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
      if (drop?.key !== 'root') setDrop({ key: 'root', pos: 'into' })
    },
    onDragLeave: clearDrop,
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
      if (drop?.key !== FAVORITES) setDrop({ key: FAVORITES, pos: 'into' })
    },
    onDragLeave: clearDrop,
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

  const rowProps = (host: HostSummary) => ({
    host,
    selected: selection.has(host.id),
    onSelect: (e: MouseEvent) => {
      select(host, e)
    },
    onOpen: () => {
      connect(host)
    },
    onEdit: () => {
      setDialog({ kind: 'host', host, groupId: host.groupId })
    },
    onContextMenu: (e: MouseEvent) => {
      hostMenu(e, host)
    }
  })

  const renderGroup = (group: GroupSummary): React.JSX.Element => {
    const open = !collapsed.has(group.id)
    const count = counts.get(group.id) ?? 0
    const children = tree.children(group.id)
    const members = hostsIn(group.id)
    const empty = children.length === 0 && members.length === 0
    const canNest = groupMoveProblem(tree, null, group.id) === null
    const color = group.defaults.color
    const hint = drop?.key === group.id ? drop.pos : null
    const FolderIcon = open && !empty ? FolderOpen : Folder
    return (
      <div key={group.id} role="treeitem" aria-expanded={open} aria-label={group.name}>
        <div
          className={cx(
            'group relative flex h-8 cursor-default items-center gap-1.5 rounded-md pr-1 pl-1 text-[13px] text-fg transition-colors duration-100 hover:bg-hover',
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
            aria-label={open ? `Collapse ${group.name}` : `Expand ${group.name}`}
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
          <FolderIcon
            size={15}
            className={cx('shrink-0', color ? hostTextClass[color] : 'text-muted')}
          />
          <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
          <span
            className="rounded-full bg-subtle px-1.5 text-[11px] leading-4 text-faint tabular-nums group-hover:hidden"
            data-testid="group-count"
            title={`${plural(count, 'host')} including subgroups`}
          >
            {count}
          </span>
          <span className="hidden items-center group-hover:flex">
            <IconButton
              label={`Add host to ${group.name}`}
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
                label={`New subgroup in ${group.name}`}
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
              label={`Edit group ${group.name}`}
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
                dnd={{ ...hostDrag(h), ...hostDrop(h) }}
              />
            ))}
            {empty && <p className="py-1 pl-2 text-xs text-faint italic">Empty</p>}
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
            'flex h-7 w-full items-center gap-1.5 rounded-md px-1 text-[11px] font-semibold tracking-wider text-faint uppercase hover:text-muted',
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
                label: `Hide ${title}`,
                icon: <EyeOff size={14} />,
                hint: 'Settings → Appearance',
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
              dnd={hostDrag(h)}
            />
          ))}
      </div>
    )
  }

  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    setResizing(true)
    const move = (ev: PointerEvent): void => {
      setWidth(
        Math.round(Math.min(WIDTH.max, Math.max(WIDTH.min, startWidth + ev.clientX - startX)))
      )
    }
    const up = (): void => {
      setResizing(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const selected = selectedHosts()
  const closeDialog = (): void => {
    setDialog(null)
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-line bg-surface"
      style={{ width }}
      data-testid="sidebar"
    >
      {/* Tay nắm đổi độ rộng; nhấp đúp để về mặc định. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={WIDTH.min}
        aria-valuemax={WIDTH.max}
        aria-valuenow={width}
        data-testid="sidebar-resize"
        className={cx(
          'absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize transition-colors',
          resizing ? 'bg-accent/40' : 'hover:bg-accent/25'
        )}
        onPointerDown={startResize}
        onDoubleClick={() => {
          setWidth(WIDTH.default)
        }}
      />
      <div className="flex h-11 items-center gap-2 border-b border-line px-3">
        <Logo size={24} className="shrink-0" />
        <span className="flex-1 text-sm font-semibold text-fg">Shellhouse</span>
        <IconButton
          label="New host"
          data-testid="add-host"
          onClick={() => {
            setDialog({ kind: 'host', host: null, groupId: null })
          }}
        >
          <Plus size={16} />
        </IconButton>
      </div>
      <div className="flex flex-col gap-2 p-2.5">
        <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-subtle px-2 transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20">
          <Search size={14} className="text-faint" />
          <input
            ref={searchRef}
            type="search"
            spellCheck={false}
            placeholder="Search hosts…"
            data-testid="host-search"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            onKeyDown={(e) => {
              if (!results) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(c + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (e.key === 'Enter') {
                const host = results[cursor]
                if (host) {
                  connect(host)
                  setQuery('')
                }
              } else if (e.key === 'Escape') {
                setQuery('')
              }
            }}
          />
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            data-testid="add-group"
            className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs text-muted hover:bg-hover hover:text-fg"
            onClick={() => {
              setDialog({ kind: 'group', group: null })
            }}
          >
            <FolderPlus size={13} /> New group
          </button>
          <button
            type="button"
            title="Import hosts from ~/.ssh/config or MobaXterm"
            data-testid="import-ssh-config"
            className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs text-muted hover:bg-hover hover:text-fg"
            onClick={() => {
              setDialog({ kind: 'import' })
            }}
          >
            <FileInput size={13} /> Import
          </button>
          <IconButton
            label={allCollapsed ? 'Expand all groups' : 'Collapse all groups'}
            size="sm"
            className="size-7"
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
        role="tree"
        aria-label="Hosts"
        aria-multiselectable
        className="min-h-0 flex-1 overflow-auto px-2 pb-2"
        onKeyDown={(e) => {
          if (e.target instanceof HTMLInputElement) return
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
            <p className="px-2 py-3 text-xs text-faint">No matching hosts.</p>
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
                'Favorites',
                <Star size={12} />,
                favorites,
                'favorite-row',
                favoritesDrop
              )}
            {showRecent && section(RECENT, 'Recent', <Clock size={12} />, recent, 'recent-row')}
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
                  dnd={{ ...hostDrag(h), ...hostDrop(h) }}
                />
              ))}
            </div>
            {hosts.length === 0 && groups.length === 0 && (
              <div
                className="mx-1 mt-1 rounded-lg border border-line bg-subtle/50 p-3"
                data-testid="sidebar-get-started"
              >
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                  <Server size={14} className="text-accent" /> Add your servers
                </p>
                <p className="mt-1 text-xs text-muted">
                  Save a host once, then connect with a double-click.
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
                    Add host
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
                    Import
                  </Button>
                </div>
              </div>
            )}
            <S3Section />
          </>
        )}
      </div>

      {selected.length > 1 && (
        <div
          className="animate-fade-in flex items-center gap-0.5 border-t border-line bg-subtle/60 px-2 py-1.5"
          data-testid="selection-bar"
        >
          <span className="mr-auto pl-1 text-xs font-medium text-fg">
            {selected.length} selected
          </span>
          <IconButton
            label={`Open ${selected.length} in tabs`}
            size="sm"
            className="size-7"
            onClick={() => {
              requestOpen(selected, 'tabs')
            }}
          >
            <Play size={14} />
          </IconButton>
          <IconButton
            label="Move to…"
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
            label="Tags…"
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
            label="Delete…"
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
            label="Clear selection"
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
          title={`Open ${plural(dialog.hosts.length, 'session')}?`}
          message={`This connects to ${plural(dialog.hosts.length, 'host')} at once${dialog.layout === 'grid' ? ' in a grid' : ''}${dialog.broadcast ? ', and shows them all in MultiExec' : ''}.`}
          confirmLabel="Open all"
          onConfirm={() => {
            openMany(dialog.hosts, dialog.layout, dialog.broadcast)
          }}
          onClose={closeDialog}
        />
      )}
    </aside>
  )
})
