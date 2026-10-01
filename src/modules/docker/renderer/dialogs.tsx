import { useState } from 'react'
import { Plus, X } from 'lucide-react'
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
import { formatSize } from '../../../renderer/src/lib/format'
import type { ContainerRow, PruneResult, PruneTarget, RunSpec } from '../shared/ops'

/** Xem trước rồi mới dọn (container dừng, image dangling, volume / network không dùng). */
export function PruneDialog({
  what,
  preview,
  error,
  onClose,
  onConfirm
}: {
  what: PruneTarget
  preview: PruneResult | null
  error: string | null
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const title =
    what === 'containers'
      ? 'Remove stopped containers'
      : what === 'images'
        ? 'Remove dangling images'
        : `Remove unused ${what}`
  return (
    <Modal
      title={title}
      onClose={onClose}
      testId="docker-prune-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            data-testid="docker-prune-confirm"
            disabled={!preview || preview.items.length === 0}
            onClick={onConfirm}
          >
            Remove {preview?.items.length ?? ''}
          </Button>
        </>
      }
    >
      {error ? (
        <Notice tone="danger">{error}</Notice>
      ) : !preview ? (
        <p className="text-xs text-faint">Checking what would be removed…</p>
      ) : preview.items.length === 0 ? (
        <p className="text-[13px] text-muted">Nothing to remove.</p>
      ) : (
        <div className="flex flex-col gap-2 text-[13px]">
          <p className="text-muted">
            These will be removed
            {preview.reclaimed ? ` (about ${formatSize(preview.reclaimed)})` : ''}:
          </p>
          <ul
            className="max-h-60 overflow-auto rounded-md bg-subtle p-2 font-mono text-xs text-fg"
            data-testid="docker-prune-list"
          >
            {preview.items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

export function PullDialog({
  pull,
  onClose,
  onPull
}: {
  pull: { status: string; progress: number | null; done: boolean; error?: string } | null
  onClose: () => void
  onPull: (ref: string) => void
}): React.JSX.Element {
  const [ref, setRef] = useState('')
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(ref.trim())
  return (
    <Modal
      title="Pull an image"
      onClose={onClose}
      testId="docker-pull-dialog"
      footer={
        pull?.done ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="docker-pull-submit"
              disabled={!valid || pull !== null}
              onClick={() => {
                onPull(ref.trim())
              }}
            >
              Pull
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          mono
          placeholder="nginx:1.27 or ghcr.io/org/app:tag"
          data-testid="docker-pull-ref"
          value={ref}
          disabled={pull !== null}
          onChange={(e) => {
            setRef(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid && pull === null) onPull(ref.trim())
          }}
        />
        {pull && (
          <div className="flex flex-col gap-1.5" data-testid="docker-pull-progress">
            {pull.progress !== null && !pull.error && (
              <div className="h-1.5 overflow-hidden rounded-full bg-subtle">
                <div
                  className="h-full bg-accent-solid transition-[width]"
                  style={{ width: `${Math.round(pull.progress * 100)}%` }}
                />
              </div>
            )}
            <p className={cx('truncate text-xs', pull.error ? 'text-danger' : 'text-muted')}>
              {pull.status}
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
      title={`Rename ${container.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="docker-rename-submit"
            onClick={() => {
              onRename(name)
            }}
          >
            Rename
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        mono
        value={name}
        data-testid="docker-rename-input"
        onChange={(e) => {
          setName(e.target.value)
        }}
      />
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
      title={`Inspect ${title}`}
      width="max-w-3xl"
      onClose={onClose}
      testId="docker-inspect"
      footer={
        <>
          <Button variant="ghost" onClick={() => void window.shellhouse.writeClipboard(text)}>
            Copy
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
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
  const command =
    shell === 'auto'
      ? undefined
      : shell === 'custom'
        ? custom.trim().split(/\s+/).filter(Boolean)
        : [shell]
  const valid = shell !== 'custom' || (command?.length ?? 0) > 0
  return (
    <Modal
      title={`Open a shell in ${container.name}`}
      onClose={onClose}
      testId="docker-exec-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="docker-exec-open"
            onClick={() => {
              onOpen(command, user.trim() || undefined)
            }}
          >
            Open
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Shell">
          <Select
            value={shell}
            data-testid="docker-exec-shell"
            onChange={(e) => {
              setShell(e.target.value)
            }}
          >
            <option value="auto">bash if available, else sh</option>
            <option value="bash">bash</option>
            <option value="sh">sh</option>
            <option value="ash">ash</option>
            <option value="zsh">zsh</option>
            <option value="custom">Custom command…</option>
          </Select>
        </Field>
        <Field label="User" hint="Empty = the image default">
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
            <Field label="Command">
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
  const problems = [
    !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(img.trim()) && 'Enter an image like nginx:1.27',
    name &&
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) &&
      'Names use letters, digits, "_", "." and "-"',
    envLines.some((l) => !/^[^=\s]+=/.test(l)) && 'Environment lines look like NAME=value',
    ports.some(
      (p) =>
        !(Number(p.container) > 0 && Number(p.container) < 65536) ||
        (p.host !== '' && !(Number(p.host) >= 0 && Number(p.host) < 65536))
    ) && 'Ports are numbers between 1 and 65535',
    volumes.some((v) => !v.source.trim() || !v.target.startsWith('/')) &&
      'Volumes need a source and an absolute path in the container'
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
      ...(command.trim() ? { command: command.trim().split(/\s+/) } : {}),
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
      title="Run a container"
      description="Like docker run -d. The image is pulled first if it is not here yet."
      width="max-w-2xl"
      onClose={onClose}
      testId="docker-run-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || problems.length > 0}
            data-testid="docker-run-submit"
            onClick={submit}
          >
            {busy ? 'Starting…' : 'Run'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Image">
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
          <Field label="Name" hint="Optional">
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
        <Field label="Ports" hint="Host port empty = pick a free one">
          <div className="flex flex-col gap-1.5">
            {ports.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  mono
                  className="w-24"
                  placeholder="host"
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
                  placeholder="container"
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
                  aria-label="Remove port"
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
              Add port
            </Button>
          </div>
        </Field>
        <Field label="Volumes" hint="Named volume or a path on the host">
          <div className="flex flex-col gap-1.5">
            {volumes.map((v, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  mono
                  placeholder="data or /srv/data"
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
                  value={v.target}
                  onChange={(e) => {
                    setVolumes(
                      volumes.map((x, j) => (j === i ? { ...x, target: e.target.value } : x))
                    )
                  }}
                />
                <Checkbox
                  label="ro"
                  checked={v.readOnly}
                  onChange={(e) => {
                    setVolumes(
                      volumes.map((x, j) => (j === i ? { ...x, readOnly: e.target.checked } : x))
                    )
                  }}
                />
                <button
                  type="button"
                  aria-label="Remove volume"
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
              Add volume
            </Button>
          </div>
        </Field>
        <Field label="Environment" hint="One NAME=value per line">
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
          <Field label="Restart">
            <Select
              value={restart}
              onChange={(e) => {
                setRestart(e.target.value as RunSpec['restart'])
              }}
            >
              <option value="no">Never</option>
              <option value="unless-stopped">Unless stopped</option>
              <option value="always">Always</option>
              <option value="on-failure">On failure</option>
            </Select>
          </Field>
          <Field label="Command" hint="Optional — overrides the image command">
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
          label="Remove the container when it stops (--rm)"
          checked={autoRemove}
          onChange={(e) => {
            setAutoRemove(e.target.checked)
          }}
        />
        {problems.length > 0 && <p className="text-xs text-warning">{problems[0]}</p>}
        {error && (
          <Notice tone="danger" testId="docker-run-error">
            {error}
          </Notice>
        )}
      </div>
    </Modal>
  )
}
