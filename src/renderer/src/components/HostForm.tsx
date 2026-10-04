import { toast } from '../stores/toasts'
import { useMemo, useState, type SyntheticEvent } from 'react'
import { t } from '@shared/i18n'
import { inheritedDefaults } from '@shared/inherit'
import { ArrowRight, KeyRound, X, ChevronRight, Pencil } from 'lucide-react'
import {
  ENCODINGS,
  HostInput,
  MAX_JUMPS,
  type AccountSummary,
  type AuthKind,
  type HostMode,
  type HostProtocol,
  type HostSummary
} from '@shared/hosts'

type EncodingId = (typeof ENCODINGS)[number]['id']
import { DEFAULT_SERIAL, type SerialSettings } from '@shared/serial'
import {
  DEFAULT_RDP,
  RDP_DEFAULT_PORT,
  RdpSettings,
  RdpUsername,
  splitDomainUser,
  type RdpSettings as RdpSettingsValue
} from '@shared/rdp'
import { SerialFields } from './SerialFields'
import { RdpFields } from './RdpFields'
import { useHosts } from '../stores/hosts'
import { ColorPicker, colorName } from './ColorPicker'
import { PasswordInput } from './PasswordInput'
import { TagInput } from './TagInput'
import { GroupSelect } from './GroupSelect'
import { DeleteHostsDialog } from './sidebar/dialogs'
import { AccountPicker } from './accounts/AccountPicker'
import { AccountEditor } from './accounts/AccountEditor'
import { AccountBadges, AccountsDialog } from './accounts/AccountsManager'
import { customFromAccount, suggestAccountName } from './accounts/account-logic'
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

/** Port gõ tay: trống = mặc định / kế thừa; có giá trị thì phải là số nguyên 1–65535. */
export function portProblem(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return null
  if (!/^\d+$/.test(text)) return t('Port must be a number from 1 to 65535')
  const n = Number(text)
  return n >= 1 && n <= 65535 ? null : t('Port must be a number from 1 to 65535')
}

/** Lỗi ngay dưới ô nhập (role=alert: trình đọc màn hình đọc lên). */
function FieldError({
  children,
  testId
}: {
  children: string
  testId?: string
}): React.JSX.Element {
  return (
    <span role="alert" className="text-xs text-danger" data-testid={testId}>
      {children}
    </span>
  )
}

