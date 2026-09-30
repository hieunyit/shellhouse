import { useEffect, useState } from 'react'
import { ChevronRight, Cloud, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react'
import { pinLabel, S3AccountInput, type S3AccountSummary } from '@shared/s3'
import { Button, Checkbox, cx, Field, IconButton, Input, Modal, Notice } from '../components/ui'
import { useContextMenu } from '../components/ContextMenu'
import { useS3 } from '../stores/s3'
import { useTabs } from '../stores/tabs'

/** Mục "S3" ở thanh bên: tài khoản S3, bấm đúp để mở trình quản lý. */
export function S3Section(): React.JSX.Element {
  const accounts = useS3((s) => s.accounts)
  const [open, setOpen] = useState(true)
  const [editing, setEditing] = useState<S3AccountSummary | 'new' | null>(null)
  const { menu, open: openMenu } = useContextMenu()

  useEffect(() => {
    void useS3.getState().reload()
  }, [])

  return (
    <div className="mt-2 border-t border-line pt-2" data-testid="s3-section">
      <div className="flex h-7 items-center gap-1.5 px-1 text-[11px] font-semibold tracking-wider text-faint uppercase">
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
          <Cloud size={12} />
          <span className="flex-1 text-left">S3 storage</span>
        </button>
        <IconButton
          label="Add S3 account"
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
          Add an AWS S3, MinIO, Wasabi or Cloudflare R2 account to browse buckets.
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
              className="group flex h-10 cursor-default items-center gap-2.5 rounded-md px-2 hover:bg-hover"
              title="Double-click to open"
              onDoubleClick={() => useTabs.getState().addS3(a)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') useTabs.getState().addS3(a)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(e, [
                  {
                    id: 's3-open',
                    label: 'Open',
                    icon: <Cloud size={14} />,
                    onSelect: () => useTabs.getState().addS3(a)
                  },
                  {
                    id: 's3-edit',
                    label: 'Edit…',
                    icon: <Pencil size={14} />,
                    onSelect: () => {
                      setEditing(a)
                    }
                  },
                  'separator',
                  {
                    id: 's3-delete',
                    label: 'Delete account',
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onSelect: () => {
                      if (
                        window.confirm(
                          `Delete the S3 account “${a.name}”? Buckets are not touched.`
                        )
                      )
                        void window.shellhouse.deleteS3Account(a.id)
                    }
                  }
                ])
              }}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-subtle text-muted">
                <Cloud size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-fg">{a.name}</span>
                <span className="block truncate font-mono text-xs text-faint">
                  {a.endpoint ? new URL(a.endpoint).host : `AWS ${a.region || 'us-east-1'}`}
                </span>
              </span>
            </div>
            {/* Mục ghim: lối tắt đã lưu (không giữ kết nối) — bấm là mở tab ngay tại đó. */}
            {a.pins.map((pin) => (
              <button
                key={`${pin.bucket}/${pin.prefix}`}
                type="button"
                data-testid="s3-pin"
                data-name={pinLabel(pin)}
                title={`s3://${pin.bucket}/${pin.prefix}`}
                className="flex h-7 w-full items-center gap-2 rounded-md pr-2 pl-9 text-left text-[12.5px] text-muted hover:bg-hover hover:text-fg"
                onClick={() => useTabs.getState().addS3(a, pin)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openMenu(e, [
                    {
                      id: 's3-pin-open',
                      label: 'Open',
                      icon: <Cloud size={14} />,
                      onSelect: () => useTabs.getState().addS3(a, pin)
                    },
                    {
                      id: 's3-pin-remove',
                      label: 'Unpin',
                      icon: <PinOff size={14} />,
                      onSelect: () => void window.shellhouse.pinS3Location(a.id, pin, false)
                    }
                  ])
                }}
              >
                <Pin size={12} className="shrink-0 text-accent" />
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

  const save = async (): Promise<void> => {
    const parsed = S3AccountInput.safeParse({
      ...(account ? { id: account.id } : {}),
      name: name || (endpoint ? new URL(endpoint).host : 'AWS S3'),
      endpoint,
      region,
      accessKeyId,
      ...(secret || !account ? { secretAccessKey: secret } : {}),
      forcePathStyle: pathStyle
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid input')
      return
    }
    const result = await window.shellhouse.saveS3Account(parsed.data)
    if (result.ok) onClose()
    else setError(result.message)
  }

  return (
    <Modal
      title={account ? `Edit ${account.name}` : 'New S3 account'}
      description="The secret key is stored encrypted in the vault."
      onClose={onClose}
      width="max-w-md"
      testId="s3-account-form"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="s3-account-save" onClick={() => void save()}>
            Save
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
        <Field label="Name">
          <Input
            autoFocus
            placeholder="Production backups"
            data-testid="s3-account-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
        </Field>
        <Field
          label="Endpoint"
          hint="Empty for AWS. MinIO: http://host:9000 · R2: https://<account>.r2.cloudflarestorage.com"
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
        <Field label="Region" hint="Empty = us-east-1 (R2: auto)">
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
        <Field label="Access key ID">
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
        <Field label="Secret access key">
          <Input
            mono
            type="password"
            autoComplete="off"
            placeholder={account?.hasSecret ? 'Saved — leave empty to keep it' : ''}
            data-testid="s3-account-secret"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value)
            }}
          />
        </Field>
        <Checkbox
          label="Path-style URLs"
          description="Needed by MinIO, Ceph and most self-hosted S3 servers."
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
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
