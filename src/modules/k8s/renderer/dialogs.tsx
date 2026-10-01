import { useEffect, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import {
  Button,
  Checkbox,
  cx,
  Input,
  Modal,
  Notice,
  Select
} from '../../../renderer/src/components/ui'
import { Pill } from '../../../renderer/src/components/panels'
import { cleanError } from '../../../renderer/src/lib/format'
import type { ApplyResult, DrainResult, K8sOp, RolloutRevision } from '../shared/ops'
import { age, type K8sObject } from '../shared/resources'

type Request = <T>(op: K8sOp) => Promise<T>

export function DeleteDialog({
  obj,
  force,
  production,
  onClose,
  onDelete
}: {
  obj: K8sObject
  force: boolean
  production: boolean
  onClose: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const ok = !production || typed === obj.metadata.name
  return (
    <Modal
      title={`${force ? 'Kill' : 'Delete'} ${obj.kind ?? ''} ${obj.metadata.name}?`}
      onClose={onClose}
      testId="k8s-delete-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!ok}
            data-testid="k8s-delete-confirm"
            onClick={onDelete}
          >
            {force ? 'Kill' : 'Delete'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-[13px]">
        <p className="text-muted">
          {obj.metadata.namespace ? `Namespace ${obj.metadata.namespace}. ` : ''}
          {force
            ? 'The pod is removed immediately, without waiting for it to shut down.'
            : 'This cannot be undone.'}
        </p>
        {production && (
          <>
            <Notice tone="warning">This is a production context. Type the name to confirm.</Notice>
            <Input
              autoFocus
              mono
              data-testid="k8s-delete-typed"
              placeholder={obj.metadata.name}
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value)
              }}
            />
          </>
        )}
      </div>
    </Modal>
  )
}

export function ForwardDialog({
  obj,
  ports,
  onClose,
  onForward
}: {
  obj: K8sObject
  ports: number[]
  onClose: () => void
  onForward: (local: number, remote: number) => void
}): React.JSX.Element {
  const [remote, setRemote] = useState(String(ports[0] ?? ''))
  const [local, setLocal] = useState('')
  const r = Number(remote)
  const l = local.trim() === '' ? 0 : Number(local)
  const valid =
    Number.isInteger(r) && r > 0 && r < 65536 && Number.isInteger(l) && l >= 0 && l < 65536
  return (
    <Modal
      title={`Forward a port to ${obj.metadata.name}`}
      onClose={onClose}
      testId="k8s-forward-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="k8s-forward-start"
            onClick={() => onForward(l, r)}
          >
            Start
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 text-[13px]">
        <label className="flex flex-col gap-1">
          <span className="text-muted">Port in the cluster</span>
          {ports.length > 0 ? (
            <Select
              data-testid="k8s-forward-remote"
              value={remote}
              onChange={(e) => setRemote(e.target.value)}
            >
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              mono
              data-testid="k8s-forward-remote"
              value={remote}
              onChange={(e) => setRemote(e.target.value)}
            />
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Port on this computer</span>
          <Input
            mono
            placeholder="auto"
            data-testid="k8s-forward-local"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  )
}

export function ScaleDialog({
  obj,
  production,
  onClose,
  onScale
}: {
  obj: K8sObject
  production: boolean
  onClose: () => void
  onScale: (replicas: number) => void
}): React.JSX.Element {
  const current = typeof obj.spec?.['replicas'] === 'number' ? obj.spec['replicas'] : 0
  const [value, setValue] = useState(String(current))
  const [typed, setTyped] = useState('')
  const n = Number(value)
  const valid =
    Number.isInteger(n) &&
    n >= 0 &&
    n <= 10_000 &&
    n !== current &&
    (!production || typed === obj.metadata.name)
  return (
    <Modal
      title={`Scale ${obj.metadata.name}`}
      description={`Currently ${current} replica${current === 1 ? '' : 's'}`}
      onClose={onClose}
      testId="k8s-scale-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="k8s-scale-apply"
            onClick={() => onScale(n)}
          >
            Scale
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="secondary"
            aria-label="Fewer replicas"
            disabled={n <= 0}
            onClick={() => setValue(String(Math.max(0, n - 1)))}
          >
            <Minus size={14} />
          </Button>
          <Input
            autoFocus
            mono
            className="w-24 text-center text-lg"
            data-testid="k8s-scale-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value.replace(/\D/g, ''))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid) onScale(n)
            }}
          />
          <Button
            variant="secondary"
            aria-label="More replicas"
            data-testid="k8s-scale-more"
            onClick={() => setValue(String(n + 1))}
          >
            <Plus size={14} />
          </Button>
        </div>
        {production && (
          <>
            <Notice tone="warning">Production context — type the name to confirm.</Notice>
            <Input
              mono
              placeholder={obj.metadata.name}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </>
        )}
      </div>
    </Modal>
  )
}

