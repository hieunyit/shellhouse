import { useState } from 'react'
import { KeyRound, Plus, X } from 'lucide-react'
import {
  Button,
  Checkbox,
  cx,
  Field,
  Input,
  Modal,
  Notice,
  Select
} from '../../../renderer/src/components/ui'
import { formatBytes, t, tn } from '../../registry/renderer-kit'
import { registryFor, registryOf, type DockerRegistry } from '../shared/ipc'
import { type ContainerRow, type PruneResult, type PruneTarget, type RunSpec } from '../shared/ops'
import { trySplitShellWords } from '../shared/shell-words'

/**
 * Hộp xác nhận (thay `window.confirm`): nói rõ hậu quả, nút nguy hiểm màu đỏ; tuỳ chọn một ô đánh
 * dấu (vd. "xoá cả volume ẩn danh").
 */
export interface ConfirmRequest {
  title: string
  message: React.ReactNode
  confirmLabel: string
  danger?: boolean
  option?: { label: string; initial?: boolean }
  onConfirm: (option: boolean) => void
}

export function ConfirmDialog({
  request,
  onClose
}: {
  request: ConfirmRequest
  onClose: () => void
}): React.JSX.Element {
  const [option, setOption] = useState(request.option?.initial === true)
  return (
    <Modal
      title={request.title}
      onClose={onClose}
      testId="docker-confirm"
      footer={
        <>
          {/* Thao tác nguy hiểm: focus ở Cancel — Enter vội không xoá nhầm. */}
          <Button variant="ghost" autoFocus={request.danger === true} onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            autoFocus={request.danger !== true}
            variant={request.danger ? 'danger' : 'primary'}
            data-testid="docker-confirm-ok"
            onClick={() => {
              onClose()
              request.onConfirm(option)
            }}
          >
            {request.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] text-muted">
        <div>{request.message}</div>
        {request.option && (
          <Checkbox
            label={request.option.label}
            checked={option}
            data-testid="docker-confirm-option"
            onChange={(e) => {
              setOption(e.target.checked)
            }}
          />
        )}
      </div>
    </Modal>
  )
}

/** Tiêu đề hộp thoại dọn dẹp theo loại. */
function pruneTitle(what: PruneTarget, all: boolean): string {
  switch (what) {
    case 'containers':
      return t('Remove stopped containers')
    case 'images':
      return all ? t('Remove unused images') : t('Remove dangling images')
    case 'volumes':
      return all ? t('Remove unused volumes') : t('Remove unused anonymous volumes')
    case 'networks':
      return t('Remove unused networks')
    case 'buildCache':
      return t('Clear the build cache')
  }
}

/**
 * Xem trước rồi mới dọn (container dừng, image dangling / không dùng, volume / network không dùng,
 * build cache).
 */
export function PruneDialog({
  what,
  all,
  preview,
  error,
  onAllChange,
  onClose,
  onConfirm
}: {
  what: PruneTarget
  /** Volume: cả volume có tên; image: mọi image không dùng (mặc định chỉ dangling). */
  all: boolean
  preview: PruneResult | null
  error: string | null
  onAllChange: (all: boolean) => void
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const count = preview ? (preview.count ?? preview.items.length) : 0
  const empty = preview !== null && count === 0 && preview.reclaimed === 0
  return (
    <Modal
      title={pruneTitle(what, all)}
      onClose={onClose}
      testId="docker-prune-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="danger"
            data-testid="docker-prune-confirm"
            disabled={!preview || empty}
            onClick={onConfirm}
          >
            {preview && count > 0 ? t('Remove {n}', { n: count }) : t('Remove')}
          </Button>
        </>
      }
    >
      {what === 'volumes' && (
        <div className="mb-3 flex flex-col gap-2">
          <Checkbox
            label={t('Include named volumes')}
            checked={all}
            data-testid="docker-prune-all"
            onChange={(e) => {
              onAllChange(e.target.checked)
            }}
          />
          {all ? (
            <Notice tone="danger" testId="docker-prune-all-warning">
              {t(
                'Named volumes usually hold data you want to keep (databases, uploads). Every named volume no container uses right now — including ones of stopped Compose projects — is deleted for good.'
              )}
            </Notice>
          ) : (
            <p className="text-xs text-faint">
              {t('Only anonymous volumes (created without a name) that no container uses.')}
            </p>
          )}
        </div>
      )}
      {what === 'images' && (
        <div className="mb-3 flex flex-col gap-2">
          <Checkbox
            label={t('Include every unused image, not only dangling ones')}
            checked={all}
            data-testid="docker-prune-all"
            onChange={(e) => {
              onAllChange(e.target.checked)
            }}
          />
          <p className="text-xs text-faint">
            {all
              ? t(
                  'Every image no container uses (running or stopped) is removed — you will have to pull or build it again.'
                )
              : t('Only dangling images: untagged layers left behind by builds and pulls.')}
          </p>
        </div>
      )}
      {what === 'buildCache' && (
        <p className="mb-3 text-xs text-faint">
          {t(
            'Removes build cache that no running build uses. The next builds take longer until the cache is warm again.'
          )}
        </p>
      )}
      {error ? (
        <Notice tone="danger">{error}</Notice>
      ) : !preview ? (
        <p className="text-xs text-faint">{t('Checking what would be removed…')}</p>
      ) : empty ? (
        <p className="text-[13px] text-muted" data-testid="docker-prune-empty">
          {t('Nothing to remove.')}
        </p>
      ) : (
        <div className="flex flex-col gap-2 text-[13px]">
          <p className="text-muted">
            {preview.reclaimed
              ? tn(
                  count,
                  'This will be removed (about {size}):',
                  'These {n} will be removed (about {size}):',
                  { size: formatBytes(preview.reclaimed) }
                )
              : tn(count, 'This will be removed:', 'These {n} will be removed:')}
          </p>
          {preview.items.length > 0 && (
            <ul
              className="max-h-60 overflow-auto rounded-md bg-subtle p-2 font-mono text-xs text-fg"
              data-testid="docker-prune-list"
            >
              {preview.items.map((i) => (
                <li key={i} className="truncate" title={i}>
                  {i}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  )
}

export interface TransferProgress {
  status: string
  progress: number | null
  done: boolean
  error?: string
}

/**
 * Kéo / đẩy image. Registry đã lưu khớp máy chủ của image được chọn sẵn (đổi được, hoặc "không
 * đăng nhập" cho image công khai).
 */
export function ImageTransferDialog({
  mode,
  initialRef,
  refs,
  registries,
  progress,
  onClose,
  onStart,
  onManageRegistries
}: {
  mode: 'pull' | 'push'
  initialRef: string
  /** Push: các tag của image để chọn nhanh. */
  refs?: readonly string[]
  registries: readonly DockerRegistry[]
  progress: TransferProgress | null
  onClose: () => void
  onStart: (ref: string, registry: string | null) => void
  onManageRegistries: () => void
}): React.JSX.Element {
  const [ref, setRef] = useState(initialRef)
  /** undefined = tự chọn theo máy chủ của image. */
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  const clean = ref.trim()
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(clean)
  const host = valid ? registryOf(clean) : null
  const matching = host ? registries.filter((r) => registryFor(clean, [r])) : []
  const auto = valid ? registryFor(clean, registries) : null
  const registryId = picked === undefined ? (auto?.id ?? null) : picked
  // Registry đã chọn không khớp máy chủ mới gõ → coi như tự chọn lại.
  const effective =
    registryId && matching.some((r) => r.id === registryId) ? registryId : (auto?.id ?? null)
  const running = progress !== null && !progress.done
  const start = (): void => {
    if (valid && progress === null) onStart(clean, effective)
  }
  return (
    <Modal
      title={mode === 'pull' ? t('Pull an image') : t('Push an image')}
      description={
        mode === 'push'
          ? t(
              'Uploads the image to its registry. Tag it with the registry address first, like ghcr.io/org/app:1.0.'
            )
          : undefined
      }
      onClose={onClose}
      testId={mode === 'pull' ? 'docker-pull-dialog' : 'docker-push-dialog'}
      footer={
        progress?.done ? (
          <Button variant="primary" onClick={onClose}>
            {t('Close')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {running ? t('Stop') : t('Cancel')}
            </Button>
            <Button
              variant="primary"
              data-testid={mode === 'pull' ? 'docker-pull-submit' : 'docker-push-submit'}
              disabled={!valid || progress !== null}
              onClick={start}
            >
              {mode === 'pull' ? t('Pull') : t('Push')}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('Image')}>
          {refs && refs.length > 1 ? (
            <Select
              value={ref}
              data-testid="docker-transfer-ref"
              disabled={progress !== null}
              onChange={(e) => {
                setRef(e.target.value)
              }}
            >
              {refs.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              autoFocus
              mono
              placeholder={t('nginx:1.27 or ghcr.io/org/app:tag')}
              data-testid={mode === 'pull' ? 'docker-pull-ref' : 'docker-transfer-ref'}
              value={ref}
              disabled={progress !== null}
              onChange={(e) => {
                setRef(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') start()
              }}
            />
          )}
        </Field>
        <Field
          label={t('Sign in with')}
          hint={
            host
              ? matching.length === 0
                ? t('No saved login for {host}. Public images need none.', { host })
                : t('Registry: {host}', { host })
              : undefined
          }
        >
          <div className="flex gap-2">
            <Select
              className="flex-1"
              value={effective ?? ''}
              data-testid="docker-transfer-registry"
              disabled={progress !== null}
              onChange={(e) => {
                setPicked(e.target.value || null)
              }}
            >
              <option value="">{t('No login (public image)')}</option>
              {matching.map((r) => (
                <option key={r.id} value={r.id}>
                  {`${r.name} (${r.username})`}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              icon={<KeyRound size={13} />}
              data-testid="docker-transfer-registries"
              onClick={onManageRegistries}
            >
              {t('Registries…')}
            </Button>
          </div>
        </Field>
        {progress && (
          <div
            className="flex flex-col gap-1.5"
            data-testid={mode === 'pull' ? 'docker-pull-progress' : 'docker-push-progress'}
          >
            {progress.progress !== null && !progress.error && (
              <div
                className="h-1.5 overflow-hidden rounded-full bg-subtle"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress.progress * 100)}
              >
                <div
                  className="h-full bg-accent-solid transition-[width]"
                  style={{ width: `${Math.round(progress.progress * 100)}%` }}
                />
              </div>
            )}
            <p
              className={cx('text-xs break-words', progress.error ? 'text-danger' : 'text-muted')}
              role={progress.error ? 'alert' : 'status'}
            >
              {progress.status}
            </p>
          </div>
        )}
      </div>
    </Modal>
  )
}

export function RenameDialog({
  container,
  onClose,
  onRename
}: {
  container: ContainerRow
  onClose: () => void
  onRename: (name: string) => void
}): React.JSX.Element {
  const [name, setName] = useState(container.name)
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) && name !== container.name
  return (
    <Modal
      title={t('Rename {name}', { name: container.name })}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="docker-rename-submit"
            onClick={() => {
              onRename(name)
            }}
          >
            {t('Rename')}
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        mono
        aria-label={t('New name')}
        value={name}
        data-testid="docker-rename-input"
        onChange={(e) => {
          setName(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid) onRename(name)
        }}
      />
      {name !== container.name && name !== '' && !valid && (
        <p className="mt-1 text-xs text-warning">
          {t('Names use letters, digits, "_", "." and "-"')}
        </p>
      )}
    </Modal>
  )
}

export function InspectDialog({
  title,
  data,
  onClose
}: {
  title: string
  data: unknown
  onClose: () => void
}): React.JSX.Element {
  const text = JSON.stringify(data, null, 2)
  return (
    <Modal
      title={t('Inspect {name}', { name: title })}
      width="max-w-3xl"
      onClose={onClose}
      testId="docker-inspect"
      footer={
        <>
          <Button variant="ghost" onClick={() => void window.shellhouse.writeClipboard(text)}>
            {t('Copy')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('Close')}
          </Button>
        </>
      }
    >
      <pre className="max-h-[60vh] overflow-auto rounded-md bg-subtle p-3 font-mono text-xs text-fg select-text">
        {text}
      </pre>
    </Modal>
  )
}

/** "Open shell…": chọn shell / lệnh / user (`docker exec -it`). */
export function ExecDialog({
  container,
  onClose,
  onOpen
}: {
  container: ContainerRow
  onClose: () => void
  onOpen: (command: string[] | undefined, user: string | undefined) => void
}): React.JSX.Element {
  const [shell, setShell] = useState('auto')
  const [custom, setCustom] = useState('')
  const [user, setUser] = useState('')
  // Lệnh tự gõ tách như shell: `sh -c "echo a b"` → 3 đối số (không phải 4).
  const parsed = shell === 'custom' ? trySplitShellWords(custom.trim()) : null
  const command = shell === 'auto' ? undefined : shell === 'custom' ? (parsed ?? []) : [shell]
  const valid = shell !== 'custom' || (command?.length ?? 0) > 0
  return (
    <Modal
      title={t('Open a shell in {name}', { name: container.name })}
      onClose={onClose}
      testId="docker-exec-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="docker-exec-open"
            onClick={() => {
              onOpen(command, user.trim() || undefined)
            }}
          >
            {t('Open')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Shell')}>
          <Select
            value={shell}
            data-testid="docker-exec-shell"
            onChange={(e) => {
              setShell(e.target.value)
            }}
          >
            <option value="auto">{t('bash if available, else sh')}</option>
            <option value="bash">bash</option>
            <option value="sh">sh</option>
            <option value="ash">ash</option>
            <option value="zsh">zsh</option>
            <option value="custom">{t('Custom command…')}</option>
          </Select>
        </Field>
        <Field label={t('User')} hint={t('Empty = the image default')}>
          <Input
            mono
            placeholder="root"
            value={user}
            onChange={(e) => {
              setUser(e.target.value)
            }}
          />
        </Field>
        {shell === 'custom' && (
          <div className="col-span-2">
            <Field label={t('Command')}>
              <Input
                mono
                autoFocus
                placeholder="psql -U postgres"
                data-testid="docker-exec-command"
                value={custom}
                onChange={(e) => {
                  setCustom(e.target.value)
                }}
              />
            </Field>
            {parsed === null && (
              <p className="mt-1 text-xs text-warning">{t('A quote is not closed.')}</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

type PortRow = { host: string; container: string; protocol: 'tcp' | 'udp' }
type VolumeRow = { source: string; target: string; readOnly: boolean }

/** Chạy container mới (như `docker run -d`). */
export function RunDialog({
  image,
  onClose,
  onRun
}: {
  image: string
  onClose: () => void
  onRun: (spec: RunSpec) => Promise<void>
}): React.JSX.Element {
  const [img, setImg] = useState(image)
  const [name, setName] = useState('')
  const [ports, setPorts] = useState<PortRow[]>([])
  const [env, setEnv] = useState('')
  const [volumes, setVolumes] = useState<VolumeRow[]>([])
  const [restart, setRestart] = useState<RunSpec['restart']>('unless-stopped')
  const [command, setCommand] = useState('')
  const [autoRemove, setAutoRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const envLines = env
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const commandWords = trySplitShellWords(command.trim())
  const problems = [
    !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(img.trim()) && t('Enter an image like nginx:1.27'),
    name &&
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) &&
      t('Names use letters, digits, "_", "." and "-"'),
    envLines.some((l) => !/^[^=\s]+=/.test(l)) && t('Environment lines look like NAME=value'),
    ports.some(
      (p) =>
        !(Number(p.container) > 0 && Number(p.container) < 65536) ||
        (p.host !== '' && !(Number(p.host) >= 0 && Number(p.host) < 65536))
    ) && t('Ports are numbers between 1 and 65535'),
    volumes.some((v) => !v.source.trim() || !v.target.startsWith('/')) &&
      t('Volumes need a source and an absolute path in the container'),
    commandWords === null && t('A quote in the command is not closed'),
    autoRemove &&
      restart !== 'no' &&
      t('Auto-remove (--rm) only works with the restart policy "Never"')
  ].filter((p): p is string => typeof p === 'string')
  const submit = (): void => {
    if (problems.length) return
    setBusy(true)
    setError(null)
    onRun({
      image: img.trim(),
      ...(name ? { name } : {}),
      ports: ports.map((p) => ({
        host: Number(p.host) || 0,
        container: Number(p.container),
        protocol: p.protocol
      })),
      env: envLines,
      volumes: volumes.map((v) => ({
        source: v.source.trim(),
        target: v.target.trim(),
        readOnly: v.readOnly
      })),
      restart,
      ...(commandWords?.length ? { command: commandWords } : {}),
      autoRemove,
      pull: true
    }).catch((e: unknown) => {
      setError(
        e instanceof Error ? e.message.replace(/^Error invoking[^:]*: (Error: )?/, '') : String(e)
      )
      setBusy(false)
    })
  }
  return (
    <Modal
      title={t('Run a container')}
      description={t('Like docker run -d. The image is pulled first if it is not here yet.')}
      width="max-w-2xl"
      onClose={onClose}
      testId="docker-run-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || problems.length > 0}
            data-testid="docker-run-submit"
            onClick={submit}
          >
            {busy ? t('Starting…') : t('Run')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Image')}>
            <Input
              autoFocus={!image}
              mono
              data-testid="docker-run-image"
              value={img}
              onChange={(e) => {
                setImg(e.target.value)
              }}
            />
          </Field>
          <Field label={t('Name')} hint={t('Optional')}>
            <Input
              mono
              data-testid="docker-run-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
              }}
            />
          </Field>
        </div>
        <Field label={t('Ports')} hint={t('Host port empty = pick a free one')}>
          <div className="flex flex-col gap-1.5">
            {ports.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  mono
                  className="w-24"
                  placeholder={t('host')}
                  aria-label={t('Host port')}
                  data-testid="docker-run-port-host"
                  value={p.host}
                  onChange={(e) => {
                    setPorts(ports.map((x, j) => (j === i ? { ...x, host: e.target.value } : x)))
                  }}
                />
                <span className="text-faint">→</span>
                <Input
                  mono
                  className="w-24"
                  placeholder={t('container')}
                  aria-label={t('Container port')}
                  data-testid="docker-run-port-container"
                  value={p.container}
                  onChange={(e) => {
                    setPorts(
                      ports.map((x, j) => (j === i ? { ...x, container: e.target.value } : x))
                    )
                  }}
                />
                <Select
                  className="w-20"
                  aria-label={t('Protocol')}
                  value={p.protocol}
                  onChange={(e) => {
                    setPorts(
                      ports.map((x, j) =>
                        j === i ? { ...x, protocol: e.target.value as 'tcp' | 'udp' } : x
                      )
                    )
                  }}
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </Select>
                <button
                  type="button"
                  aria-label={t('Remove port')}
                  title={t('Remove port')}
                  className="text-faint hover:text-danger"
                  onClick={() => {
                    setPorts(ports.filter((_, j) => j !== i))
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              icon={<Plus size={13} />}
              data-testid="docker-run-add-port"
              onClick={() => {
                setPorts([...ports, { host: '', container: '', protocol: 'tcp' }])
              }}
            >
              {t('Add port')}
            </Button>
          </div>
        </Field>
        <Field label={t('Volumes')} hint={t('Named volume or a path on the host')}>
          <div className="flex flex-col gap-1.5">
            {volumes.map((v, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  mono
                  placeholder={t('data or /srv/data')}
                  aria-label={t('Volume or host path')}
                  value={v.source}
                  onChange={(e) => {
                    setVolumes(
                      volumes.map((x, j) => (j === i ? { ...x, source: e.target.value } : x))
                    )
                  }}
                />
                <span className="text-faint">→</span>
                <Input
                  mono
                  placeholder="/var/lib/data"
                  aria-label={t('Path in the container')}
                  value={v.target}
                  onChange={(e) => {
                    setVolumes(
                      volumes.map((x, j) => (j === i ? { ...x, target: e.target.value } : x))
                    )
                  }}
                />
                <Checkbox
                  label="ro"
                  title={t('Read-only')}
                  checked={v.readOnly}
                  onChange={(e) => {
                    setVolumes(
                      volumes.map((x, j) => (j === i ? { ...x, readOnly: e.target.checked } : x))
                    )
                  }}
                />
                <button
                  type="button"
                  aria-label={t('Remove volume')}
                  title={t('Remove volume')}
                  className="text-faint hover:text-danger"
                  onClick={() => {
                    setVolumes(volumes.filter((_, j) => j !== i))
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              icon={<Plus size={13} />}
              onClick={() => {
                setVolumes([...volumes, { source: '', target: '', readOnly: false }])
              }}
            >
              {t('Add volume')}
            </Button>
          </div>
        </Field>
        <Field label={t('Environment')} hint={t('One NAME=value per line')}>
          <textarea
            rows={3}
            spellCheck={false}
            data-testid="docker-run-env"
            className="rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
            value={env}
            onChange={(e) => {
              setEnv(e.target.value)
            }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Restart')}>
            <Select
              value={restart}
              onChange={(e) => {
                setRestart(e.target.value as RunSpec['restart'])
              }}
            >
              <option value="no">{t('Never')}</option>
              <option value="unless-stopped">{t('Unless stopped')}</option>
              <option value="always">{t('Always')}</option>
              <option value="on-failure">{t('On failure')}</option>
            </Select>
          </Field>
          <Field label={t('Command')} hint={t('Optional — overrides the image command')}>
            <Input
              mono
              value={command}
              onChange={(e) => {
                setCommand(e.target.value)
              }}
            />
          </Field>
        </div>
        <Checkbox
          label={t('Remove the container when it stops (--rm)')}
          checked={autoRemove}
          onChange={(e) => {
            setAutoRemove(e.target.checked)
            // --rm chỉ đi với restart "Never" (Docker từ chối kết hợp khác).
            if (e.target.checked) setRestart('no')
          }}
        />
        {/* Chưa nhập image: chỉ khoá nút Run, không báo lỗi trên form trống. */}
        {problems.length > 0 && img.trim() !== '' && (
          <p className="text-xs text-warning">{problems[0]}</p>
        )}
        {error && (
          <Notice tone="danger" testId="docker-run-error">
            {error}
          </Notice>
        )}
      </div>
    </Modal>
  )
}
