import { useState } from 'react'
import type { GroupSummary } from '@shared/hosts'
import { useHosts } from '../stores/hosts'
import { Button, Field, Input, Modal, Notice, Select } from './ui'

export function GroupForm({
  group,
  onClose
}: {
  group: GroupSummary | null
  onClose: () => void
}): React.JSX.Element {
  const groups = useHosts((s) => s.tree.groups)
  const [name, setName] = useState(group?.name ?? '')
  const [parentId, setParentId] = useState<string | null>(group?.parentId ?? null)
  const [error, setError] = useState<string | null>(null)

  const save = (): void => {
    void window.shellhouse
      .saveGroup({ ...(group ? { id: group.id } : {}), name, parentId })
      .then((result) => {
        if (result.ok) onClose()
        else setError(result.message)
      })
  }

  return (
    <Modal
      title={group ? 'Edit group' : 'New group'}
      onClose={onClose}
      width="max-w-sm"
      testId="group-form"
      footer={
        <>
          {group && (
            <Button
              variant="danger-ghost"
              className="mr-auto"
              onClick={() => void window.shellhouse.deleteGroup(group.id).then(onClose)}
            >
              Delete group
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} data-testid="group-save" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) save()
        }}
      >
        <Field label="Name">
          <Input
            autoFocus
            placeholder="e.g. Production"
            data-testid="group-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
        </Field>
        <Field label="Parent">
          <Select
            value={parentId ?? ''}
            onChange={(e) => {
              setParentId(e.target.value || null)
            }}
          >
            <option value="">(top level)</option>
            {groups
              .filter((g) => g.id !== group?.id)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  Inside {g.name}
                </option>
              ))}
          </Select>
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Modal>
  )
}
