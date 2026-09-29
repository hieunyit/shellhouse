import { useMemo, useState, type SyntheticEvent } from 'react'
import { inheritedDefaults } from '@shared/inherit'
import { KeyRound, X } from 'lucide-react'
import { HostInput, MAX_JUMPS, type AuthKind, type HostMode, type HostSummary } from '@shared/hosts'
import { useHosts } from '../stores/hosts'
import { ColorPicker } from './ColorPicker'
import { GroupSelect } from './GroupSelect'
import {
  Button,
  Checkbox,
  cx,
  Field,
  IconButton,
  Input,
  Modal,
  Notice,
  Segmented,
  Select
} from './ui'

export function HostForm({
  host,
  defaultGroupId,
  onClose
}: {
  host: HostSummary | null
  defaultGroupId: string | null
  onClose: () => void
}): React.JSX.Element {
  const { keys, hosts } = useHosts((s) => s.tree)
  const [label, setLabel] = useState(host?.label ?? '')
  const [hostname, setHostname] = useState(host?.hostname ?? '')
  // '' = kế thừa từ nhóm (hoặc 22).
  const [port, setPort] = useState(host ? (host.port === null ? '' : String(host.port)) : '')
  const [username, setUsername] = useState(host?.username ?? '')
  const [auth, setAuth] = useState<AuthKind>(host?.auth ?? 'auto')
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [keyId, setKeyId] = useState<string | null>(host?.keyId ?? keys[0]?.id ?? null)
  const [passphrase, setPassphrase] = useState('')
  const [groupId, setGroupId] = useState<string | null>(host?.groupId ?? defaultGroupId)
  const [tags, setTags] = useState(host?.tags.join(', ') ?? '')
  const [color, setColor] = useState<HostSummary['color']>(host?.color ?? null)
  const [jumpHostIds, setJumpHostIds] = useState<string[]>(host?.jumpHostIds ?? [])
  const [mode, setMode] = useState<HostMode>(host?.mode ?? 'builtin')
  const [direct, setDirect] = useState(host?.direct ?? false)
  const groupTree = useHosts((s) => s.groupTree)
  const inherited = useMemo(() => inheritedDefaults(groupTree, groupId), [groupTree, groupId])
  const from = (g: { groupName: string } | undefined): string => (g ? ` (from ${g.groupName})` : '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const hostLabel = (id: string): string => hosts.find((h) => h.id === id)?.label ?? '(deleted)'
  const jumpChoices = hosts.filter((h) => h.id !== host?.id && !jumpHostIds.includes(h.id))

  const importKey = async (): Promise<void> => {
    const result = await window.shellhouse.importKeyFromFile()
    if (!result) return
    if (!result.ok) {
      setError(result.message)
      return
    }
    await useHosts.getState().reload()
    setKeyId(result.id)
  }

  const submit = async (event?: SyntheticEvent): Promise<void> => {
    event?.preventDefault()
    // password/passphrase: undefined = keep the stored value (when editing without retyping).
    const keepPassword = host?.hasPassword && password === '' && !clearPassword
    const draft = {
      ...(host ? { id: host.id } : {}),
      groupId,
      label: label || hostname,
      hostname: hostname.trim(),
      port: port.trim() === '' ? null : Number(port),
      username: username.trim(),
      auth,
      ...(auth === 'password' && !keepPassword ? { password } : {}),
      keyId: auth === 'key' ? keyId : null,
      ...(auth === 'key' && passphrase ? { passphrase } : {}),
      keyFile: host?.keyFile ?? null,
      proxyJump: host?.proxyJump ?? null,
      jumpHostIds,
      mode,
      ...(direct ? { direct: true } : {}),
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      color
    }
    if (!draft.username && !inherited.username) {
      setError('Enter a username')
      return
    }
    const parsed = HostInput.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid input')
      return
    }
    setSaving(true)
    const result = await window.shellhouse.saveHost(parsed.data)
    setSaving(false)
    setPassword('')
    setPassphrase('')
    if (result.ok) onClose()
    else setError(result.message)
  }

  const remove = async (): Promise<void> => {
    if (!host) return
    await window.shellhouse.deleteHost(host.id)
    onClose()
  }

  return (
    <Modal
      title={host ? `Edit ${host.label}` : 'New host'}
      onClose={onClose}
      width="max-w-xl"
      testId="host-form"
      footer={
        <>
          {host && (
            <Button variant="danger-ghost" className="mr-auto" onClick={() => void remove()}>
              Delete host
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving}
            data-testid="host-save"
            onClick={() => void submit()}
          >
            Save
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field label="Hostname or IP">
            <Input
              autoFocus
              mono
              spellCheck={false}
              placeholder="server.example.com"
              data-testid="host-hostname"
              value={hostname}
              onChange={(e) => {
                setHostname(e.target.value)
              }}
            />
          </Field>
          <Field label="Port">
            <Input
              mono
              inputMode="numeric"
              data-testid="host-port"
              placeholder={inherited.port ? String(inherited.port.value) : '22'}
              title={inherited.port ? `From group ${inherited.port.groupName}` : undefined}
              value={port}
              onChange={(e) => {
                setPort(e.target.value)
              }}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Username"
            hint={
              inherited.username && !username
                ? `Using “${inherited.username.value}”${from(inherited.username)}`
                : undefined
            }
          >
            <Input
              mono
              spellCheck={false}
              placeholder={inherited.username ? inherited.username.value : 'root'}
              data-testid="host-username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
              }}
            />
          </Field>
          <Field label="Label">
            <Input
              placeholder={hostname || 'Defaults to the hostname'}
              data-testid="host-label"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value)
              }}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
          <span className="text-xs font-medium text-muted">Authentication</span>
          <Segmented
            value={auth}
            onChange={setAuth}
            testIdPrefix="host-auth"
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'password', label: 'Password' },
              { value: 'key', label: 'SSH key' }
            ]}
          />
          {auth === 'auto' && (
            <p className="text-xs text-faint">
              {inherited.keyId
                ? `Tries the group key “${keys.find((k) => k.id === inherited.keyId?.value)?.name ?? '?'}”${from(inherited.keyId)}, your SSH agent and default keys, then asks for a password.`
                : 'Tries your SSH agent and default keys (~/.ssh/id_*), then asks for a password.'}
            </p>
          )}
          {auth === 'password' && (
            <div className="flex flex-col gap-2">
              <Input
                type="password"
                autoComplete="off"
                data-testid="host-password"
                placeholder={
                  host?.hasPassword
                    ? 'Saved — leave empty to keep it'
                    : 'Password (stored encrypted)'
                }
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                }}
              />
              {host?.hasPassword && (
                <Checkbox
                  label="Forget the saved password (ask every time)"
                  checked={clearPassword}
                  onChange={(e) => {
                    setClearPassword(e.target.checked)
                  }}
                />
              )}
            </div>
          )}
          {auth === 'key' && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <Select
                  data-testid="host-key"
                  value={keyId ?? ''}
                  onChange={(e) => {
                    setKeyId(e.target.value || null)
                  }}
                >
                  {keys.length === 0 && <option value="">No keys in the vault yet</option>}
                  {keys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name} ({k.type}
                      {k.encrypted ? ', passphrase' : ''})
                    </option>
                  ))}
                </Select>
                <Button icon={<KeyRound size={14} />} onClick={() => void importKey()}>
                  Import…
                </Button>
              </div>
              {keys.find((k) => k.id === keyId)?.encrypted && (
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder="Passphrase (leave empty to be asked when connecting)"
                  value={passphrase}
                  onChange={(e) => {
                    setPassphrase(e.target.value)
                  }}
                />
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <span className="text-xs font-medium text-muted">Jump hosts (ProxyJump)</span>
          {jumpHostIds.length > 0 ? (
            <ol className="flex flex-col gap-1" data-testid="jump-list">
              {jumpHostIds.map((id, i) => (
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
                      setJumpHostIds(jumpHostIds.filter((j) => j !== id))
                    }}
                  >
                    <X size={13} />
                  </IconButton>
                </li>
              ))}
              <li className="px-2 text-xs text-faint">→ {label || hostname || 'this host'}</li>
            </ol>
          ) : host?.proxyJump ? (
            <p className="text-xs text-faint">
              Using ProxyJump from ~/.ssh/config: {host.proxyJump}
            </p>
          ) : inherited.jumpHostIds ? (
            <div className="flex flex-col gap-1.5" data-testid="jump-inherited">
              <p className={cx('text-xs', direct ? 'text-faint line-through' : 'text-muted')}>
                Through {inherited.jumpHostIds.value.map(hostLabel).join(' → ')}
                {from(inherited.jumpHostIds)}
              </p>
              <Checkbox
                label="Connect directly (ignore the group's jump hosts)"
                data-testid="host-direct"
                checked={direct}
                onChange={(e) => {
                  setDirect(e.target.checked)
                }}
              />
            </div>
          ) : (
            <p className="text-xs text-faint">Direct connection.</p>
          )}
          {jumpHostIds.length < MAX_JUMPS && jumpChoices.length > 0 && (
            <Select
              value=""
              data-testid="jump-add"
              onChange={(e) => {
                if (e.target.value) setJumpHostIds([...jumpHostIds, e.target.value])
              }}
            >
              <option value="">Add a jump host…</option>
              {jumpChoices.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label} ({h.hostname})
                </option>
              ))}
            </Select>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Group">
            <GroupSelect
              testId="host-group"
              value={groupId}
              onChange={setGroupId}
              noneLabel="No group"
            />
          </Field>
          <Field label="Tags" hint="Comma separated">
            <Input
              value={tags}
              placeholder="prod, web"
              onChange={(e) => {
                setTags(e.target.value)
              }}
            />
          </Field>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted">Color</span>
          <ColorPicker
            value={color}
            onChange={setColor}
            noneLabel={
              inherited.color ? `Use the group color (${inherited.color.value})` : 'No color'
            }
            testIdPrefix="host-color"
          />
          {!color && inherited.color && (
            <span className="text-xs text-muted">
              Using {inherited.color.value}
              {from(inherited.color)}
            </span>
          )}
        </div>

        <Checkbox
          data-testid="host-mode-system"
          checked={mode === 'system'}
          onChange={(e) => {
            setMode(e.target.checked ? 'system' : 'builtin')
          }}
          label="Compatibility mode: use the system ssh command"
          description="For GSSAPI/Kerberos, FIDO hardware keys or complex ssh_config setups. OpenSSH asks for passwords and host keys in the terminal. SFTP, port forwarding and passwords/keys stored in the vault are not available."
        />

        {host?.keyFile && (
          <p className="text-xs text-faint">IdentityFile from ~/.ssh/config: {host.keyFile}</p>
        )}
        {error && (
          <Notice tone="danger" testId="host-error">
            {error}
          </Notice>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
