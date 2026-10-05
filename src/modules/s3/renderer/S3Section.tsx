import { useEffect, useState } from 'react'
import { ChevronRight, Cloud, Database, Pencil, PinOff, Plus, Trash2 } from 'lucide-react'
import { endpointWarning, pinLabel, S3AccountInput, type S3AccountSummary } from '../shared/ops'
import {
  Button,
  Checkbox,
  cx,
  Field,
  IconButton,
  Input,
  Modal,
  Notice
} from '../../../renderer/src/components/ui'
import { useContextMenu } from '../../../renderer/src/components/ContextMenu'
import { useS3 } from './store'
import { openS3, s3Api } from './api'
import {
  confirmAction,
  environmentMenu,
  EnvironmentPicker,
  setSourceEnvironment,
  t,
  useEnvironments,
  useSourceEnvironment,
  useSourceEnvironmentMap
} from '../../registry/renderer-kit'
import { EnvLabel } from '../../../renderer/src/ds'

/** Mục "S3" ở thanh bên: tài khoản S3, bấm đúp để mở trình quản lý. */
export function S3Section(): React.JSX.Element {
  const accounts = useS3((s) => s.accounts)
  const [open, setOpen] = useState(true)
  const [editing, setEditing] = useState<S3AccountSummary | 'new' | null>(null)
  const { menu, open: openMenu } = useContextMenu()
  const environments = useEnvironments()
  const sourceEnvs = useSourceEnvironmentMap()

  useEffect(() => {
    void useS3.getState().reload()
  }, [])

  return (
    <div data-testid="s3-section">
      <div className="flex h-7 items-center gap-1.5 px-1 text-xs font-medium text-faint">
        <button
          type="button"
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 hover:text-muted"
          onClick={() => {
            setOpen(!open)
          }}
        >
          <ChevronRight
            size={13}
            className={cx('transition-transform duration-150', open && 'rotate-90')}
          />
          <span className="flex-1 text-left">{t('Accounts')}</span>
        </button>
        <IconButton
          label={t('Add S3 account')}
          size="sm"
          data-testid="s3-add-account"
          onClick={() => {
            setEditing('new')
          }}
        >
          <Plus size={13} />
        </IconButton>
      </div>
      {open && accounts.length === 0 && (
        <p className="px-2 py-1 text-xs text-faint">
          {t('Add an AWS S3, MinIO, Wasabi or Cloudflare R2 account to browse buckets.')}
        </p>
      )}
      {open &&
        accounts.map((a) => (
          <div key={a.id}>
            <div
              role="button"
              tabIndex={0}
              data-testid="s3-account"
              data-name={a.name}
              className="group flex h-7 cursor-default items-center gap-2 rounded-ds-md px-2 outline-none hover:bg-ds-hover focus-visible:shadow-ds-focus"
              title={`${a.endpoint ? new URL(a.endpoint).host : `AWS ${a.region || 'us-east-1'}`} · ${t('Double-click to open')}`}
              onDoubleClick={() => openS3(a)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') openS3(a)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(e, [
                  {
                    id: 's3-open',
                    label: t('Open'),
                    icon: <Cloud size={14} />,
                    onSelect: () => openS3(a)
                  },
                  {
                    id: 's3-edit',
                    label: t('Edit…'),
                    icon: <Pencil size={14} />,
                    onSelect: () => {
                      setEditing(a)
                    }
                  },
                  'separator',
                  ...environmentMenu(
                    environments,
                    sourceEnvs[`s3:${a.id}`] ?? null,
                    (id) => void setSourceEnvironment('s3', a.id, id)
                  ),
                  'separator',
                  {
                    id: 's3-delete',
                    label: t('Delete account'),
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onSelect: () => {
                      void confirmAction({
                        title: t('Delete the S3 account “{name}”?', { name: a.name }),
                        message: t('Buckets and objects are not touched.'),
                        confirmLabel: t('Delete'),
                        danger: true
                      }).then((ok) => {
                        if (ok) void s3Api.delete(a.id)
                      })
                    }
                  }
                ])
              }}
            >
              <Cloud size={14} strokeWidth={1.6} className="shrink-0 text-ds-fg-3" />
              <span className="min-w-0 flex-1 truncate text-ds-base text-ds-fg-2 group-hover:text-ds-fg">
                {a.name}
              </span>
              <AccountEnv id={a.id} />
            </div>
            {/* Mục ghim: lối tắt đã lưu (không giữ kết nối) — bấm là mở tab ngay tại đó. */}
            {a.pins.map((pin) => (
              <button
                key={`${pin.bucket}/${pin.prefix}`}
                type="button"
                data-testid="s3-pin"
                data-name={pinLabel(pin)}
                title={`s3://${pin.bucket}/${pin.prefix}`}
                className="flex h-7 w-full items-center gap-2 rounded-ds-md pr-2 pl-7 text-left text-ds-base text-ds-fg-2 hover:bg-ds-hover hover:text-ds-fg"
                onClick={() => openS3(a, pin)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openMenu(e, [
                    {
                      id: 's3-pin-open',
                      label: t('Open'),
                      icon: <Cloud size={14} />,
                      onSelect: () => openS3(a, pin)
                    },
                    {
                      id: 's3-pin-remove',
                      label: t('Unpin'),
                      icon: <PinOff size={14} />,
                      onSelect: () => void s3Api.pin(a.id, pin, false)
                    }
                  ])
                }}
              >
                <Database size={14} strokeWidth={1.6} className="shrink-0 text-ds-fg-3" />
                <span className="min-w-0 flex-1 truncate">{pinLabel(pin)}</span>
              </button>
            ))}
          </div>
        ))}
      {menu}
      {editing && (
        <S3AccountForm
          account={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

/** Câu lỗi kiểm tra form (zod, tiếng Anh ở shared/ops) → theo ngôn ngữ giao diện. */
function issueText(message: string | undefined): string {
  return message ? t(message) : t('Invalid input')
}

function S3AccountForm({
  account,
  onClose
}: {
  account: S3AccountSummary | null
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState(account?.name ?? '')
  const [endpoint, setEndpoint] = useState(account?.endpoint ?? '')
  const [region, setRegion] = useState(account?.region ?? '')
  const [accessKeyId, setAccessKeyId] = useState(account?.accessKeyId ?? '')
  const [secret, setSecret] = useState('')
  const [pathStyle, setPathStyle] = useState(account?.forcePathStyle ?? false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState<{ ok: boolean; message: string } | null>(null)
  // Môi trường chọn ngay khi thêm / sửa tài khoản (Settings › Environments).
  const current = useAccountEnvironment(account?.id ?? '')
  const [environment, setEnvironment] = useState<string | null>(current?.id ?? null)
  const warning = endpointWarning(endpoint)

  const parse = () =>
    S3AccountInput.safeParse({
      ...(account ? { id: account.id } : {}),
      name: name || (endpoint ? new URL(endpoint).host : 'AWS S3'),
      endpoint,
      region,
      accessKeyId,
      ...(secret || !account ? { secretAccessKey: secret } : {}),
      forcePathStyle: pathStyle
    })

  const save = async (): Promise<void> => {
    const parsed = parse()
    if (!parsed.success) {
      setError(issueText(parsed.error.issues[0]?.message))
      return
    }
    const result = await s3Api.save(parsed.data)
    if (result.ok) {
      if (environment !== (current?.id ?? null))
        await setSourceEnvironment('s3', result.id, environment)
      onClose()
    } else setError(t(result.message))
  }

  /** Thử kết nối bằng thông tin đang nhập (không lưu). */
  const test = async (): Promise<void> => {
    const parsed = parse()
    setTested(null)
    if (!parsed.success) {
      setError(issueText(parsed.error.issues[0]?.message))
      return
    }
    setError(null)
    setTesting(true)
    try {
      setTested(await s3Api.test(parsed.data))
    } catch (e) {
      setTested({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      title={account ? t('Edit {name}', { name: account.name }) : t('New S3 account')}
      description={t('The secret key is stored encrypted in the vault.')}
      onClose={onClose}
      width="max-w-md"
      testId="s3-account-form"
      footer={
        <>
          <Button
            className="mr-auto"
            disabled={testing}
            data-testid="s3-account-test"
            onClick={() => void test()}
          >
            {testing ? t('Testing…') : t('Test connection')}
          </Button>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" data-testid="s3-account-save" onClick={() => void save()}>
            {t('Save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Field label={t('Name')}>
          <Input
            autoFocus
            placeholder={t('Production backups')}
            data-testid="s3-account-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
        </Field>
        <Field
          label={t('Endpoint')}
          hint={t(
            'Empty for AWS. MinIO: http://host:9000 · R2: https://<account>.r2.cloudflarestorage.com'
          )}
        >
          <Input
            mono
            spellCheck={false}
            placeholder="https://s3.example.com"
            data-testid="s3-account-endpoint"
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value.trim())
            }}
          />
        </Field>
        {warning && <Notice tone="warning">{warning}</Notice>}
        <Field label={t('Region')} hint={t('Empty = us-east-1 (R2: auto)')}>
          <Input
            mono
            spellCheck={false}
            placeholder="us-east-1"
            value={region}
            onChange={(e) => {
              setRegion(e.target.value.trim())
            }}
          />
        </Field>
        <Field label={t('Access key ID')}>
          <Input
            mono
            spellCheck={false}
            autoComplete="off"
            data-testid="s3-account-key"
            value={accessKeyId}
            onChange={(e) => {
              setAccessKeyId(e.target.value.trim())
            }}
          />
        </Field>
        <Field label={t('Secret access key')}>
          <Input
            mono
            type="password"
            autoComplete="off"
            placeholder={account?.hasSecret ? t('Saved — leave empty to keep it') : ''}
            data-testid="s3-account-secret"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value)
            }}
          />
        </Field>
        <Checkbox
          label={t('Path-style URLs')}
          description={t('Needed by MinIO, Ceph and most self-hosted S3 servers.')}
          checked={pathStyle}
          data-testid="s3-account-path-style"
          onChange={(e) => {
            setPathStyle(e.target.checked)
          }}
        />
        {error && (
          <Notice tone="danger" testId="s3-account-error">
            {error}
          </Notice>
        )}
        {tested && !error && (
          <Notice tone={tested.ok ? 'success' : 'danger'} testId="s3-account-test-result">
            {tested.message}
          </Notice>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">{t('Environment')}</span>
          <EnvironmentPicker
            value={environment}
            onChange={setEnvironment}
            testIdPrefix="s3-account-env"
          />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

/** Môi trường của tài khoản S3 (Settings › Environments). */
export function useAccountEnvironment(id: string): ReturnType<typeof useSourceEnvironment> {
  return useSourceEnvironment('s3', id)
}

function AccountEnv({ id }: { id: string }): React.JSX.Element | null {
  const env = useAccountEnvironment(id)
  return env ? <EnvLabel env={env} /> : null
}
