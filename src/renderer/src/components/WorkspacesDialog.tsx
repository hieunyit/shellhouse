import { useState } from 'react'
import { LayoutGrid, Server, SquareTerminal, Trash2 } from 'lucide-react'
import { pruneItems, type Workspace, type WorkspaceItem } from '@shared/workspaces'
import { useHosts } from '../stores/hosts'
import { useSettings } from '../stores/settings'
import { useTabs } from '../stores/tabs'
import { captureWorkspaceItems } from './Workspace'
import { Button, IconButton, Input, Modal, Notice } from './ui'

/** Mở workspace: bỏ host đã xoá, cập nhật tên host đã đổi. */
export function openWorkspace(workspace: Workspace): void {
  const hosts = useHosts.getState().tree.hosts
  const exists = (item: WorkspaceItem): boolean =>
    item.target.kind !== 'host' ||
    hosts.some((h) => h.id === (item.target as { hostId: string }).hostId)
  const items = pruneItems(workspace.items, exists).map((item) => {
    const target = item.target
    const host = target.kind === 'host' ? hosts.find((h) => h.id === target.hostId) : undefined
    return host ? { ...item, title: host.label } : item
  })
  useTabs.getState().openWorkspace(items)
}

function summary(items: readonly WorkspaceItem[]): string {
  const remote = items.filter((i) => i.target.kind !== 'local').length
  const local = items.length - remote
  return [
    remote && `${remote} SSH`,
    local && `${local} local`,
    items.some((i) => i.after !== null && i.direction !== 'within') && 'split'
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Lưu bố cục tab hiện tại thành workspace; mở / xoá workspace đã lưu. */
export function WorkspacesDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { settings, update } = useSettings()
  const workspaces = settings.workspaces
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const tabCount = useTabs((s) => s.tabs.length)

  const save = async (): Promise<void> => {
    const trimmed = name.trim()
    const items = captureWorkspaceItems()
    if (!trimmed || items.length === 0) return
    const existing = workspaces.find((w) => w.name.toLowerCase() === trimmed.toLowerCase())
    if (existing && !window.confirm(`Replace the workspace “${existing.name}”?`)) return
    const next: Workspace = { id: existing?.id ?? crypto.randomUUID(), name: trimmed, items }
    try {
      await update({
        workspaces: existing
          ? workspaces.map((w) => (w.id === existing.id ? next : w))
          : [...workspaces, next]
      })
      setName('')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal
      title="Workspaces"
      description="A workspace reopens a set of tabs and splits in one step. Only connection targets are saved — no passwords."
      onClose={onClose}
      width="max-w-lg"
      testId="workspaces-dialog"
    >
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Input
          autoFocus
          className="min-w-0 flex-1"
          placeholder="Name for the current layout, e.g. Prod web + DB"
          data-testid="workspace-name"
          value={name}
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value)
          }}
        />
        <Button
          type="submit"
          variant="primary"
          data-testid="workspace-save"
          disabled={!name.trim() || tabCount === 0}
          title={tabCount === 0 ? 'Open some tabs first' : undefined}
        >
          Save current
        </Button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {workspaces.length === 0 ? (
        <p className="py-6 text-center text-xs text-faint">
          No workspaces yet. Arrange your tabs and splits, then save them here.
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {workspaces.map((w) => (
            <li
              key={w.id}
              className="flex items-center gap-3 px-3 py-2"
              data-testid="workspace-row"
              data-name={w.name}
            >
              <LayoutGrid size={15} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-fg">{w.name}</p>
                <p className="flex items-center gap-1 text-[11px] text-faint">
                  {w.items.some((i) => i.target.kind !== 'local') ? (
                    <Server size={11} />
                  ) : (
                    <SquareTerminal size={11} />
                  )}
                  {summary(w.items)}
                </p>
              </div>
              <Button
                size="sm"
                data-testid="workspace-open"
                onClick={() => {
                  onClose()
                  openWorkspace(w)
                }}
              >
                Open
              </Button>
              <IconButton
                label={`Delete ${w.name}`}
                size="sm"
                data-testid="workspace-delete"
                onClick={() => {
                  if (window.confirm(`Delete the workspace “${w.name}”?`))
                    void update({ workspaces: workspaces.filter((x) => x.id !== w.id) })
                }}
              >
                <Trash2 size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
