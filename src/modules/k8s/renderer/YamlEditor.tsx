import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Copy, GitCompare } from 'lucide-react'
import type { Extension } from '@codemirror/state'
import { parseDocument } from 'yaml'
import { Button, cx, Modal, Notice, Select } from '../../../renderer/src/components/ui'
import { Pill } from '../../../renderer/src/components/panels'
import { cleanError } from '../../../renderer/src/lib/format'
import {
  confirmAction,
  LazyCodeEditor,
  t,
  tn,
  type CodeEditorHandle
} from '../../registry/renderer-kit'
import type { ApplyResult, DiffItem, K8sOp } from '../shared/ops'
import { DiffView } from './DiffView'
import { loadYamlSupport } from './yamlLanguage'

type Request = <T>(op: K8sOp) => Promise<T>

/** Đối tượng đang sửa (để tải lại bản mới nhất khi xung đột). */
export interface YamlSource {
  kind: string
  namespace?: string | undefined
  name: string
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

/** Người khác đã sửa đối tượng (409 / resourceVersion cũ). */
const isConflict = (text: string): boolean =>
  /Someone changed this object|the object has been modified|Conflict/i.test(text) ||
  text.includes(
    t('Someone changed this object since you opened it. Reload it and apply your change again.')
  )

/** Thay `metadata.resourceVersion` trong YAML (giữ nguyên phần còn lại, cả chú thích). */
function withResourceVersion(text: string, rv: string): string {
  const doc = parseDocument(text)
  if (doc.errors.length) return text
  doc.setIn(['metadata', 'resourceVersion'], rv)
  return doc.toString()
}

const kindOfItem = (i: DiffItem): 'error' | 'create' | 'same' | 'update' =>
  i.error || i.result === null
    ? 'error'
    : i.live === null
      ? 'create'
      : i.live === i.result
        ? 'same'
        : 'update'

/**
 * Trình sửa YAML trong app (CodeMirror: tô màu, báo lỗi YAML ngay dòng, tìm Ctrl+F, gập): xem /
 * sửa (replace có kiểm resourceVersion) hoặc tạo mới (server-side apply, nhiều tài liệu). Trước khi
 * ghi luôn xem trước thay đổi — API server chạy thử (dryRun=All), so bản trên cluster với kết quả.
 * Ctrl+S = xem trước / áp dụng; đang gửi thì bỏ qua (không gửi hai lần). Đóng khi có thay đổi chưa
 * áp dụng → hỏi. Xung đột (người khác vừa sửa) → Tải lại hoặc Ghi đè.
 */
export function YamlEditor({
  title,
  initial,
  mode,
  namespace,
  request,
  source,
  onClose,
  onDone
}: {
  title: string
  initial: string
  mode: 'view' | 'edit' | 'create'
  namespace: string | undefined
  request: Request
  /** Sửa: đối tượng gốc (Tải lại / Ghi đè khi xung đột). */
  source?: YamlSource | undefined
  onClose: () => void
  onDone: (text: string) => void
}): React.JSX.Element {
  const editor = useRef<CodeEditorHandle>(null)
  /** Bản gốc để so "đã sửa chưa" (đổi khi Tải lại). */
  const base = useRef(initial)
  const [dirty, setDirty] = useState(false)
  const [hasText, setHasText] = useState(initial.trim() !== '')
  const [lang, setLang] = useState<Extension | null>(null)
  const [phase, setPhase] = useState<'edit' | 'review'>('edit')
  const [preview, setPreview] = useState<DiffItem[] | null>(null)
  const [open, setOpen] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [results, setResults] = useState<ApplyResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const readOnly = mode === 'view'

  useEffect(() => {
    let cancelled = false
    void loadYamlSupport(!readOnly).then((ext) => {
      if (!cancelled) setLang(ext)
    })
    return () => {
      cancelled = true
    }
  }, [readOnly])

  const textNow = (): string => editor.current?.text() ?? base.current
  const setBusyBoth = (v: boolean): void => {
    busyRef.current = v
    setBusy(v)
  }

  const requestClose = (): void => {
    const unsaved = mode === 'edit' ? dirty : mode === 'create' && textNow().trim() !== ''
    if (!unsaved) {
      onClose()
      return
    }
    void confirmAction({
      title: t('Discard your changes?'),
      message: t('The YAML you edited has not been applied to the cluster.'),
      confirmLabel: t('Discard'),
      danger: true
    }).then((ok) => {
      if (ok) onClose()
    })
  }

  const fail = (e: unknown): void => {
    const text = cleanError(e)
    setError(text)
    setConflict(mode === 'edit' && isConflict(text))
    setBusyBoth(false)
  }

  /** Bước 1: chạy thử trên API server, hiện diff. */
  const review = (): void => {
    const text = textNow()
    if (busyRef.current || readOnly || !text.trim()) return
    setBusyBoth(true)
    setError(null)
    setConflict(false)
    setResults(null)
    request<DiffItem[]>({
      op: 'diff',
      mode: mode === 'edit' ? 'replace' : 'apply',
      yaml: text,
      ...(namespace ? { namespace } : {})
    }).then((items) => {
      setBusyBoth(false)
      const conflictItem = items.find((i) => i.error && isConflict(i.error))
      if (conflictItem) {
        setError(conflictItem.error ?? null)
        setConflict(true)
        return
      }
      setPreview(items)
      setOpen(
        Math.max(
          0,
          items.findIndex((i) => kindOfItem(i) !== 'same')
        )
      )
      setPhase('review')
    }, fail)
  }

  /** Bước 2: ghi thật. */
  const commit = (): void => {
    const text = textNow()
    if (busyRef.current || readOnly || !text.trim()) return
    setBusyBoth(true)
    setError(null)
    if (mode === 'edit') {
      request({ op: 'apply', yaml: text }).then(
        () => {
          onDone(t('Saved {title}', { title }))
          onClose()
        },
        (e: unknown) => {
          fail(e)
          setPhase('edit')
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
        setBusyBoth(false)
        if (r.every((x) => x.action !== 'error')) {
          onDone(tn(r.length, 'Applied {n} object', 'Applied {n} objects'))
          onClose()
        } else setPhase('edit')
      },
      (e: unknown) => {
        fail(e)
        setPhase('edit')
      }
    )
  }

  const latest = async (): Promise<string> => {
    if (!source) throw new Error(t('Cannot reload this object'))
    return request<string>({
      op: 'get',
      kind: source.kind,
      ...(source.namespace ? { namespace: source.namespace } : {}),
      name: source.name,
      format: 'yaml'
    })
  }

  /** Xung đột → bỏ thay đổi của mình, nạp bản mới nhất. */
  const reload = (): void => {
    void (async () => {
      if (dirty) {
        const ok = await confirmAction({
          title: t('Reload and lose your changes?'),
          message: t('The editor is replaced with the version that is on the cluster now.'),
          confirmLabel: t('Reload'),
          danger: true
        })
        if (!ok) return
      }
      setBusyBoth(true)
      try {
        const text = await latest()
        base.current = text
        editor.current?.setText(text)
        setDirty(false)
        setError(null)
        setConflict(false)
        setPhase('edit')
      } catch (e) {
        setError(cleanError(e))
      } finally {
        setBusyBoth(false)
      }
    })()
  }

  /** Xung đột → giữ bản của mình, lấy resourceVersion mới nhất rồi xem trước lại. */
  const overwrite = (): void => {
    void (async () => {
      setBusyBoth(true)
      try {
        const fresh = parseDocument(await latest()).getIn(['metadata', 'resourceVersion'])
        if (typeof fresh !== 'string') throw new Error(t('The object no longer exists'))
        editor.current?.setText(withResourceVersion(textNow(), fresh))
        setBusyBoth(false)
        setConflict(false)
        review()
      } catch (e) {
        fail(e)
      }
    })()
  }

  const changedItems = preview?.filter((i) => kindOfItem(i) !== 'same') ?? []
  const errorItems = preview?.filter((i) => kindOfItem(i) === 'error') ?? []
  const nothingToDo = preview !== null && changedItems.length === 0
  const blocked = preview !== null && errorItems.length === preview.length

  const footer = readOnly ? (
    <>
      <Button
        variant="ghost"
        icon={<Copy size={13} />}
        onClick={() => void window.shellhouse.writeClipboard(textNow())}
      >
        {t('Copy')}
      </Button>
      <Button variant="primary" onClick={onClose}>
        {t('Close')}
      </Button>
    </>
  ) : phase === 'review' ? (
    <>
      <Button
        variant="ghost"
        className="mr-auto"
        icon={<ArrowLeft size={13} />}
        data-testid="k8s-yaml-back"
        onClick={() => {
          setPhase('edit')
          requestAnimationFrame(() => editor.current?.focus())
        }}
      >
        {t('Back to editor')}
      </Button>
      <Button variant="ghost" onClick={requestClose}>
        {t('Cancel')}
      </Button>
      <Button
        variant="primary"
        disabled={busy || nothingToDo || blocked}
        data-testid="k8s-yaml-apply"
        onClick={commit}
      >
        {busy
          ? mode === 'edit'
            ? t('Saving…')
            : t('Applying…')
          : mode === 'edit'
            ? t('Save')
            : t('Apply')}
      </Button>
    </>
  ) : (
    <>
      {mode === 'create' && (
        <Select
          aria-label={t('Template')}
          className="mr-auto h-8 w-40 text-xs"
          data-testid="k8s-yaml-template"
          value=""
          onChange={(e) => {
            const tpl = TEMPLATES[e.target.value]
            if (!tpl) return
            // Thay toàn bộ nhưng vẫn Ctrl+Z được.
            editor.current?.setText(tpl)
            editor.current?.focus()
          }}
        >
          <option value="">{t('Insert template…')}</option>
          {Object.keys(TEMPLATES).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
      )}
      <Button variant="ghost" onClick={requestClose}>
        {t('Cancel')}
      </Button>
      <Button
        variant="primary"
        icon={<GitCompare size={13} />}
        disabled={busy || !hasText || (mode === 'edit' && !dirty)}
        title={t('Preview the changes on the cluster (dry run), then confirm')}
        data-testid="k8s-yaml-apply"
        onClick={review}
      >
        {busy ? t('Checking…') : t('Review changes')}
      </Button>
    </>
  )

  return (
    <Modal
      title={title}
      width="max-w-5xl"
      onClose={requestClose}
      testId="k8s-yaml-editor"
      footer={footer}
    >
      <div className="flex flex-col gap-2">
        {mode === 'create' && phase === 'edit' && (
          <p className="text-xs text-muted">
            {t(
              'Server-side apply: creates new objects and updates existing ones. Separate several objects with “---”. Objects without a namespace go to {namespace}.',
              { namespace: namespace ?? t('the context default') }
            )}
          </p>
        )}
        <div
          className={cx(
            'h-[60vh] min-h-72 overflow-hidden rounded-md border border-line',
            phase === 'review' && 'hidden'
          )}
        >
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-xs text-faint">
                {t('Loading editor…')}
              </div>
            }
          >
            <LazyCodeEditor
              ref={editor}
              initial={initial}
              lineSeparator={'\n'}
              language={lang}
              wrap={false}
              readOnly={readOnly}
              testId="k8s-yaml-text"
              onChange={(get) => {
                const text = get()
                setDirty(text !== base.current)
                setHasText(text.trim() !== '')
                if (error && !conflict) setError(null)
              }}
              onSave={() => {
                if (phase === 'edit') review()
              }}
            />
          </Suspense>
        </div>
        {phase === 'review' && preview && (
          <div className="flex flex-col gap-2" data-testid="k8s-yaml-preview">
            <p className="text-xs text-muted">
              {mode === 'edit'
                ? t('Dry run on the cluster: this is what will change when you save.')
                : t('Dry run on the cluster: this is what will be created or changed.')}
            </p>
            {nothingToDo && errorItems.length === 0 && (
              <Notice tone="info" testId="k8s-yaml-no-changes">
                {t('No changes — the cluster already matches this YAML.')}
              </Notice>
            )}
            {preview.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {preview.map((item, i) => {
                  const k = kindOfItem(item)
                  return (
                    <button
                      key={`${item.object}${String(i)}`}
                      type="button"
                      className={cx(
                        'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                        i === open ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'
                      )}
                      onClick={() => {
                        setOpen(i)
                      }}
                    >
                      <span className="font-mono">{item.object}</span>
                      <ChangePill kind={k} />
                    </button>
                  )
                })}
              </div>
            )}
            {preview[open] && <PreviewItem item={preview[open]} single={preview.length === 1} />}
          </div>
        )}
        {error && (
          <Notice tone="danger" testId="k8s-yaml-error">
            {error}
            {conflict && source && (
              <span className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="k8s-yaml-reload"
                  onClick={reload}
                >
                  {t('Reload')}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  data-testid="k8s-yaml-overwrite"
                  onClick={overwrite}
                >
                  {t('Overwrite')}
                </Button>
                <span className="self-center text-[11px] text-muted">
                  {t('Reload loses your edits; Overwrite saves your version over theirs.')}
                </span>
              </span>
            )}
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
                <span>{r.action === 'error' ? r.error : t('configured')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

function ChangePill({ kind }: { kind: ReturnType<typeof kindOfItem> }): React.JSX.Element {
  return kind === 'error' ? (
    <Pill tone="bad">{t('error')}</Pill>
  ) : kind === 'create' ? (
    <Pill tone="ok">{t('create')}</Pill>
  ) : kind === 'same' ? (
    <Pill tone="muted">{t('no change')}</Pill>
  ) : (
    <Pill tone="info">{t('update')}</Pill>
  )
}

function PreviewItem({ item, single }: { item: DiffItem; single: boolean }): React.JSX.Element {
  const kind = kindOfItem(item)
  const labels = useMemo(
    () => ({
      left: item.live === null ? t('(not on the cluster)') : t('on the cluster'),
      right: t('after applying')
    }),
    [item.live]
  )
  if (kind === 'error')
    return (
      <Notice tone="danger" testId="k8s-yaml-preview-error">
        <span className="font-mono">{item.object}</span>: {item.error}
      </Notice>
    )
  return (
    <div className="flex flex-col gap-1">
      {single && (
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-fg">{item.object}</span>
          <ChangePill kind={kind} />
        </div>
      )}
      <DiffView
        className="h-[52vh]"
        left={item.live ?? ''}
        right={item.result ?? ''}
        leftLabel={labels.left}
        rightLabel={labels.right}
        testId="k8s-yaml-diff"
      />
    </div>
  )
}
