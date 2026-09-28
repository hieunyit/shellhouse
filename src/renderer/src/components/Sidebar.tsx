import { forwardRef, useMemo, useState, type DragEvent } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileInput,
  FolderPlus,
  Pencil,
  Plus,
  Search,
  Server
} from 'lucide-react'
import { bestScore } from '@shared/fuzzy'
import type { GroupSummary, HostSummary } from '@shared/hosts'
import { useHosts } from '../stores/hosts'
import { useTabs } from '../stores/tabs'
import { GroupForm } from './GroupForm'
import { HostForm } from './HostForm'
import { hostColorClass } from './hostColors'
import { ImportDialog } from './ImportDialog'
import { cx, IconButton } from './ui'

const DRAG_TYPE = 'application/x-shellhouse-host'

function connect(host: HostSummary): void {
  useTabs.getState().addHost({ id: host.id, label: host.label })
}

function HostRow({
  host,
  depth,
  selected,
  onEdit
}: {
  host: HostSummary
  depth: number
  selected?: boolean
  onEdit: (host: HostSummary) => void
}): React.JSX.Element {
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      draggable
      data-testid="host-row"
      data-host-label={host.label}
      title={`${host.username}@${host.hostname}:${host.port}${host.lastUsedAt ? `\nLast used: ${new Date(host.lastUsedAt).toLocaleString()}` : ''}`}
      className={cx(
        'group flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 outline-none hover:bg-hover focus-visible:bg-hover',
        selected && 'bg-accent-soft'
      )}
      style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}
      onDoubleClick={() => {
        connect(host)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') connect(host)
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, host.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md bg-subtle text-muted">
        <Server size={14} />
        {host.color && (
          <span
            className={cx(
              'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface',
              hostColorClass[host.color]
            )}
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-fg">{host.label}</span>
        <span className="block truncate font-mono text-[11px] text-faint">
          {host.username}@{host.hostname}
          {host.port === 22 ? '' : `:${host.port}`}
        </span>
      </span>
      <IconButton
        label={`Edit ${host.label}`}
        size="sm"
        data-testid="host-edit"
        className="opacity-0 group-hover:opacity-100 focus:opacity-100"
        onClick={() => {
          onEdit(host)
        }}
      >
        <Pencil size={13} />
      </IconButton>
    </div>
  )
}

function dropHandlers(groupId: string | null, setOver: (id: string | null) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      setOver(groupId ?? 'root')
    },
    onDragLeave: () => {
      setOver(null)
    },
    onDrop: (e: DragEvent) => {
      const hostId = e.dataTransfer.getData(DRAG_TYPE)
      setOver(null)
      if (hostId) void window.shellhouse.moveHost(hostId, groupId)
    }
  }
}

