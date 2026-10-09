import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  Button,
  Checkbox,
  cx,
  Field,
  IconButton,
  Input,
  Modal,
  Notice,
  Select,
  TextArea
} from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { confirmAction, t, toast } from '../../registry/renderer-kit'
import { normalizeRegistry, registryFor, type DockerRegistry } from '../shared/ipc'
import {
  BuildSpec,
  NetworkSpec,
  VolumeSpec,
  type BuildInfo,
  type ContainerRow,
  type NetworkRow
} from '../shared/ops'
import { dockerApi } from './api'

/** "a=b" mỗi dòng → object; dòng sai → lỗi (hiện dưới ô). */
export function parseKeyValues(text: string): { values: Record<string, string>; error: boolean } {
  const values: Record<string, string> = {}
  let error = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const eq = line.indexOf('=')
    const key = eq > 0 ? line.slice(0, eq).trim() : ''
    if (!key || /\s/.test(key)) error = true
    else values[key] = line.slice(eq + 1).trim()
  }
  return { values, error }
}

function KeyValueField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  testId
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  testId: string
}): React.JSX.Element {
  const bad = parseKeyValues(value).error
  return (
    <Field label={label} hint={bad ? undefined : (hint ?? t('One key=value per line'))}>
      <TextArea
        rows={2}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder={placeholder}
        data-testid={testId}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
      {bad && <span className="text-xs text-warning">{t('Use one key=value per line')}</span>}
    </Field>
  )
}

/** Nút gửi của hộp thoại tạo: bận → chữ "…", lỗi hiện trong hộp. */
function useSubmit(): {
  busy: boolean
  error: string | null
  submit: (fn: () => Promise<void>) => void
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return {
    busy,
    error,
    submit: (fn) => {
      setBusy(true)
      setError(null)
      fn().catch((e: unknown) => {
        setError(cleanError(e))
        setBusy(false)
      })
    }
  }
}

