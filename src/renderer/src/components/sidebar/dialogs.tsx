import { toast } from '../../stores/toasts'
import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { HostSummary } from '@shared/hosts'
import { useHosts } from '../../stores/hosts'
import { GroupSelect } from '../GroupSelect'
import { Button, Field, Input, Modal, Notice } from '../ui'

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose
}: {
  title: string
  message: React.ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width="max-w-sm"
      testId="confirm-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            autoFocus
            variant={danger ? 'danger' : 'primary'}
            data-testid="confirm-ok"
            onClick={() => {
              void Promise.resolve(onConfirm()).then(onClose)
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-muted">{message}</p>
    </Modal>
  )
}

export function DeleteHostsDialog({
  hosts,
  onDone,
  onClose
}: {
  hosts: readonly HostSummary[]
  onDone: () => void
  onClose: () => void
}): React.JSX.Element {
  const single = hosts.length === 1 ? hosts[0] : undefined
  return (
    <ConfirmDialog
      title={single ? `Delete “${single.label}”?` : `Delete ${plural(hosts.length, 'host')}?`}
      message="Saved passwords and port forwards of these hosts are deleted too. Open sessions keep running."
      confirmLabel="Delete"
      danger
      onConfirm={async () => {
        await window.shellhouse.deleteHosts(hosts.map((h) => h.id))
        toast.success(
          single ? `Deleted ${single.label}` : `Deleted ${plural(hosts.length, 'host')}`
        )
        onDone()
      }}
      onClose={onClose}
    />
  )
}

export function MoveHostsDialog({
  hosts,
  onClose
}: {
  hosts: readonly HostSummary[]
  onClose: () => void
}): React.JSX.Element {
  const [groupId, setGroupId] = useState<string | null>(
    hosts.every((h) => h.groupId === hosts[0]?.groupId) ? (hosts[0]?.groupId ?? null) : null
  )
  const [error, setError] = useState<string | null>(null)
  const move = async (): Promise<void> => {
    const result = await window.shellhouse.moveHosts(
      hosts.map((h) => h.id),
      groupId
    )
    if (result.ok) onClose()
    else setError(result.message)
  }
  return (
    <Modal
      title={
        hosts.length === 1
          ? `Move “${hosts[0]?.label ?? ''}”`
          : `Move ${plural(hosts.length, 'host')}`
      }
      onClose={onClose}
      width="max-w-sm"
      testId="move-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="move-ok" onClick={() => void move()}>
            Move
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="To group">
          <GroupSelect
            testId="move-target"
            value={groupId}
            onChange={setGroupId}
            noneLabel="No group"
          />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  )
}

export function TagHostsDialog({
  hosts,
  onClose
}: {
  hosts: readonly HostSummary[]
  onClose: () => void
}): React.JSX.Element {
  // Chọn mảng gốc (tham chiếu ổn định) rồi mới tính — selector trả mảng mới mỗi lần sẽ làm
  // zustand render lại vô hạn.
  const allHosts = useHosts((s) => s.tree.hosts)
  const allTags = useMemo(() => allHosts.flatMap((h) => h.tags), [allHosts])
  const current = useMemo(() => {
    const counts = new Map<string, number>()
    for (const h of hosts) for (const t of h.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [hosts])
  const [text, setText] = useState('')
  const [remove, setRemove] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const add = text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const suggestions = [...new Set(allTags)]
    .filter((t) => !current.some(([c]) => c === t))
    .slice(0, 8)

  const save = async (): Promise<void> => {
    const result = await window.shellhouse.tagHosts(
      hosts.map((h) => h.id),
      add,
      remove
    )
    if (result.ok) onClose()
    else setError(result.message)
  }

  return (
    <Modal
      title={
        hosts.length === 1
          ? `Tags of “${hosts[0]?.label ?? ''}”`
          : `Tags of ${plural(hosts.length, 'host')}`
      }
      onClose={onClose}
      width="max-w-md"
      testId="tags-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="tags-ok"
            disabled={add.length === 0 && remove.length === 0}
            onClick={() => void save()}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {current.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Current tags — click to remove</p>
            <div className="flex flex-wrap gap-1.5">
              {current.map(([tag, n]) => {
                const removing = remove.includes(tag)
                return (
                  <button
                    key={tag}
                    type="button"
                    data-testid="tag-chip"
                    className={
                      removing
                        ? 'inline-flex items-center gap-1 rounded-full border border-danger/40 bg-danger-soft px-2 py-0.5 text-xs text-danger line-through'
                        : 'inline-flex items-center gap-1 rounded-full border border-line bg-subtle px-2 py-0.5 text-xs text-fg hover:border-line-strong'
                    }
                    onClick={() => {
                      setRemove(removing ? remove.filter((t) => t !== tag) : [...remove, tag])
                    }}
                  >
                    {tag}
                    {hosts.length > 1 && <span className="text-faint">{n}</span>}
                    <X size={11} />
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <Field label="Add tags" hint="Comma separated">
          <Input
            autoFocus
            data-testid="tags-add"
            placeholder="e.g. prod, web"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
          />
        </Field>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-faint">
            Used elsewhere:
            {suggestions.map((t) => (
              <button
                key={t}
                type="button"
                className="rounded-full border border-dashed border-line px-2 py-0.5 text-muted hover:border-line-strong hover:text-fg"
                onClick={() => {
                  setText(add.includes(t) ? text : [...add, t].join(', '))
                }}
              >
                + {t}
              </button>
            ))}
          </div>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  )
}