export function HostForm({
  host,
  defaultGroupId,
  onClose
}: {
  host: HostSummary | null
  defaultGroupId: string | null
  onClose: () => void
}): React.JSX.Element {
  const { keys, hosts, accounts } = useHosts((s) => s.tree)
  const [protocol, setProtocol] = useState<HostProtocol>(host?.protocol ?? 'ssh')
  const [serial, setSerial] = useState<SerialSettings>(
    host?.serial ?? { path: '', ...DEFAULT_SERIAL }
  )
  const isSsh = protocol === 'ssh'
  const isRdp = protocol === 'rdp'
  const [rdp, setRdp] = useState<RdpSettingsValue>(host?.rdp ?? DEFAULT_RDP)
  const [rdpPath, setRdpPath] = useState<'direct' | 'ssh' | 'gateway'>(
    host?.rdp?.viaHostId ? 'ssh' : host?.rdp?.gateway ? 'gateway' : 'direct'
  )
  /** RDP: lưu mật khẩu trong vault (mstsc / FreeRDP dùng luôn) hay hỏi mỗi lần. */
  const [rdpSave, setRdpSave] = useState(host ? host.auth === 'password' : true)
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
  /** Tài khoản dùng chung (Settings → Accounts); null = thông tin riêng của host ("Custom"). */
  const [accountId, setAccountId] = useState<string | null>(host?.accountId ?? null)
  /** Vừa chuyển từ tài khoản sang Custom: mật khẩu / passphrase để trống thì main chép từ đây. */
  const [secretsFrom, setSecretsFrom] = useState<AccountSummary | null>(null)
  const [accountDialog, setAccountDialog] = useState<'manage' | 'new' | AccountSummary | null>(null)
  const [groupId, setGroupId] = useState<string | null>(host?.groupId ?? defaultGroupId)
  const [tags, setTags] = useState<string[]>(host?.tags ?? [])
  const [color, setColor] = useState<HostSummary['color']>(host?.color ?? null)
  const [jumpHostIds, setJumpHostIds] = useState<string[]>(host?.jumpHostIds ?? [])
  const [mode, setMode] = useState<HostMode>(host?.mode ?? 'builtin')
  const [direct, setDirect] = useState(host?.direct ?? false)
  const [legacy, setLegacy] = useState(host?.legacyAlgorithms ?? false)
  const [tmux, setTmux] = useState(host?.tmux ?? false)
  const [encoding, setEncoding] = useState<EncodingId>(
    ENCODINGS.find((e) => e.id === host?.encoding)?.id ?? 'utf-8'
  )
  // Mục Advanced mở sẵn khi host đang dùng một tuỳ chọn trong đó (không giấu cấu hình đang bật).
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(host?.legacyAlgorithms) ||
      Boolean(host?.tmux) ||
      host?.mode === 'system' ||
      Boolean(host?.encoding && host.encoding !== 'utf-8')
  )
  const groupTree = useHosts((s) => s.groupTree)
  const inherited = useMemo(() => inheritedDefaults(groupTree, groupId), [groupTree, groupId])
  const from = (g: { groupName: string } | undefined): string =>
    g ? ` ${t('(from {group})', { group: g.groupName })}` : ''
  const [error, setError] = useState<string | null>(null)
  /** Lỗi theo ô (hiện ngay dưới ô đó) — hostname / username trống khi bấm Save. */
  const [fieldError, setFieldError] = useState<{
    field: 'hostname' | 'username'
    message: string
  } | null>(null)
  const portError = protocol === 'serial' ? null : portProblem(port)
  /** Tag đã dùng ở các host khác — gợi ý cho ô Tags. */
  const knownTags = useMemo(
    () => [...new Set(hosts.flatMap((h) => h.tags))].sort((a, b) => a.localeCompare(b)),
    [hosts]
  )
  const [saving, setSaving] = useState(false)

  const account = accounts.find((a) => a.id === accountId) ?? null
  /** Host dùng tài khoản (chỉ SSH và RDP có phần đăng nhập). */
  const usesAccount = accountId !== null && (isSsh || isRdp)
  /** Có mật khẩu đã lưu để "để trống = giữ" (của host, hoặc của tài khoản vừa bỏ chọn). */
  const storedPassword = secretsFrom ? secretsFrom.hasPassword : Boolean(host?.hasPassword)
  const savedPlaceholder = secretsFrom
    ? t('From the account — leave empty to keep it')
    : t('Saved — leave empty to keep it')

  const chooseAccount = (id: string | null): void => {
    if (id === accountId) return
    if (id === null && account) {
      // Custom: chép giá trị của tài khoản để sửa tiếp; secret do main chép (renderer không có).
      const c = customFromAccount(account)
      setUsername(c.username)
      setAuth(c.auth)
      setKeyId(c.keyId ?? keys[0]?.id ?? null)
      if (c.domain) setRdp({ ...rdp, domain: c.domain })
      setRdpSave(c.savePassword)
      setSecretsFrom(account)
    }
    setPassword('')
    setPassphrase('')
    setClearPassword(false)
    setFieldError(null)
    setError(null)
    setAccountId(id)
  }

  /** Lỗi của tài khoản đang chọn khi Save (đã bị xoá, không có username nào dùng được). */
  const accountError = (): string | null => {
    if (!account) return t('The selected account no longer exists')
    if (isSsh && !account.username && !inherited.username)
      return t('The account “{name}” has no username and the group sets none', {
        name: account.name
      })
    return null
  }
  const accountFields = (): Partial<HostInput> =>
    usesAccount
      ? { accountId }
      : secretsFrom
        ? { accountId: null, secretsFrom: secretsFrom.id }
        : { accountId: null }

  const hostLabel = (id: string): string => hosts.find((h) => h.id === id)?.label ?? t('(deleted)')
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
    setFieldError(null)
    if (portError) return
    if (protocol !== 'serial' && !hostname.trim()) {
      setFieldError({ field: 'hostname', message: t('Enter a hostname or IP address') })
      return
    }
    // password/passphrase: undefined = keep the stored value (when editing without retyping).
    const keepPassword = storedPassword && password === '' && !clearPassword
    if (usesAccount) {
      const problem = accountError()
      if (problem) {
        setError(problem)
        return
      }
    }
    if (isRdp) {
      await submitRdp(keepPassword)
      return
    }
    if (!isSsh) {
      const draft = {
        ...(host ? { id: host.id } : {}),
        protocol,
        groupId,
        // Serial: hostname chỉ là giá trị giữ chỗ (cổng nằm trong `serial`).
        label: label || (protocol === 'serial' ? serial.path : hostname),
        hostname: protocol === 'serial' ? 'serial' : hostname.trim(),
        port: protocol === 'serial' ? 22 : port.trim() === '' ? 23 : Number(port),
        username: '',
        auth: 'auto' as const,
        keyId: null,
        keyFile: null,
        proxyJump: null,
        jumpHostIds: [],
        mode: 'builtin' as const,
        ...(protocol === 'serial' ? { serial } : {}),
        encoding: encoding === 'utf-8' ? null : encoding,
        tags,
        color
      }
      const parsed = HostInput.safeParse(draft)
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? t('Invalid input'))
        return
      }
      const result = await save(parsed.data)
      if (!result) return
      if (result.ok) {
        toast.success(
          host
            ? t('Saved {name}', { name: parsed.data.label })
            : t('Added {name}', { name: parsed.data.label }),
          { group: 'host-saved' }
        )
        onClose()
      } else setError(result.message)
      return
    }
    const draft = {
      ...(host ? { id: host.id } : {}),
      groupId,
      label: label || hostname,
      hostname: hostname.trim(),
      port: port.trim() === '' ? null : Number(port),
      ...(usesAccount
        ? { username: '', auth: 'auto' as const, keyId: null }
        : {
            username: username.trim(),
            auth,
            ...(auth === 'password' && !keepPassword ? { password } : {}),
            keyId: auth === 'key' ? keyId : null,
            ...(auth === 'key' && passphrase ? { passphrase } : {})
          }),
      ...accountFields(),
      keyFile: host?.keyFile ?? null,
      proxyJump: host?.proxyJump ?? null,
      jumpHostIds,
      mode,
      ...(direct ? { direct: true } : {}),
      ...(legacy ? { legacyAlgorithms: true } : {}),
      ...(tmux && mode !== 'system' ? { tmux: true } : {}),
      encoding: encoding === 'utf-8' ? null : encoding,
      tags,
      color
    }
    if (!usesAccount && !draft.username && !inherited.username) {
      setFieldError({ field: 'username', message: t('Enter a username') })
      return
    }
    const parsed = HostInput.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t('Invalid input'))
      return
    }
    const result = await save(parsed.data)
    setPassword('')
    setPassphrase('')
    if (!result) return
    if (result.ok) {
      const name = parsed.data.label || t('host')
      toast.success(host ? t('Saved {name}', { name }) : t('Added {name}', { name }), {
        description: host ? undefined : t('Double-click it in the sidebar to connect.')
      })
      onClose()
    } else setError(result.message)
  }

  /** Host Remote Desktop: tên đăng nhập kiểu Windows (CORP\\john tự tách domain), mật khẩu lưu / hỏi. */
  const submitRdp = async (keepPassword: boolean): Promise<void> => {
    // Dùng tài khoản: username / domain / mật khẩu lấy từ tài khoản lúc kết nối.
    const split = usesAccount ? { username: '', domain: null } : splitDomainUser(username)
    if (split.username) {
      const checked = RdpUsername.safeParse(split.username)
      if (!checked.success) {
        setFieldError({
          field: 'username',
          message: t(checked.error.issues[0]?.message ?? 'Invalid username')
        })
        return
      }
    }
    if (rdpPath === 'ssh' && !rdp.viaHostId) {
      setError(t('Choose the SSH host to connect through'))
      return
    }
    if (rdpPath === 'gateway' && !rdp.gateway) {
      setError(t('Enter the RD Gateway address'))
      return
    }
    const settings = RdpSettings.safeParse({
      ...rdp,
      domain: (split.domain ?? rdp.domain).trim(),
      viaHostId: rdpPath === 'ssh' ? rdp.viaHostId : null,
      gateway: rdpPath === 'gateway' ? rdp.gateway : null
    })
    if (!settings.success) {
      setError(t(settings.error.issues[0]?.message ?? 'Invalid input'))
      return
    }
    // Chọn lưu mà chưa từng nhập mật khẩu → coi như hỏi mỗi lần (không lưu mật khẩu rỗng).
    const store = !usesAccount && rdpSave && (password !== '' || keepPassword)
    const draft = {
      ...(host ? { id: host.id } : {}),
      protocol: 'rdp' as const,
      groupId,
      label: label || hostname.trim(),
      hostname: hostname.trim(),
      port: port.trim() === '' ? RDP_DEFAULT_PORT : Number(port),
      username: split.username,
      auth: store ? ('password' as const) : ('auto' as const),
      ...(store && !keepPassword ? { password } : {}),
      ...accountFields(),
      keyId: null,
      keyFile: null,
      proxyJump: null,
      jumpHostIds: [],
      mode: 'builtin' as const,
      rdp: settings.data,
      tags,
      color
    }
    const parsed = HostInput.safeParse(draft)
    if (!parsed.success) {
      setError(t(parsed.error.issues[0]?.message ?? 'Invalid input'))
      return
    }
    const result = await save(parsed.data)
    setPassword('')
    if (!result) return
    if (result.ok) {
      const name = parsed.data.label
      toast.success(host ? t('Saved {name}', { name }) : t('Added {name}', { name }), {
        description: host ? undefined : t('Double-click it in the sidebar to connect.')
      })
      onClose()
    } else setError(result.message)
  }

  /** Lưu host; IPC lỗi (reject) → báo lỗi, nút Save không bị kẹt ở trạng thái "đang lưu". */
  const save = async (
    data: HostInput
  ): Promise<Awaited<ReturnType<typeof window.shellhouse.saveHost>> | null> => {
    setSaving(true)
    try {
      return await window.shellhouse.saveHost(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setSaving(false)
    }
  }
  const [confirmDelete, setConfirmDelete] = useState(false)

  /** Ô chọn tài khoản ở đầu phần đăng nhập (SSH / RDP). */
  const accountRow = (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{t('Account')}</span>
      <AccountPicker
        value={accountId}
        accounts={accounts}
        keys={keys}
        protocol={protocol}
        onChange={chooseAccount}
        onCreate={() => {
          setAccountDialog('new')
        }}
        onManage={() => {
          setAccountDialog('manage')
        }}
      />
    </div>
  )
  /** Tóm tắt (chỉ đọc) tài khoản đang chọn + nút sửa tài khoản. */
  const accountCard = account ? (
    <div
      className="flex items-start gap-2 rounded-md border border-line bg-subtle px-2.5 py-2"
      data-testid="host-account-summary"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <AccountBadges account={account} keys={keys} />
        <p className="text-xs text-faint">
          {isRdp
            ? account.hasPassword
              ? t('Signs in with the account’s username and password.')
              : t('The Remote Desktop client asks for the password when you connect.')
            : account.keyId && account.hasPassword
              ? t('Tries the account’s SSH key first, then its password.')
              : account.keyId
                ? t('Signs in with the account’s SSH key.')
                : account.hasPassword
                  ? t('Signs in with the account’s password.')
                  : t(
                      'Tries your SSH agent and default keys (~/.ssh/id_*), then asks for a password.'
                    )}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon={<Pencil size={13} />}
        data-testid="host-account-edit"
        onClick={() => {
          setAccountDialog(account)
        }}
      >
        {t('Edit account')}
      </Button>
    </div>
  ) : (
    <Notice tone="warning">{t('The selected account no longer exists')}</Notice>
  )

  return (
    <Modal
      title={host ? t('Edit {name}', { name: host.label }) : t('New host')}
      onClose={onClose}
      width="max-w-xl"
      testId="host-form"
      footer={
        <>
          {host && (
            <Button
              variant="danger-ghost"
              className="mr-auto"
              data-testid="host-delete"
              onClick={() => {
                setConfirmDelete(true)
              }}
            >
              {t('Delete host')}
            </Button>
          )}
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            disabled={saving || portError !== null}
            data-testid="host-save"
            onClick={() => void submit()}
          >
            {t('Save')}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <Segmented
          value={protocol}
          onChange={(next) => {
            setProtocol(next)
            setError(null)
          }}
          testIdPrefix="host-protocol"
          options={[
            { value: 'ssh', label: 'SSH' },
            { value: 'telnet', label: 'Telnet' },
            { value: 'serial', label: t('Serial (COM)') },
            { value: 'rdp', label: 'RDP' }
          ]}
        />
        {protocol === 'telnet' && (
          <Notice tone="warning">
            {t(
              'Telnet is not encrypted — passwords typed in the session travel in clear text. Use it only for devices that have no SSH.'
            )}
          </Notice>
        )}
        {protocol === 'serial' ? (
          <SerialFields value={serial} onChange={setSerial} />
        ) : (
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <Field label={t('Hostname or IP')}>
              <Input
                autoFocus
                mono
                spellCheck={false}
                className="placeholder:font-sans"
                placeholder={t('e.g. {example}', { example: 'server.example.com' })}
                data-testid="host-hostname"
                aria-invalid={fieldError?.field === 'hostname' || undefined}
                value={hostname}
                onChange={(e) => {
                  setHostname(e.target.value)
                  if (fieldError?.field === 'hostname') setFieldError(null)
                }}
              />
              {fieldError?.field === 'hostname' && <FieldError>{fieldError.message}</FieldError>}
            </Field>
            <Field label={t('Port')}>
              <Input
                mono
                inputMode="numeric"
                data-testid="host-port"
                aria-invalid={portError !== null || undefined}
                placeholder={
                  protocol === 'telnet'
                    ? '23'
                    : isRdp
                      ? String(RDP_DEFAULT_PORT)
                      : inherited.port
                        ? String(inherited.port.value)
                        : '22'
                }
                title={
                  inherited.port && isSsh
                    ? t('From group {group}', { group: inherited.port.groupName })
                    : undefined
                }
                value={port}
                onChange={(e) => {
                  setPort(e.target.value)
                }}
              />
            </Field>
            {portError && (
              <div className="col-span-2 -mt-1.5">
                <FieldError testId="host-port-error">{portError}</FieldError>
              </div>
            )}
          </div>
        )}
        {isRdp && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Username')}>
              <Input
                mono
                spellCheck={false}
                className="placeholder:font-sans"
                placeholder={t('e.g. {example}', { example: 'Administrator' })}
                data-testid="host-username"
                aria-invalid={fieldError?.field === 'username' || undefined}
                disabled={usesAccount}
                title={usesAccount ? t('From the account') : undefined}
                value={usesAccount ? (account?.username ?? '') : username}
                onChange={(e) => {
                  setUsername(e.target.value)
                  if (fieldError?.field === 'username') setFieldError(null)
                }}
              />
              {fieldError?.field === 'username' && <FieldError>{fieldError.message}</FieldError>}
            </Field>
            <Field label={t('Domain')} hint={t('Optional — or type DOMAIN\\user as the username')}>
              <Input
                mono
                spellCheck={false}
                className="placeholder:font-sans"
                placeholder={t('e.g. {example}', { example: 'CORP' })}
                data-testid="rdp-domain"
                disabled={usesAccount && Boolean(account?.domain)}
                title={usesAccount && account?.domain ? t('From the account') : undefined}
                value={usesAccount && account?.domain ? account.domain : rdp.domain}
                onChange={(e) => {
                  setRdp({ ...rdp, domain: e.target.value })
                }}
              />
            </Field>
          </div>
        )}
        <div className={cx('grid gap-3', isSsh ? 'grid-cols-2' : 'grid-cols-1')}>
          {isSsh && (
            <Field
              label={t('Username')}
              hint={
                usesAccount
                  ? account && !account.username && inherited.username
                    ? t('Using “{value}”', { value: inherited.username.value }) +
                      from(inherited.username)
                    : t('From the account')
                  : inherited.username && !username
                    ? t('Using “{value}”', { value: inherited.username.value }) +
                      from(inherited.username)
                    : undefined
              }
            >
              <Input
                mono
                spellCheck={false}
                className="placeholder:font-sans"
                placeholder={
                  inherited.username
                    ? inherited.username.value
                    : t('e.g. {example}', { example: 'root' })
                }
                data-testid="host-username"
                aria-invalid={fieldError?.field === 'username' || undefined}
                disabled={usesAccount}
                value={usesAccount ? (account?.username ?? '') : username}
                onChange={(e) => {
                  setUsername(e.target.value)
                  if (fieldError?.field === 'username') setFieldError(null)
                }}
              />
              {fieldError?.field === 'username' && <FieldError>{fieldError.message}</FieldError>}
            </Field>
          )}
          <Field label={t('Label')}>
            <Input
              placeholder={
                protocol === 'serial'
                  ? serial.path || t('Defaults to the port name')
                  : hostname || t('Defaults to the hostname')
              }
              data-testid="host-label"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value)
              }}
            />
          </Field>
        </div>

        {isRdp && (
          <>
            <div className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
              {accountRow}
              {usesAccount ? (
                accountCard
              ) : (
                <>
                  <span className="text-xs font-medium text-muted">{t('Password')}</span>
                  <Segmented
                    value={rdpSave ? 'save' : 'ask'}
                    onChange={(v) => {
                      setRdpSave(v === 'save')
                    }}
                    testIdPrefix="rdp-auth"
                    options={[
                      { value: 'save', label: t('Save in vault') },
                      { value: 'ask', label: t('Ask each time') }
                    ]}
                  />
                  {rdpSave ? (
                    <PasswordInput
                      data-testid="host-password"
                      aria-label={t('Password')}
                      placeholder={
                        storedPassword ? savedPlaceholder : t('Password (stored encrypted)')
                      }
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value)
                      }}
                    />
                  ) : (
                    <p className="text-xs text-faint">
                      {t('The Remote Desktop client asks for the password when you connect.')}
                    </p>
                  )}
                </>
              )}
            </div>
            <RdpFields
              value={rdp}
              onChange={setRdp}
              hosts={hosts}
              selfId={host?.id ?? null}
              path={rdpPath}
              onPathChange={setRdpPath}
            />
          </>
        )}

        {isSsh && (
          <>
            <div className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
              <span className="text-xs font-medium text-muted">{t('Authentication')}</span>
              {accountRow}
              {usesAccount ? (
                accountCard
              ) : (
                <>
                  <Segmented
                    value={auth}
                    onChange={setAuth}
                    testIdPrefix="host-auth"
                    options={[
                      { value: 'auto', label: t('Automatic') },
                      { value: 'password', label: t('Password') },
                      { value: 'key', label: t('SSH key') }
                    ]}
                  />
                  {auth === 'auto' && (
                    <p className="text-xs text-faint">
                      {inherited.keyId
                        ? t(
                            'Tries the group key “{key}”{from}, your SSH agent and default keys, then asks for a password.',
                            {
                              key: keys.find((k) => k.id === inherited.keyId?.value)?.name ?? '?',
                              from: from(inherited.keyId)
                            }
                          )
                        : t(
                            'Tries your SSH agent and default keys (~/.ssh/id_*), then asks for a password.'
                          )}
                    </p>
                  )}
                  {auth === 'password' && (
                    <div className="flex flex-col gap-2">
                      <PasswordInput
                        data-testid="host-password"
                        aria-label={t('Password')}
                        disabled={clearPassword}
                        placeholder={
                          storedPassword ? savedPlaceholder : t('Password (stored encrypted)')
                        }
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value)
                        }}
                      />
                      {storedPassword && (
                        <Checkbox
                          label={t('Forget the saved password (ask every time)')}
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
                          {keys.length === 0 && (
                            <option value="">{t('No keys in the vault yet')}</option>
                          )}
                          {keys.map((k) => (
                            <option key={k.id} value={k.id}>
                              {k.name} ({k.type}
                              {k.encrypted ? `, ${t('passphrase')}` : ''})
                            </option>
                          ))}
                        </Select>
                        <Button icon={<KeyRound size={14} />} onClick={() => void importKey()}>
                          {t('Import…')}
                        </Button>
                      </div>
                      {keys.find((k) => k.id === keyId)?.encrypted && (
                        <PasswordInput
                          aria-label={t('Passphrase')}
                          data-testid="host-passphrase"
                          placeholder={
                            secretsFrom?.hasPassphrase && secretsFrom.keyId === keyId
                              ? savedPlaceholder
                              : t('Passphrase (leave empty to be asked when connecting)')
                          }
                          value={passphrase}
                          onChange={(e) => {
                            setPassphrase(e.target.value)
                          }}
                        />
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <span className="text-xs font-medium text-muted">{t('Jump hosts (ProxyJump)')}</span>
              {jumpHostIds.length > 0 ? (
                // Chuỗi chip theo thứ tự đi qua: bastion → gw → (host này).
                <ol
                  className="flex flex-wrap items-center gap-1"
                  data-testid="jump-list"
                  aria-label={t('Connection path')}
                >
                  {jumpHostIds.map((id, i) => (
                    <li key={id} className="flex items-center gap-1">
                      {i > 0 && <ArrowRight size={12} className="text-faint" aria-hidden />}
                      <span
                        className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-subtle pr-0.5 pl-2.5 text-xs text-fg"
                        data-testid="jump-chip"
                      >
                        {hostLabel(id)}
                        <IconButton
                          label={t('Remove {name}', { name: hostLabel(id) })}
                          size="sm"
                          className="size-5 rounded-full"
                          onClick={() => {
                            setJumpHostIds(jumpHostIds.filter((j) => j !== id))
                          }}
                        >
                          <X size={11} />
                        </IconButton>
                      </span>
                    </li>
                  ))}
                  <li className="flex items-center gap-1 text-xs text-faint">
                    <ArrowRight size={12} aria-hidden />
                    <span className="max-w-48 truncate">{label || hostname || t('this host')}</span>
                  </li>
                </ol>
              ) : host?.proxyJump ? (
                <p className="text-xs text-faint">
                  {t('Using ProxyJump from ~/.ssh/config: {value}', { value: host.proxyJump })}
                </p>
              ) : inherited.jumpHostIds ? (
                <div className="flex flex-col gap-1.5" data-testid="jump-inherited">
                  <p className={cx('text-xs', direct ? 'text-faint line-through' : 'text-muted')}>
                    {t('Through {hosts}', {
                      hosts: inherited.jumpHostIds.value.map(hostLabel).join(' → ')
                    })}
                    {from(inherited.jumpHostIds)}
                  </p>
                  <Checkbox
                    label={t("Connect directly (ignore the group's jump hosts)")}
                    data-testid="host-direct"
                    checked={direct}
                    onChange={(e) => {
                      setDirect(e.target.checked)
                    }}
                  />
                </div>
              ) : (
                <p className="text-xs text-faint">{t('Direct connection.')}</p>
              )}
              {jumpHostIds.length < MAX_JUMPS && jumpChoices.length > 0 && (
                <Select
                  value=""
                  data-testid="jump-add"
                  onChange={(e) => {
                    if (e.target.value) setJumpHostIds([...jumpHostIds, e.target.value])
                  }}
                >
                  <option value="">{t('Add a jump host…')}</option>
                  {jumpChoices.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label} ({h.hostname})
                    </option>
                  ))}
                </Select>
              )}
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Group')}>
            <GroupSelect
              testId="host-group"
              value={groupId}
              onChange={setGroupId}
              noneLabel={t('No group')}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">{t('Tags')}</span>
            <TagInput
              value={tags}
              onChange={setTags}
              suggestions={knownTags}
              placeholder={t('e.g. {example}', { example: 'prod, web' })}
              testId="host-tags"
            />
            <span className="text-xs text-faint">{t('Enter or comma to add')}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted">{t('Color')}</span>
          <ColorPicker
            value={color}
            onChange={setColor}
            noneLabel={
              inherited.color
                ? t('Use the group color ({color})', { color: colorName(inherited.color.value) })
                : t('No color')
            }
            testIdPrefix="host-color"
          />
          {!color && inherited.color && (
            <span className="text-xs text-muted">
              {t('Using {value}', { value: colorName(inherited.color.value) })}
              {from(inherited.color)}
            </span>
          )}
        </div>

        {!isRdp && (
          <details
            className="group rounded-lg border border-line"
            open={advancedOpen}
            onToggle={(e) => {
              setAdvancedOpen(e.currentTarget.open)
            }}
          >
            <summary
              className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13px] font-medium text-fg select-none"
              data-testid="host-advanced"
            >
              <ChevronRight
                size={14}
                className="text-faint transition-transform group-open:rotate-90"
              />
              {t('Advanced')}
              <span className="min-w-0 truncate text-xs font-normal text-faint">
                {legacy || tmux || mode === 'system' || encoding !== 'utf-8'
                  ? [
                      isSsh && tmux && mode !== 'system' && 'tmux',
                      encoding !== 'utf-8' && encoding,
                      isSsh && legacy && t('legacy algorithms'),
                      isSsh && mode === 'system' && t('system ssh')
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : isSsh
                    ? t('tmux, character encoding, legacy algorithms, system ssh')
                    : t('Character encoding')}
              </span>
            </summary>
            <div className="flex flex-col gap-3 border-t border-line px-3 py-3">
              <Field
                label={t('Character encoding')}
                hint={t(
                  'For old devices whose output looks garbled. Applies to what the server prints; text you type is sent as UTF-8.'
                )}
              >
                <Select
                  value={encoding}
                  data-testid="host-encoding"
                  onChange={(e) => {
                    setEncoding(e.target.value as EncodingId)
                  }}
                >
                  {ENCODINGS.map((enc) => (
                    <option key={enc.id} value={enc.id}>
                      {enc.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {isSsh && (
                <>
                  <Checkbox
                    data-testid="host-tmux"
                    checked={tmux && mode !== 'system'}
                    disabled={mode === 'system'}
                    onChange={(e) => {
                      setTmux(e.target.checked)
                    }}
                    label={t('Keep sessions alive with tmux')}
                    description={t(
                      'If the server has tmux, each tab runs inside its own tmux session (shellhouse-1, -2…). When Wi-Fi drops or the laptop sleeps, reconnecting brings you back to the same prompt with your programs still running. Type exit to end it.'
                    )}
                  />
                  <Checkbox
                    data-testid="host-legacy"
                    checked={legacy}
                    onChange={(e) => {
                      setLegacy(e.target.checked)
                    }}
                    label={t('Allow legacy algorithms')}
                    description={t(
                      'For old switches, routers and servers that only offer ssh-rsa (SHA-1), SHA-1 key exchange or CBC ciphers. Weaker security — enable only for devices that need it.'
                    )}
                  />
                  <Checkbox
                    data-testid="host-mode-system"
                    checked={mode === 'system'}
                    onChange={(e) => {
                      setMode(e.target.checked ? 'system' : 'builtin')
                    }}
                    label={t('Compatibility mode: use the system ssh command')}
                    description={t(
                      'For GSSAPI/Kerberos, FIDO hardware keys or complex ssh_config setups. OpenSSH asks for passwords and host keys in the terminal. SFTP, port forwarding and passwords/keys stored in the vault are not available.'
                    )}
                  />
                </>
              )}
            </div>
          </details>
        )}

        {host?.keyFile && (
          <p className="text-xs text-faint">
            {t('IdentityFile from ~/.ssh/config: {value}', { value: host.keyFile })}
          </p>
        )}
        {error && (
          <Notice tone="danger" testId="host-error">
            {error}
          </Notice>
        )}
        <button type="submit" hidden />
      </form>
      {accountDialog === 'manage' && (
        <AccountsDialog
          onClose={() => {
            setAccountDialog(null)
          }}
        />
      )}
      {accountDialog !== null && accountDialog !== 'manage' && (
        <AccountEditor
          account={accountDialog === 'new' ? null : accountDialog}
          initial={{
            name: suggestAccountName(accounts, username.trim(), ''),
            username: usesAccount ? '' : username.trim()
          }}
          onClose={() => {
            setAccountDialog(null)
          }}
          onSaved={(id) => {
            if (accountDialog === 'new') chooseAccount(id)
          }}
        />
      )}
      {confirmDelete && host && (
        <DeleteHostsDialog
          hosts={[host]}
          onDone={onClose}
          onClose={() => {
            setConfirmDelete(false)
          }}
        />
      )}
    </Modal>
  )
}
