import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { buildGroupTree, countHostsRecursive } from '@shared/group-tree'
import { MAX_JUMPS, type GroupDefaults, type GroupSummary, type HostColor } from '@shared/hosts'
import { inheritedDefaults, type Inherited } from '@shared/inherit'
import { useHosts } from '../stores/hosts'
import { ColorPicker } from './ColorPicker'
import { GroupSelect } from './GroupSelect'
import { Button, Field, IconButton, Input, Modal, Notice, Select } from './ui'

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const from = (i: Inherited<unknown> | undefined): string => (i ? ` (from ${i.groupName})` : '')

export function GroupForm({
  group,
  defaultParentId = null,
  startWithDelete = false,
  onClose
}: {
  group: GroupSummary | null
  /** Nhóm cha mặc định khi tạo nhóm con từ một nhóm có sẵn. */
  defaultParentId?: string | null
  /** Mở thẳng bước xác nhận xoá (menu chuột phải → Delete group…). */
  startWithDelete?: boolean
  onClose: () => void
}): React.JSX.Element {
  const { groups, hosts, keys } = useHosts((s) => s.tree)
  const [name, setName] = useState(group?.name ?? '')
  const [parentId, setParentId] = useState<string | null>(group?.parentId ?? defaultParentId)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(startWithDelete && group !== null)

  // Giá trị mặc định cho host bên trong ('' / null = không đặt → kế thừa tiếp từ nhóm cha).
  const d = group?.defaults ?? {}
  const [username, setUsername] = useState(d.username ?? '')
  const [port, setPort] = useState(d.port === undefined ? '' : String(d.port))
  const [keyId, setKeyId] = useState<string>(d.keyId ?? '')
  const [jumps, setJumps] = useState<string[]>(d.jumpHostIds ?? [])
  const [color, setColor] = useState<HostColor | null>(d.color ?? null)

  const info = useMemo(() => {
    const tree = buildGroupTree(groups)
    const parentPath = (id: string | null): string =>
      id === null ? 'the top level' : `"${tree.path(id).join(' / ')}"`
    return {
      parentPath,
      // Nhóm này sẽ kế thừa gì từ nhóm cha (theo nhóm cha đang chọn trong form).
      inherited: inheritedDefaults(tree, parentId),
      hostCount: group ? (countHostsRecursive(tree, hosts).get(group.id) ?? 0) : 0,
      subgroupCount: group ? tree.descendants(group.id).size : 0
    }
  }, [groups, hosts, group, parentId])
  const inh = info.inherited
  const hostLabel = (id: string): string => hosts.find((h) => h.id === id)?.label ?? '(deleted)'

  const save = (): void => {
    const defaults: GroupDefaults = {}
    if (username.trim()) defaults.username = username.trim()
    if (port.trim()) defaults.port = Number(port)
    if (keyId) defaults.keyId = keyId
    if (jumps.length > 0) defaults.jumpHostIds = jumps
    if (color) defaults.color = color
    void window.shellhouse
      .saveGroup({ ...(group ? { id: group.id } : {}), name, parentId, defaults })
      .then((result) => {
        if (result.ok) onClose()
        else setError(result.message)
      })
  }

  const inheritedKey = inh.keyId ? keys.find((k) => k.id === inh.keyId?.value)?.name : undefined

  return (
    <Modal
      title={group ? 'Edit group' : parentId ? 'New subgroup' : 'New group'}
      {...(!group && parentId ? { description: `Inside ${info.parentPath(parentId)}` } : {})}
      onClose={onClose}
      width="max-w-lg"
      testId="group-form"
      footer={
        confirmDelete && group ? (
          <>
            <Button
              className="mr-auto"
              onClick={() => {
                if (startWithDelete) onClose()
                else setConfirmDelete(false)
              }}
            >
              Keep group
            </Button>
            <Button
              variant="danger"
              data-testid="group-delete-confirm"
              onClick={() => void window.shellhouse.deleteGroup(group.id).then(onClose)}
            >
              Delete group
            </Button>
          </>
        ) : (
          <>
            {group && (
              <Button
                variant="danger-ghost"
                className="mr-auto"
                data-testid="group-delete"
                onClick={() => {
                  setConfirmDelete(true)
                }}
              >
                Delete group
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              data-testid="group-save"
              onClick={save}
            >
              Save
            </Button>
          </>
        )
      }
    >
      {confirmDelete && group ? (
        <Notice tone="warning" testId="group-delete-notice">
          Delete “{group.name}”? Nothing inside is lost:{' '}
          {info.hostCount + info.subgroupCount === 0
            ? 'the group is empty.'
            : `${[
                info.hostCount > 0 && plural(info.hostCount, 'host'),
                info.subgroupCount > 0 && plural(info.subgroupCount, 'subgroup')
              ]
                .filter(Boolean)
                .join(' and ')} move to ${info.parentPath(group.parentId)}.`}
        </Notice>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) save()
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                autoFocus
                placeholder="e.g. Production"
                data-testid="group-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setError(null)
                }}
              />
            </Field>
            <Field label="Inside">
              <GroupSelect
                testId="group-parent"
                value={parentId}
                onChange={(id) => {
                  setParentId(id)
                  setError(null)
                }}
                noneLabel="(top level)"
                movingGroupId={group?.id ?? null}
              />
            </Field>
          </div>
          {group && info.subgroupCount > 0 && (
            <p className="-mt-2 text-xs text-faint">
              Moving it also moves its {plural(info.subgroupCount, 'subgroup')}.
            </p>
          )}

          <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-3">
            <legend className="px-1 text-xs font-medium text-muted">
              Defaults for hosts inside
            </legend>
            <p className="-mt-1 text-xs text-faint">
              Hosts in this group and its subgroups use these unless they set their own. Leave a
              field empty to keep the value from the parent group.
            </p>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <Field label="Username">
                <Input
                  mono
                  spellCheck={false}
                  data-testid="group-default-username"
                  placeholder={
                    inh.username ? `${inh.username.value}${from(inh.username)}` : 'Not set'
                  }
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value)
                  }}
                />
              </Field>
              <Field label="Port">
                <Input
                  mono
                  inputMode="numeric"
                  data-testid="group-default-port"
                  placeholder={inh.port ? String(inh.port.value) : '22'}
                  title={inh.port ? `From ${inh.port.groupName}` : undefined}
                  value={port}
                  onChange={(e) => {
                    setPort(e.target.value)
                  }}
                />
              </Field>
            </div>
            <Field
              label="SSH key"
              hint="Tried automatically by hosts that use Automatic authentication."
            >
              <Select
                data-testid="group-default-key"
                value={keyId}
                onChange={(e) => {
                  setKeyId(e.target.value)
                }}
              >
                <option value="">
                  {inheritedKey ? `${inheritedKey}${from(inh.keyId)}` : 'Not set'}
                </option>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} ({k.type})
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Jump hosts</span>
              {jumps.length > 0 ? (
                <ol className="flex flex-col gap-1" data-testid="group-jump-list">
                  {jumps.map((id, i) => (
                    <li
                      key={id}
                      className="flex items-center gap-2 rounded-md bg-subtle px-2 py-1 text-[13px]"
                    >
                      <span className="text-xs text-faint">{i + 1}</span>
                      <span className="flex-1">{hostLabel(id)}</span>
                      <IconButton
                        label={`Remove ${hostLabel(id)}`}
                        size="sm"
                        onClick={() => {
                          setJumps(jumps.filter((j) => j !== id))
                        }}
                      >
                        <X size={13} />
                      </IconButton>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-faint">
                  {inh.jumpHostIds
                    ? `Through ${inh.jumpHostIds.value.map(hostLabel).join(' → ')}${from(inh.jumpHostIds)}`
                    : 'Direct connection.'}
                </p>
              )}
              {jumps.length < MAX_JUMPS && (
                <Select
                  value=""
                  data-testid="group-jump-add"
                  onChange={(e) => {
                    if (e.target.value) setJumps([...jumps, e.target.value])
                  }}
                >
                  <option value="">Add a jump host…</option>
                  {hosts
                    .filter((h) => !jumps.includes(h.id))
                    .map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.label} ({h.hostname})
                      </option>
                    ))}
                </Select>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Environment color</span>
              <ColorPicker
                value={color}
                onChange={setColor}
                noneLabel={inh.color ? `Use the parent color (${inh.color.value})` : 'No color'}
                testIdPrefix="group-color"
              />
              {!color && inh.color && (
                <p className="text-xs text-muted" data-testid="group-color-inherited">
                  Using {inh.color.value} from {inh.color.groupName}.
                </p>
              )}
              <p className="text-xs text-faint">
                Tabs and terminals of hosts inside get this color — e.g. red for production, so it
                is obvious where you are typing.
              </p>
            </div>
          </fieldset>
          {error && <Notice tone="danger">{error}</Notice>}
        </form>
      )}
    </Modal>
  )
}
