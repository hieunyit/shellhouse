import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { buildGroupTree, countHostsRecursive } from '@shared/group-tree'
import { MAX_JUMPS, type GroupDefaults, type GroupSummary, type HostColor } from '@shared/hosts'
import { inheritedDefaults, type Inherited } from '@shared/inherit'
import { t, tn } from '@shared/i18n'
import { useHosts } from '../stores/hosts'
import { ColorPicker, colorName } from './ColorPicker'
import { GroupSelect } from './GroupSelect'
import { Button, Field, IconButton, Input, Modal, Notice, Select } from './ui'

/** Giá trị kế thừa kèm nguồn: "deploy (from Production)". */
const withSource = (value: string, i: Inherited<unknown> | undefined): string =>
  i ? t('{value} (from {group})', { value, group: i.groupName }) : value

/** Cổng trống (= kế thừa) hoặc số nguyên 1–65535. */
const portProblem = (port: string): string | null => {
  const v = port.trim()
  if (!v) return null
  const n = Number(v)
  return /^\d+$/.test(v) && n >= 1 && n <= 65535
    ? null
    : t('Port must be a whole number from 1 to 65535.')
}

/** Phần sau "Nothing inside is lost:" trong hộp xác nhận xoá nhóm. */
function whatMoves(hosts: number, subgroups: number, place: string): string {
  if (hosts + subgroups === 0) return t('the group is empty.')
  if (subgroups === 0)
    return tn(hosts, '{n} host moves to {place}.', '{n} hosts move to {place}.', { place })
  if (hosts === 0)
    return tn(subgroups, '{n} subgroup moves to {place}.', '{n} subgroups move to {place}.', {
      place
    })
  return t('{hosts} and {subgroups} move to {place}.', {
    hosts: tn(hosts, '{n} host', '{n} hosts'),
    subgroups: tn(subgroups, '{n} subgroup', '{n} subgroups'),
    place
  })
}

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
      id === null ? t('the top level') : `“${tree.path(id).join(' / ')}”`
    return {
      parentPath,
      // Nhóm này sẽ kế thừa gì từ nhóm cha (theo nhóm cha đang chọn trong form).
      inherited: inheritedDefaults(tree, parentId),
      hostCount: group ? (countHostsRecursive(tree, hosts).get(group.id) ?? 0) : 0,
      subgroupCount: group ? tree.descendants(group.id).size : 0
    }
  }, [groups, hosts, group, parentId])
  const inh = info.inherited
  const hostLabel = (id: string): string => hosts.find((h) => h.id === id)?.label ?? t('(deleted)')

  const nameMissing = !name.trim()
  const portError = portProblem(port)

  const save = (): void => {
    if (nameMissing || portError) return
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
      title={group ? t('Edit group') : parentId ? t('New subgroup') : t('New group')}
      {...(!group && parentId
        ? { description: t('Inside {path}', { path: info.parentPath(parentId) }) }
        : {})}
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
              {t('Keep group')}
            </Button>
            <Button
              variant="danger"
              data-testid="group-delete-confirm"
              onClick={() => void window.shellhouse.deleteGroup(group.id).then(onClose)}
            >
              {t('Delete group')}
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
                {t('Delete group')}
              </Button>
            )}
            <Button onClick={onClose}>{t('Cancel')}</Button>
            <Button
              variant="primary"
              disabled={nameMissing || portError !== null}
              data-testid="group-save"
              onClick={save}
            >
              {t('Save')}
            </Button>
          </>
        )
      }
    >
      {confirmDelete && group ? (
        <Notice tone="warning" testId="group-delete-notice">
          {t('Delete “{name}”? Nothing inside is lost:', { name: group.name })}{' '}
          {whatMoves(info.hostCount, info.subgroupCount, info.parentPath(group.parentId))}
        </Notice>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Name')}>
              <Input
                autoFocus
                placeholder={t('e.g. Production')}
                data-testid="group-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setError(null)
                }}
              />
            </Field>
            <Field label={t('Inside')}>
              <GroupSelect
                testId="group-parent"
                value={parentId}
                onChange={(id) => {
                  setParentId(id)
                  setError(null)
                }}
                noneLabel={t('(top level)')}
                movingGroupId={group?.id ?? null}
              />
            </Field>
          </div>
          {group && info.subgroupCount > 0 && (
            <p className="-mt-2 text-xs text-faint">
              {tn(
                info.subgroupCount,
                'Moving it also moves its {n} subgroup.',
                'Moving it also moves its {n} subgroups.'
              )}
            </p>
          )}

          <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-3">
            <legend className="px-1 text-xs font-medium text-muted">
              {t('Defaults for hosts inside')}
            </legend>
            <p className="-mt-1 text-xs text-faint">
              {t(
                'Hosts in this group and its subgroups use these unless they set their own. Leave a field empty to keep the value from the parent group.'
              )}
            </p>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <Field label={t('Username')}>
                <Input
                  mono
                  spellCheck={false}
                  data-testid="group-default-username"
                  placeholder={
                    inh.username ? withSource(inh.username.value, inh.username) : t('Not set')
                  }
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value)
                  }}
                />
              </Field>
              <Field label={t('Port')}>
                <Input
                  mono
                  inputMode="numeric"
                  data-testid="group-default-port"
                  placeholder={inh.port ? String(inh.port.value) : '22'}
                  aria-invalid={portError !== null}
                  title={inh.port ? t('From {group}', { group: inh.port.groupName }) : undefined}
                  value={port}
                  onChange={(e) => {
                    setPort(e.target.value)
                  }}
                />
              </Field>
            </div>
            {portError && (
              <p className="-mt-1 text-xs text-danger" role="alert" data-testid="group-port-error">
                {portError}
              </p>
            )}
            <Field
              label={t('SSH key')}
              hint={t('Tried automatically by hosts that use Automatic authentication.')}
            >
              <Select
                data-testid="group-default-key"
                value={keyId}
                onChange={(e) => {
                  setKeyId(e.target.value)
                }}
              >
                <option value="">
                  {inheritedKey ? withSource(inheritedKey, inh.keyId) : t('Not set')}
                </option>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} ({k.type})
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">{t('Jump hosts')}</span>
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
                        label={t('Remove {name}', { name: hostLabel(id) })}
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
                    ? withSource(
                        t('Through {hosts}', {
                          hosts: inh.jumpHostIds.value.map(hostLabel).join(' → ')
                        }),
                        inh.jumpHostIds
                      )
                    : t('Direct connection.')}
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
                  <option value="">{t('Add a jump host…')}</option>
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
              <span className="text-xs font-medium text-muted">{t('Environment color')}</span>
              <ColorPicker
                value={color}
                onChange={setColor}
                noneLabel={
                  inh.color
                    ? t('Use the parent color ({color})', { color: colorName(inh.color.value) })
                    : t('No color')
                }
                testIdPrefix="group-color"
              />
              {!color && inh.color && (
                <p className="text-xs text-muted" data-testid="group-color-inherited">
                  {t('Using {color} from {group}.', {
                    color: colorName(inh.color.value),
                    group: inh.color.groupName
                  })}
                </p>
              )}
              <p className="text-xs text-faint">
                {t(
                  'Tabs and terminals of hosts inside get this color — e.g. red for production, so it is obvious where you are typing.'
                )}
              </p>
            </div>
          </fieldset>
          {error && <Notice tone="danger">{error}</Notice>}
        </form>
      )}
    </Modal>
  )
}