export function DrainDialog({
  node,
  request,
  onClose
}: {
  node: K8sObject
  request: Request
  onClose: () => void
}): React.JSX.Element {
  const [result, setResult] = useState<DrainResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal
      title={`Drain ${node.metadata.name}?`}
      description="Cordons the node, then evicts its pods so they are rescheduled elsewhere. DaemonSet and static pods stay."
      onClose={onClose}
      testId="k8s-drain-dialog"
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              data-testid="k8s-drain-confirm"
              onClick={() => {
                setBusy(true)
                request<DrainResult>({ op: 'drain', node: node.metadata.name }).then(
                  setResult,
                  (e: unknown) => {
                    setError(cleanError(e))
                    setBusy(false)
                  }
                )
              }}
            >
              {busy ? 'Draining…' : 'Drain'}
            </Button>
          </>
        )
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {result && (
        <div className="flex flex-col gap-2 text-xs" data-testid="k8s-drain-result">
          <p className="text-fg">
            Evicted {result.evicted.length} · skipped {result.skipped.length}
            {result.failed.length ? ` · failed ${result.failed.length}` : ''}
          </p>
          {result.failed.map((f) => (
            <p key={f} className="text-danger">
              {f}
            </p>
          ))}
        </div>
      )}
    </Modal>
  )
}