export const Sidebar = forwardRef<HTMLInputElement>(function Sidebar(_props, searchRef) {
  const { groups, hosts } = useHosts((s) => s.tree)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [editing, setEditing] = useState<{
    host: HostSummary | null
    groupId: string | null
  } | null>(null)
  const [editingGroup, setEditingGroup] = useState<{ group: GroupSummary | null } | null>(null)
  const [importing, setImporting] = useState(false)

  const results = useMemo(() => {
    if (!query.trim()) return null
    return hosts
      .map((h) => ({
        h,
        s: bestScore(query, [h.label, h.hostname, `${h.username}@${h.hostname}`, ...h.tags])
      }))
      .filter((r): r is { h: HostSummary; s: number } => r.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.h)
  }, [hosts, query])

  const childGroups = (parentId: string | null): GroupSummary[] =>
    groups.filter((g) => g.parentId === parentId)
  const hostsIn = (groupId: string | null): HostSummary[] =>
    hosts.filter((h) => h.groupId === groupId)
  const onEdit = (host: HostSummary): void => {
    setEditing({ host, groupId: host.groupId })
  }

  const renderGroup = (group: GroupSummary, depth: number): React.JSX.Element => {
    const open = !collapsed.has(group.id)
    const count = hosts.filter((h) => h.groupId === group.id).length
    return (
      <div key={group.id} role="group">
        <div
          className={cx(
            'group flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted hover:bg-hover',
            dragOver === group.id && 'bg-accent-soft ring-1 ring-accent'
          )}
          style={{ paddingLeft: `${0.25 + depth * 0.85}rem` }}
          data-testid="group-row"
          data-group-name={group.name}
          {...dropHandlers(group.id, setDragOver)}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="flex size-5 items-center justify-center rounded text-faint hover:text-fg"
            onClick={() => {
              const next = new Set(collapsed)
              if (open) next.add(group.id)
              else next.delete(group.id)
              setCollapsed(next)
            }}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <span className="flex-1 truncate tracking-wide uppercase">{group.name}</span>
          <span className="text-[11px] text-faint">{count}</span>
          <IconButton
            label={`Add host to ${group.name}`}
            size="sm"
            className="opacity-0 group-hover:opacity-100"
            onClick={() => {
              setEditing({ host: null, groupId: group.id })
            }}
          >
            <Plus size={13} />
          </IconButton>
          <IconButton
            label={`Edit group ${group.name}`}
            size="sm"
            className="opacity-0 group-hover:opacity-100"
            onClick={() => {
              setEditingGroup({ group })
            }}
          >
            <Pencil size={12} />
          </IconButton>
        </div>
        {open && (
          <div>
            {childGroups(group.id).map((g) => renderGroup(g, depth + 1))}
            {hostsIn(group.id).map((h) => (
              <HostRow key={h.id} host={h} depth={depth + 1} onEdit={onEdit} />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <aside
      className="flex w-64 shrink-0 flex-col border-r border-line bg-surface"
      data-testid="sidebar"
    >
      <div className="flex h-11 items-center gap-2 border-b border-line px-3">
        <div className="flex size-6 items-center justify-center rounded-md bg-accent text-accent-fg">
          <span className="font-mono text-[11px] font-bold">&gt;_</span>
        </div>
        <span className="flex-1 text-sm font-semibold text-fg">Shellhouse</span>
        <IconButton
          label="New host"
          data-testid="add-host"
          onClick={() => {
            setEditing({ host: null, groupId: null })
          }}
        >
          <Plus size={16} />
        </IconButton>
      </div>
      <div className="flex flex-col gap-2 p-2.5">
        <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-subtle px-2 focus-within:border-accent">
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
              setEditingGroup({ group: null })
            }}
          >
            <FolderPlus size={13} /> New group
          </button>
          <button
            type="button"
            title="Import from ~/.ssh/config"
            data-testid="import-ssh-config"
            className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs text-muted hover:bg-hover hover:text-fg"
            onClick={() => {
              setImporting(true)
            }}
          >
            <FileInput size={13} /> Import
          </button>
        </div>
      </div>

      <div role="tree" className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {results ? (
          results.length === 0 ? (
            <p className="px-2 py-3 text-xs text-faint">No matching hosts.</p>
          ) : (
            results.map((h, i) => (
              <HostRow key={h.id} host={h} depth={0} selected={i === cursor} onEdit={onEdit} />
            ))
          )
        ) : (
          <>
            {childGroups(null).map((g) => renderGroup(g, 0))}
            <div
              className={cx(
                'min-h-8 rounded-md',
                dragOver === 'root' && 'bg-accent-soft ring-1 ring-accent'
              )}
              data-testid="ungrouped"
              {...dropHandlers(null, setDragOver)}
            >
              {hostsIn(null).map((h) => (
                <HostRow key={h.id} host={h} depth={0} onEdit={onEdit} />
              ))}
            </div>
            {hosts.length === 0 && groups.length === 0 && (
              <div className="mx-1 mt-2 rounded-lg border border-dashed border-line p-4 text-center">
                <Server size={20} className="mx-auto mb-2 text-faint" />
                <p className="text-xs text-muted">No hosts yet.</p>
                <p className="mt-1 text-xs text-faint">Add one, or import from ~/.ssh/config.</p>
              </div>
            )}
          </>
        )}
      </div>

      {editing && (
        <HostForm
          host={editing.host}
          defaultGroupId={editing.groupId}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}
      {editingGroup && (
        <GroupForm
          group={editingGroup.group}
          onClose={() => {
            setEditingGroup(null)
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => {
            setImporting(false)
          }}
        />
      )}
    </aside>
  )
})