export function CreateVolumeDialog({
  onClose,
  onCreate
}: {
  onClose: () => void
  onCreate: (spec: VolumeSpec) => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [driver, setDriver] = useState('local')
  const [opts, setOpts] = useState('')
  const [labels, setLabels] = useState('')
  const { busy, error, submit } = useSubmit()
  const spec = VolumeSpec.safeParse({
    ...(name.trim() ? { name: name.trim() } : {}),
    driver: driver.trim(),
    driverOpts: parseKeyValues(opts).values,
    labels: parseKeyValues(labels).values
  })
  const valid = spec.success && !parseKeyValues(opts).error && !parseKeyValues(labels).error
  const go = (): void => {
    if (valid && !busy) submit(() => onCreate(spec.data))
  }
  return (
    <Modal
      title={t('New volume')}
      description={t('Named volumes keep data when containers are removed.')}
      onClose={onClose}
      testId="docker-volume-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid || busy}
            data-testid="docker-volume-create"
            onClick={go}
          >
            {busy ? t('Creating…') : t('Create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Name')} hint={t('Empty = Docker picks a random name')}>
            <Input
              autoFocus
              mono
              placeholder="pgdata"
              data-testid="docker-volume-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go()
              }}
            />
          </Field>
          <Field label={t('Driver')}>
            <Input
              mono
              value={driver}
              onChange={(e) => {
                setDriver(e.target.value)
              }}
            />
          </Field>
        </div>
        <KeyValueField
          label={t('Driver options')}
          hint={t('NFS: type=nfs, o=addr=10.0.0.5,rw, device=:/exports/data')}
          placeholder="type=tmpfs"
          value={opts}
          onChange={setOpts}
          testId="docker-volume-opts"
        />
        <KeyValueField
          label={t('Labels')}
          placeholder="app=shop"
          value={labels}
          onChange={setLabels}
          testId="docker-volume-labels"
        />
        {name.trim() !== '' && !spec.success && (
          <p className="text-xs text-warning">{t('Names use letters, digits, "_", "." and "-"')}</p>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  )
}

const NETWORK_DRIVERS = ['bridge', 'overlay', 'macvlan', 'ipvlan'] as const

export function CreateNetworkDialog({
  onClose,
  onCreate
}: {
  onClose: () => void
  onCreate: (spec: NetworkSpec) => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [driver, setDriver] = useState<string>('bridge')
  const [subnet, setSubnet] = useState('')
  const [gateway, setGateway] = useState('')
  const [ipRange, setIpRange] = useState('')
  const [internal, setInternal] = useState(false)
  const [attachable, setAttachable] = useState(false)
  const [options, setOptions] = useState('')
  const [labels, setLabels] = useState('')
  const { busy, error, submit } = useSubmit()
  const spec = NetworkSpec.safeParse({
    name: name.trim(),
    driver,
    ...(subnet.trim() ? { subnet: subnet.trim() } : {}),
    ...(gateway.trim() ? { gateway: gateway.trim() } : {}),
    ...(ipRange.trim() ? { ipRange: ipRange.trim() } : {}),
    internal,
    attachable,
    labels: parseKeyValues(labels).values,
    options: parseKeyValues(options).values
  })
  const problem = !spec.success
    ? spec.error.issues[0]?.path[0] === 'name'
      ? name.trim()
        ? t('Names use letters, digits, "_", "." and "-"')
        : null
      : spec.error.issues[0]?.path[0] === 'gateway'
        ? t('Use an IP address, like 172.28.0.1')
        : t('Use CIDR notation, like 172.28.0.0/16')
    : (driver === 'macvlan' || driver === 'ipvlan') && !parseKeyValues(options).values['parent']
      ? t('{driver} needs the host interface: parent=eth0 in the options', { driver })
      : null
  const valid = spec.success && !parseKeyValues(options).error && !parseKeyValues(labels).error
  const go = (): void => {
    if (valid && !busy) submit(() => onCreate(spec.data))
  }
  return (
    <Modal
      title={t('New network')}
      description={t('Containers on the same network reach each other by name.')}
      width="max-w-xl"
      onClose={onClose}
      testId="docker-network-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid || busy}
            data-testid="docker-network-create"
            onClick={go}
          >
            {busy ? t('Creating…') : t('Create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Name')}>
            <Input
              autoFocus
              mono
              placeholder="backend"
              data-testid="docker-network-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go()
              }}
            />
          </Field>
          <Field label={t('Driver')}>
            <Select
              value={driver}
              data-testid="docker-network-driver"
              onChange={(e) => {
                setDriver(e.target.value)
                if (e.target.value === 'overlay') setAttachable(true)
              }}
            >
              {NETWORK_DRIVERS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('Subnet')} hint={t('Optional')}>
            <Input
              mono
              placeholder="172.28.0.0/16"
              data-testid="docker-network-subnet"
              value={subnet}
              onChange={(e) => {
                setSubnet(e.target.value)
              }}
            />
          </Field>
          <Field label={t('Gateway')} hint={t('Optional')}>
            <Input
              mono
              placeholder="172.28.0.1"
              value={gateway}
              onChange={(e) => {
                setGateway(e.target.value)
              }}
            />
          </Field>
          <Field label={t('IP range')} hint={t('Optional')}>
            <Input
              mono
              placeholder="172.28.5.0/24"
              value={ipRange}
              onChange={(e) => {
                setIpRange(e.target.value)
              }}
            />
          </Field>
        </div>
        <div className="flex flex-col gap-2">
          <Checkbox
            label={t('Internal')}
            description={t('No access to the outside world — containers only talk to each other.')}
            checked={internal}
            onChange={(e) => {
              setInternal(e.target.checked)
            }}
          />
          <Checkbox
            label={t('Attachable')}
            description={t(
              'Standalone containers can join this network (overlay networks in Swarm).'
            )}
            checked={attachable}
            onChange={(e) => {
              setAttachable(e.target.checked)
            }}
          />
        </div>
        <KeyValueField
          label={t('Driver options')}
          hint={t('macvlan / ipvlan: parent=eth0 (the host interface)')}
          placeholder={
            driver === 'macvlan' || driver === 'ipvlan'
              ? 'parent=eth0'
              : 'com.docker.network.bridge.name=br-backend'
          }
          value={options}
          onChange={setOptions}
          testId="docker-network-options"
        />
        <KeyValueField
          label={t('Labels')}
          placeholder="team=payments"
          value={labels}
          onChange={setLabels}
          testId="docker-network-labels"
        />
        {problem && <p className="text-xs text-warning">{problem}</p>}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  )
}