export function HistoryDialog({
  obj,
  request,
  readOnly,
  onClose,
  onDone
}: {
  obj: K8sObject
  request: Request
  readOnly: boolean
  onClose: () => void
  onDone: (text: string) => void
}): React.JSX.Element {
  const [list, setList] = useState<RolloutRevision[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ns = obj.metadata.namespace ?? ''
  useEffect(() => {
    request<RolloutRevision[]>({
      op: 'rolloutHistory',
      namespace: ns,
      name: obj.metadata.name
    }).then(setList, (e: unknown) => {
      setError(cleanError(e))
    })
  }, [request, ns, obj.metadata.name])
  return (
    <Modal
      title={`Rollout history — ${obj.metadata.name}`}
      width="max-w-2xl"
      onClose={onClose}
      testId="k8s-history"
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {!list && !error && <p className="text-xs text-faint">Loading…</p>}
      {list && (
        <div className="flex flex-col divide-y divide-line text-xs">
          {list.map((r) => (
            <div
              key={r.revision}
              className="flex items-center gap-3 py-2"
              data-testid="k8s-revision"
            >
              <span className="w-10 font-mono text-fg">#{r.revision}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-fg">{r.images.join(', ')}</div>
                <div className="text-faint">
                  {r.replicaSet} · {age(Date.parse(r.created))} ago · {r.replicas} pods
                </div>
              </div>
              {r.current ? (
                <Pill tone="ok">current</Pill>
              ) : (
                !readOnly && (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="k8s-rollback"
                    onClick={() => {
                      if (
                        !window.confirm(`Roll ${obj.metadata.name} back to revision ${r.revision}?`)
                      )
                        return
                      request({
                        op: 'rollback',
                        namespace: ns,
                        name: obj.metadata.name,
                        revision: r.revision
                      }).then(
                        () => {
                          onDone(`Rolled ${obj.metadata.name} back to revision ${r.revision}`)
                          onClose()
                        },
                        (e: unknown) => {
                          setError(cleanError(e))
                        }
                      )
                    }}
                  >
                    Roll back
                  </Button>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

/** Mẫu cho "Create from YAML". */
const TEMPLATES: Record<string, string> = {
  Deployment: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:1.27
          ports:
            - containerPort: 80
`,
  Service: `apiVersion: v1
kind: Service
metadata:
  name: my-app
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 80
`,
  ConfigMap: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
data:
  key: value
`,
  Secret: `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
type: Opaque
stringData:
  password: change-me
`,
  Job: `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox
          command: ["sh", "-c", "echo hello"]
`
}

/**
 * Trình sửa YAML trong app: xem / sửa (replace có kiểm resourceVersion) hoặc tạo mới (server-side
 * apply, nhiều tài liệu).
 */
export function YamlEditor({
  title,
  initial,
  mode,
  namespace,
  request,
  onClose,
  onDone
}: {
  title: string
  initial: string
  mode: 'view' | 'edit' | 'create'
  namespace: string | undefined
  request: Request
  onClose: () => void
  onDone: (text: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ApplyResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const lines = text.split('\n').length
  const apply = (): void => {
    setBusy(true)
    setError(null)
    if (mode === 'edit') {
      request({ op: 'apply', yaml: text }).then(
        () => {
          onDone(`Saved ${title}`)
          onClose()
        },
        (e: unknown) => {
          setError(cleanError(e))
          setBusy(false)
        }
      )
      return
    }
    request<ApplyResult[]>({
      op: 'serverApply',
      yaml: text,
      ...(namespace ? { namespace } : {})
    }).then(
      (r) => {
        setResults(r)
        setBusy(false)
        if (r.every((x) => x.action !== 'error')) {
          onDone(`Applied ${r.length} object${r.length === 1 ? '' : 's'}`)
          onClose()
        }
      },
      (e: unknown) => {
        setError(cleanError(e))
        setBusy(false)
      }
    )
  }
  return (
    <Modal
      title={title}
      width="max-w-4xl"
      onClose={onClose}
      testId="k8s-yaml-editor"
      footer={
        mode === 'view' ? (
          <>
            <Button variant="ghost" onClick={() => void window.shellhouse.writeClipboard(text)}>
              Copy
            </Button>
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <>
            {mode === 'create' && (
              <Select
                aria-label="Template"
                className="mr-auto h-8 w-40 text-xs"
                data-testid="k8s-yaml-template"
                value=""
                onChange={(e) => {
                  const t = TEMPLATES[e.target.value]
                  if (t) setText(t)
                }}
              >
                <option value="">Insert template…</option>
                {Object.keys(TEMPLATES).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || !text.trim()}
              data-testid="k8s-yaml-apply"
              onClick={apply}
            >
              {mode === 'edit' ? 'Save' : 'Apply'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-2">
        {mode === 'create' && (
          <p className="text-xs text-muted">
            Server-side apply: creates new objects and updates existing ones. Separate several
            objects with “---”. Objects without a namespace go to{' '}
            {namespace ?? 'the context default'}.
          </p>
        )}
        <div className="flex max-h-[60vh] min-h-72 overflow-auto rounded-md border border-line bg-subtle font-mono text-xs">
          <pre aria-hidden className="shrink-0 py-2 pr-2 pl-3 text-right text-faint select-none">
            {Array.from({ length: lines }, (_, i) => i + 1).join('\n')}
          </pre>
          <textarea
            ref={area}
            spellCheck={false}
            readOnly={mode === 'view'}
            data-testid="k8s-yaml-text"
            className="min-h-full flex-1 resize-none bg-transparent py-2 pr-3 leading-[inherit] text-fg outline-none"
            style={{ height: `${lines * 1.5 + 1}em`, lineHeight: '1.5' }}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
            }}
            onKeyDown={(e) => {
              // Tab chèn 2 khoảng trắng (YAML không dùng tab).
              if (e.key === 'Tab' && mode !== 'view') {
                e.preventDefault()
                const el = e.currentTarget
                const { selectionStart: a, selectionEnd: b } = el
                setText(`${text.slice(0, a)}  ${text.slice(b)}`)
                requestAnimationFrame(() => {
                  el.selectionStart = el.selectionEnd = a + 2
                })
              }
              if ((e.ctrlKey || e.metaKey) && e.key === 's' && mode !== 'view') {
                e.preventDefault()
                apply()
              }
            }}
          />
        </div>
        {error && (
          <Notice tone="danger" testId="k8s-yaml-error">
            {error}
          </Notice>
        )}
        {results && (
          <div className="flex flex-col gap-1 text-xs" data-testid="k8s-apply-results">
            {results.map((r) => (
              <div
                key={r.object}
                className={cx('flex gap-2', r.action === 'error' ? 'text-danger' : 'text-success')}
              >
                <span className="font-mono">{r.object}</span>
                <span>{r.action === 'error' ? r.error : 'configured'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Chọn container khi pod có nhiều container (shell). */
export function ContainerPicker({
  containers,
  onPick,
  onClose
}: {
  containers: string[]
  onPick: (c: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(containers[0] ?? '')
  const [all, setAll] = useState(false)
  return (
    <Modal
      title="Open a shell"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onPick(value)}>
            Open
          </Button>
        </>
      }
    >
      <Select value={value} onChange={(e) => setValue(e.target.value)}>
        {containers.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
      <Checkbox
        className="mt-2 hidden"
        label="All"
        checked={all}
        onChange={(e) => setAll(e.target.checked)}
      />
    </Modal>
  )
}