/** Nối container vào network: chọn network (từ container) hoặc container (từ network). */
export function ConnectNetworkDialog({
  container,
  network,
  containers,
  networks,
  onClose,
  onConnect
}: {
  container?: ContainerRow
  network?: NetworkRow
  containers: readonly ContainerRow[]
  networks: readonly NetworkRow[]
  onClose: () => void
  onConnect: (network: string, container: string, aliases: string[], ipv4?: string) => Promise<void>
}): React.JSX.Element {
  const choices = networks.filter((n) => n.name !== 'host' && n.name !== 'none')
  const [net, setNet] = useState(network?.id ?? choices[0]?.id ?? '')
  const [ctr, setCtr] = useState(container?.id ?? containers[0]?.id ?? '')
  const [aliases, setAliases] = useState('')
  const [ip, setIp] = useState('')
  const { busy, error, submit } = useSubmit()
  const aliasList = aliases.split(/[\s,]+/).filter(Boolean)
  const aliasOk = aliasList.every((a) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(a))
  const ipOk = ip.trim() === '' || /^[0-9A-Fa-f:.]+$/.test(ip.trim())
  const valid = Boolean(net && ctr) && aliasOk && ipOk
  const go = (): void => {
    if (valid && !busy) submit(() => onConnect(net, ctr, aliasList, ip.trim() || undefined))
  }
  return (
    <Modal
      title={
        container
          ? t('Connect {name} to a network', { name: container.name })
          : t('Connect a container to {name}', { name: network?.name ?? '' })
      }
      onClose={onClose}
      testId="docker-connect-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid || busy}
            data-testid="docker-connect-submit"
            onClick={go}
          >
            {busy ? t('Connecting…') : t('Connect')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {container ? (
          <Field label={t('Network')}>
            <Select
              autoFocus
              value={net}
              data-testid="docker-connect-network"
              onChange={(e) => {
                setNet(e.target.value)
              }}
            >
              {choices.map((n) => (
                <option key={n.id} value={n.id}>
                  {`${n.name} (${n.driver})`}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={t('Container')}>
            <Select
              autoFocus
              value={ctr}
              data-testid="docker-connect-container"
              onChange={(e) => {
                setCtr(e.target.value)
              }}
            >
              {containers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Aliases')} hint={t('Extra names on this network, separated by spaces')}>
            <Input
              mono
              placeholder="api db"
              data-testid="docker-connect-aliases"
              value={aliases}
              onChange={(e) => {
                setAliases(e.target.value)
              }}
            />
          </Field>
          <Field label={t('IPv4 address')} hint={t('Optional — needs a subnet set on the network')}>
            <Input
              mono
              placeholder="172.28.0.10"
              data-testid="docker-connect-ip"
              value={ip}
              onChange={(e) => {
                setIp(e.target.value)
              }}
            />
          </Field>
        </div>
        {(!aliasOk || !ipOk) && (
          <p className="text-xs text-warning">
            {!aliasOk
              ? t('Aliases use letters, digits, "_", "." and "-"')
              : t('Use an IP address, like 172.28.0.1')}
          </p>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  )
}

export function TagDialog({
  source,
  onClose,
  onTag
}: {
  source: string
  onClose: () => void
  onTag: (target: string) => Promise<void>
}): React.JSX.Element {
  const [target, setTarget] = useState(source.includes(':') ? source : `${source}:latest`)
  const { busy, error, submit } = useSubmit()
  const clean = target.trim()
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(clean) && clean !== source
  const go = (): void => {
    if (valid && !busy) submit(() => onTag(clean))
  }
  return (
    <Modal
      title={t('Tag {name}', { name: source })}
      description={t(
        'Adds another name to the same image — to push it, include the registry: ghcr.io/org/app:1.0'
      )}
      onClose={onClose}
      testId="docker-tag-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid || busy}
            data-testid="docker-tag-submit"
            onClick={go}
          >
            {t('Tag')}
          </Button>
        </>
      }
    >
      <Field label={t('New tag')}>
        <Input
          autoFocus
          mono
          data-testid="docker-tag-input"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
        />
      </Field>
      {error && (
        <div className="mt-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}
    </Modal>
  )
}

// ——— Registry ———

const PRESETS = [
  { id: 'docker.io', label: 'Docker Hub' },
  { id: 'ghcr.io', label: 'GitHub (ghcr.io)' },
  { id: 'registry.gitlab.com', label: 'GitLab (registry.gitlab.com)' },
  { id: 'quay.io', label: 'Quay (quay.io)' },
  { id: '', label: '' }
] as const

function secretHint(server: string): string {
  switch (normalizeRegistry(server)) {
    case 'docker.io':
      return t('An access token from Docker Hub → Account settings → Personal access tokens.')
    case 'ghcr.io':
      return t('A GitHub personal access token with read:packages (and write:packages to push).')
    case 'registry.gitlab.com':
      return t('A GitLab access token with read_registry (and write_registry to push).')
    default:
      return t('Password or access token.')
  }
}

function RegistryForm({
  initial,
  onDone,
  onCancel
}: {
  initial: DockerRegistry | null
  onDone: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [server, setServer] = useState(initial?.server ?? 'docker.io')
  const preset = PRESETS.some((p) => p.id && p.id === server) ? server : ''
  const [name, setName] = useState(initial?.name ?? '')
  const [username, setUsername] = useState(initial?.username ?? '')
  const [secret, setSecret] = useState('')
  const { busy, error, submit } = useSubmit()
  const valid =
    server.trim() !== '' && username.trim() !== '' && (initial !== null || secret !== '')
  const go = (): void => {
    if (!valid || busy) return
    submit(async () => {
      const presetName = PRESETS.find((p) => p.id === normalizeRegistry(server))?.label
      const r = await dockerApi.saveRegistry({
        ...(initial ? { id: initial.id } : {}),
        name: name.trim() || presetName || normalizeRegistry(server),
        server: server.trim(),
        username: username.trim(),
        ...(secret ? { secret } : {})
      })
      if (!r.ok) throw new Error(r.message)
      onDone()
    })
  }
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-line p-3"
      data-testid="docker-registry-form"
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Registry')}>
          <Select
            value={preset}
            data-testid="docker-registry-preset"
            onChange={(e) => {
              setServer(e.target.value)
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.id || 'other'} value={p.id}>
                {p.id ? p.label : t('Other registry…')}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Address')}>
          <Input
            mono
            placeholder="registry.example.com:5000"
            data-testid="docker-registry-server"
            value={server}
            onChange={(e) => {
              setServer(e.target.value)
            }}
          />
        </Field>
        <Field label={t('Username')}>
          <Input
            autoFocus
            mono
            autoComplete="off"
            data-testid="docker-registry-username"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value)
            }}
          />
        </Field>
        <Field label={t('Display name')} hint={t('Optional')}>
          <Input
            value={name}
            placeholder={PRESETS.find((p) => p.id === normalizeRegistry(server))?.label ?? ''}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
        </Field>
      </div>
      <Field
        label={t('Password or access token')}
        hint={initial ? t('Leave empty to keep the saved one.') : secretHint(server)}
      >
        <Input
          type="password"
          mono
          autoComplete="new-password"
          data-testid="docker-registry-secret"
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
        />
      </Field>
      <p className="text-xs text-faint">
        {t(
          'Stored encrypted in your vault. Only sent to Docker when pulling or pushing an image of this registry.'
        )}
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!valid || busy}
          data-testid="docker-registry-save"
          onClick={go}
        >
          {t('Save')}
        </Button>
      </div>
    </div>
  )
}

/** Danh sách registry + thêm / sửa / xoá; `onTest` (trong tab Docker) thử đăng nhập. */
export function RegistriesPanel({
  registries,
  onTest
}: {
  registries: readonly DockerRegistry[]
  onTest?: (id: string) => Promise<string>
}): React.JSX.Element {
  const [editing, setEditing] = useState<DockerRegistry | 'new' | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-2" data-testid="docker-registries">
      {registries.length === 0 && editing === null && (
        <p className="text-xs text-faint">{t('No registries yet.')}</p>
      )}
      {registries.map((r) => (
        <div
          key={r.id}
          className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5"
          data-testid="docker-registry"
          data-name={r.name}
        >
          <KeyRound size={14} className="shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] text-fg">{r.name}</div>
            <div className="truncate font-mono text-[11px] text-faint">{`${r.username} @ ${r.server}`}</div>
          </div>
          {onTest && (
            <Button
              size="sm"
              variant="ghost"
              icon={<CheckCircle2 size={12} />}
              disabled={testing !== null}
              data-testid="docker-registry-test"
              onClick={() => {
                setTesting(r.id)
                onTest(r.id)
                  .then(
                    (status) => {
                      toast.success(t('Signed in to {name}', { name: r.name }), {
                        description: status
                      })
                    },
                    (e: unknown) => {
                      toast.error(t('Could not sign in to {name}', { name: r.name }), {
                        description: cleanError(e)
                      })
                    }
                  )
                  .finally(() => {
                    setTesting(null)
                  })
              }}
            >
              {testing === r.id ? t('Testing…') : t('Test')}
            </Button>
          )}
          <IconButton
            size="sm"
            label={t('Edit')}
            onClick={() => {
              setEditing(r)
            }}
          >
            <Pencil size={12} />
          </IconButton>
          <IconButton
            size="sm"
            label={t('Delete')}
            className="hover:text-danger"
            onClick={() => {
              void confirmAction({
                title: t('Delete the registry {name}?', { name: r.name }),
                message: t('The saved login is removed from your vault. Images are not affected.'),
                confirmLabel: t('Delete'),
                danger: true
              }).then((ok) => {
                if (ok) void dockerApi.deleteRegistry(r.id)
              })
            }}
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
      ))}
      {editing !== null ? (
        <RegistryForm
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null)
          }}
          onCancel={() => {
            setEditing(null)
          }}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          icon={<Plus size={13} />}
          data-testid="docker-registry-add"
          onClick={() => {
            setEditing('new')
          }}
        >
          {t('Add a registry')}
        </Button>
      )}
    </div>
  )
}

export function RegistriesDialog({
  registries,
  onTest,
  onClose
}: {
  registries: readonly DockerRegistry[]
  onTest?: (id: string) => Promise<string>
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal
      title={t('Registries')}
      description={t(
        'Logins for pulling and pushing private images (Docker Hub, GitHub, GitLab, your own registry).'
      )}
      width="max-w-xl"
      onClose={onClose}
      testId="docker-registries-dialog"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('Done')}
        </Button>
      }
    >
      <RegistriesPanel registries={registries} {...(onTest ? { onTest } : {})} />
    </Modal>
  )
}

// ——— Build ———

interface BuildForm {
  context: string
  dockerfile: string
  tags: string
  buildArgs: string
  target: string
  noCache: boolean
  pull: boolean
  /** Nền tảng buildx đã chọn; rỗng = `docker build` thường. */
  platforms: string[]
  output: 'load' | 'push' | 'none'
  builder: string
  /** Registry đã lưu để đăng nhập khi push; '' = không đăng nhập. */
  registry: string
}

/** Nền tảng hay gặp — thêm các nền tảng builder đang chọn báo hỗ trợ. */
const COMMON_PLATFORMS = ['linux/amd64', 'linux/arm64', 'linux/arm/v7', 'linux/386']

const EMPTY_BUILD: BuildForm = {
  context: '',
  dockerfile: '',
  tags: '',
  buildArgs: '',
  target: '',
  noCache: false,
  pull: false,
  platforms: [],
  output: 'load',
  builder: '',
  registry: ''
}

function loadForm(key: string): BuildForm {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...EMPTY_BUILD, ...(JSON.parse(raw) as Partial<BuildForm>) } : EMPTY_BUILD
  } catch {
    return EMPTY_BUILD
  }
}

/** Build output: giữ tối đa chừng này ký tự (BuildKit in rất nhiều với build dài). */
const BUILD_LOG_MAX = 400_000

/**
 * Build image bằng `docker build` (BuildKit) trên máy chạy Docker; output hiện trực tiếp, huỷ được.
 * Form nhớ theo nguồn (lần sau mở lại điền sẵn).
 */
export function BuildDialog({
  where,
  storageKey,
  registries,
  info,
  start,
  cancel,
  subscribe,
  onClose,
  onBuilt
}: {
  /** Context nằm ở đâu: máy này / server / WSL. */
  where: 'local' | 'ssh' | 'wsl'
  storageKey: string
  /** Registry đã lưu (đăng nhập khi push). */
  registries: readonly DockerRegistry[]
  /** Buildx có không, và các builder — hỏi một lần khi mở. */
  info: () => Promise<BuildInfo>
  start: (spec: BuildSpec) => Promise<string>
  cancel: (subscription: string) => void
  subscribe: (listener: (event: string, data: unknown) => void) => () => void
  onClose: () => void
  onBuilt: (tags: string[]) => void
}): React.JSX.Element {
  const [form, setForm] = useState<BuildForm>(() => loadForm(storageKey))
  const [phase, setPhase] = useState<'form' | 'running' | 'done' | 'failed'>('form')
  const [log, setLog] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [buildInfo, setBuildInfo] = useState<BuildInfo | 'unknown' | null>(null)
  useEffect(() => {
    let cancelled = false
    info().then(
      (i) => {
        if (!cancelled) setBuildInfo(i)
      },
      () => {
        if (!cancelled) setBuildInfo('unknown')
      }
    )
    return () => {
      cancelled = true
    }
  }, [info])
  const sub = useRef<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  const set = <K extends keyof BuildForm>(k: K, v: BuildForm[K]): void => {
    setForm((f) => ({ ...f, [k]: v }))
  }
  const tags = form.tags.split(/[\s,]+/).filter(Boolean)
  const args = form.buildArgs
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const multi = form.platforms.length > 1
  // Nhiều nền tảng không nạp được vào Engine → push (hoặc chỉ build).
  const output = multi && form.output === 'load' ? 'push' : form.output
  const buildx = buildInfo !== null && buildInfo !== 'unknown' && buildInfo.buildx !== null
  const chosenBuilder =
    buildInfo !== null && buildInfo !== 'unknown'
      ? (buildInfo.builders.find((b) => b.name === form.builder.trim()) ??
        buildInfo.builders.find((b) => b.current))
      : undefined
  const platformChoices = [...new Set([...COMMON_PLATFORMS, ...(chosenBuilder?.platforms ?? [])])]
  const registryChoice =
    output === 'push' ? (registries.find((r) => r.id === form.registry) ?? null) : null
  const spec = BuildSpec.safeParse({
    context: form.context.trim(),
    ...(form.dockerfile.trim() ? { dockerfile: form.dockerfile.trim() } : {}),
    tags,
    buildArgs: args,
    ...(form.target.trim() ? { target: form.target.trim() } : {}),
    noCache: form.noCache,
    pull: form.pull,
    ...(form.platforms.length > 0
      ? {
          platforms: form.platforms,
          output,
          ...(output === 'push' && registryChoice ? { registry: registryChoice.id } : {})
        }
      : {}),
    ...(form.builder.trim() ? { builder: form.builder.trim() } : {})
  })
  const problem =
    !spec.success && form.context.trim()
      ? spec.error.issues[0]?.path[0] === 'tags'
        ? output === 'push' && form.platforms.length > 0 && tags.length === 0
          ? t('Pushing needs at least one tag')
          : t('Tags look like app:1.0 or ghcr.io/org/app:1.0')
        : spec.error.issues[0]?.path[0] === 'buildArgs'
          ? t('Build arguments look like NAME=value')
          : spec.error.issues[0]?.path[0] === 'target'
            ? t('The target is a stage name from the Dockerfile')
            : t('Check the paths')
      : null

  // Hàm mới nhất qua ref: người nghe sự kiện đăng ký một lần, huỷ khi đóng (không theo mỗi lần vẽ).
  const latest = useRef({ tags, onBuilt, cancel })
  useEffect(() => {
    latest.current = { tags, onBuilt, cancel }
  })
  /** Sự kiện tới trước khi biết id đăng ký (hiếm) — giữ lại, phát lại khi có id. */
  const early = useRef<{ event: string; data: unknown }[] | null>(null)

  const handle = useRef((event: string, data: unknown): void => {
    const d = data as { subscription?: string; text?: string; error?: string }
    if (!sub.current) {
      if (early.current && early.current.length < 2000) early.current.push({ event, data })
      return
    }
    if (d.subscription !== sub.current) return
    if (event === 'build') {
      const text = d.text ?? ''
      setLog((prev) => {
        const next = prev + text
        return next.length > BUILD_LOG_MAX ? next.slice(next.length - BUILD_LOG_MAX) : next
      })
    } else if (event === 'build-end') {
      sub.current = null
      if (d.error) {
        setError(d.error)
        setPhase('failed')
      } else {
        setPhase('done')
        latest.current.onBuilt(latest.current.tags)
      }
    }
  })

  useEffect(
    () =>
      subscribe((event, data) => {
        handle.current(event, data)
      }),
    [subscribe]
  )

  useEffect(() => {
    const el = logRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [log])

  // Đóng khi đang build → huỷ thật (không để `docker build` chạy ngầm).
  useEffect(
    () => () => {
      if (sub.current) latest.current.cancel(sub.current)
    },
    []
  )

  const go = (): void => {
    if (!spec.success || phase === 'running') return
    try {
      localStorage.setItem(storageKey, JSON.stringify(form))
    } catch {
      // Hết chỗ / bị chặn — chỉ là tiện ích.
    }
    setLog('')
    setError(null)
    setPhase('running')
    stick.current = true
    early.current = []
    start(spec.data).then(
      (id) => {
        sub.current = id
        const pending = early.current ?? []
        early.current = null
        for (const e of pending) handle.current(e.event, e.data)
      },
      (e: unknown) => {
        early.current = null
        setError(cleanError(e))
        setPhase('failed')
      }
    )
  }

  const contextHint =
    where === 'ssh'
      ? t('A folder on the server, like /srv/app — the build runs there.')
      : where === 'wsl'
        ? t('A folder inside the WSL distribution, like /home/me/app.')
        : t('A folder on this computer.')

  return (
    <Modal
      title={t('Build an image')}
      description={t('Runs docker build (BuildKit) where Docker runs. The output appears live.')}
      width="max-w-3xl"
      onClose={onClose}
      testId="docker-build-dialog"
      footer={
        phase === 'running' ? (
          <Button
            variant="danger"
            data-testid="docker-build-cancel"
            onClick={() => {
              if (sub.current) cancel(sub.current)
              sub.current = null
              setPhase('failed')
              setError(t('Build cancelled.'))
            }}
          >
            {t('Cancel build')}
          </Button>
        ) : (
          <>
            {phase !== 'form' && (
              <Button
                variant="ghost"
                onClick={() => {
                  setPhase('form')
                }}
              >
                {t('Edit settings')}
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              {t('Close')}
            </Button>
            <Button
              variant="primary"
              disabled={!spec.success}
              data-testid="docker-build-submit"
              onClick={go}
            >
              {phase === 'form' ? t('Build') : t('Build again')}
            </Button>
          </>
        )
      }
    >
      {phase === 'form' ? (
        <div className="flex flex-col gap-3">
          <Field label={t('Build context')} hint={contextHint}>
            <Input
              autoFocus
              mono
              placeholder={where === 'local' ? '~/projects/app' : '/srv/app'}
              data-testid="docker-build-context"
              value={form.context}
              onChange={(e) => {
                set('context', e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go()
              }}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Dockerfile')} hint={t('Relative to the context; empty = Dockerfile')}>
              <Input
                mono
                placeholder="Dockerfile"
                value={form.dockerfile}
                onChange={(e) => {
                  set('dockerfile', e.target.value)
                }}
              />
            </Field>
            <Field label={t('Tags')} hint={t('Separated by spaces')}>
              <Input
                mono
                placeholder="app:dev ghcr.io/org/app:1.0"
                data-testid="docker-build-tags"
                value={form.tags}
                onChange={(e) => {
                  set('tags', e.target.value)
                }}
              />
            </Field>
            <Field label={t('Build arguments')} hint={t('One NAME=value per line')}>
              <TextArea
                rows={2}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder="VERSION=1.2.3"
                value={form.buildArgs}
                onChange={(e) => {
                  set('buildArgs', e.target.value)
                }}
              />
            </Field>
            <Field label={t('Target stage')} hint={t('Optional — for multi-stage Dockerfiles')}>
              <Input
                mono
                placeholder="production"
                value={form.target}
                onChange={(e) => {
                  set('target', e.target.value)
                }}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Checkbox
              label={t('No cache')}
              description={t('Rebuild every step (--no-cache)')}
              checked={form.noCache}
              onChange={(e) => {
                set('noCache', e.target.checked)
              }}
            />
            <Checkbox
              label={t('Pull base images')}
              description={t('Always check for newer base images (--pull)')}
              checked={form.pull}
              onChange={(e) => {
                set('pull', e.target.checked)
              }}
            />
          </div>
          <div
            className="flex flex-col gap-2 rounded-md border border-line p-3"
            data-testid="docker-build-platforms"
          >
            <span className="text-xs font-medium text-muted">{t('Platforms (buildx)')}</span>
            {buildInfo === null ? (
              <span className="text-xs text-faint">{t('Checking buildx…')}</span>
            ) : !buildx ? (
              <span className="text-xs text-faint" data-testid="docker-build-no-buildx">
                {t(
                  'Docker Buildx is not available here — builds use the single-platform docker build.'
                )}
              </span>
            ) : (
              <>
                <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                  {platformChoices.map((p) => (
                    <Checkbox
                      key={p}
                      label={p}
                      checked={form.platforms.includes(p)}
                      data-testid={`docker-build-platform-${p}`}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...form.platforms, p]
                          : form.platforms.filter((x) => x !== p)
                        setForm((f) => ({
                          ...f,
                          platforms: next,
                          // Nhiều nền tảng không nạp được → chuyển sang push.
                          output: next.length > 1 && f.output === 'load' ? 'push' : f.output
                        }))
                      }}
                    />
                  ))}
                </div>
                {form.platforms.length > 0 && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('Result')}>
                      <Select
                        value={output}
                        data-testid="docker-build-output"
                        onChange={(e) => {
                          set('output', e.target.value as BuildForm['output'])
                        }}
                      >
                        <option value="load" disabled={multi}>
                          {t('Load into this engine')}
                        </option>
                        <option value="push">{t('Push to a registry')}</option>
                        <option value="none">{t('Build only (check it builds)')}</option>
                      </Select>
                    </Field>
                    {output === 'push' && (
                      <Field label={t('Registry login')}>
                        <Select
                          value={registryChoice?.id ?? ''}
                          data-testid="docker-build-registry"
                          onChange={(e) => {
                            set('registry', e.target.value)
                          }}
                        >
                          <option value="">
                            {t('No login (use what the server already has)')}
                          </option>
                          {registries
                            .filter((r) => tags.every((tag) => registryFor(tag, [r]) !== null))
                            .map((r) => (
                              <option key={r.id} value={r.id}>
                                {`${r.name} (${r.username})`}
                              </option>
                            ))}
                        </Select>
                      </Field>
                    )}
                  </div>
                )}
                {buildInfo.builders.length > 0 && (
                  <Field
                    label={t('Builder')}
                    hint={t(
                      'Several platforms need a builder with the docker-container driver (docker buildx create --use). Empty = the current builder.'
                    )}
                  >
                    <Select
                      value={form.builder}
                      data-testid="docker-build-builder"
                      onChange={(e) => {
                        set('builder', e.target.value)
                      }}
                    >
                      <option value="">
                        {t('Current builder')}
                        {chosenBuilder ? ` (${chosenBuilder.name})` : ''}
                      </option>
                      {buildInfo.builders.map((b) => (
                        <option key={b.name} value={b.name}>
                          {`${b.name} · ${b.driver}`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </>
            )}
          </div>
          {problem && <p className="text-xs text-warning">{problem}</p>}
          {tags.length === 0 && form.context.trim() !== '' && (
            <p className="text-xs text-faint">
              {t('Without a tag the image only appears as a dangling image.')}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div
            className="flex items-center gap-2 text-xs"
            role="status"
            data-testid="docker-build-status"
          >
            <span
              className={cx(
                'size-2 rounded-full',
                phase === 'running'
                  ? 'animate-pulse bg-info'
                  : phase === 'done'
                    ? 'bg-success'
                    : 'bg-danger-solid'
              )}
            />
            <span className="text-muted">
              {phase === 'running'
                ? t('Building {context}…', { context: form.context })
                : phase === 'done'
                  ? tags.length
                    ? t('Built {tags}', { tags: tags.join(', ') })
                    : t('Build finished')
                  : t('Build failed')}
            </span>
          </div>
          <pre
            ref={logRef}
            className="h-[50vh] overflow-auto rounded-md bg-subtle p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg select-text"
            data-testid="docker-build-log"
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
          >
            {log || (phase === 'running' ? t('Starting…') : '')}
          </pre>
          {error && (
            <Notice tone="danger" testId="docker-build-error">
              {error}
            </Notice>
          )}
        </div>
      )}
    </Modal>
  )
}
