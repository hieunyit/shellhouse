import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeftRight,
  Box,
  Copy,
  Eye,
  FileCode,
  FileText,
  Minus,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Ship,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-react'
import { Button, cx, Input, Modal, Notice, Select } from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { FileTable, type FileColumn } from '../../../renderer/src/components/files/FileTable'
import { Empty, ToolButton } from '../../../renderer/src/components/files/parts'
import type { SortState } from '../../../renderer/src/components/SortMenu'
import { cleanError } from '../../../renderer/src/lib/format'
import { ConnectionPrompt } from '../../registry/renderer-kit'
import type { ModuleTabProps } from '../../registry/renderer-types'
import type { DiscoveredKind, K8sClusterParams, PortForwardInfo, WatchEvent } from '../shared/ops'
import { contextKey } from '../shared/ops'
import {
  age,
  BUILTIN_KINDS,
  COLUMNS,
  toRow,
  type K8sObject,
  type ResourceRow
} from '../shared/resources'
import { openPodLogs, openPodShell } from './api'
import { COLOR_DOT } from './K8sSection'
import { useK8s } from './store'
import { useK8sSession } from './useK8sSession'

const PAGE = 500
const MAX_PAGES = 20

const TONE: Record<ResourceRow['tone'], string> = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  muted: 'text-faint'
}

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})
const a = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]).map(o) : [])
const s = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

type Dialog =
  | { kind: 'yaml'; title: string; text: string }
  | { kind: 'delete'; target: K8sObject }
  | { kind: 'forward'; target: K8sObject; ports: number[] }
  | null

/** Tab một cluster (context). */
export function ClusterTab({ tabId, params }: ModuleTabProps<K8sClusterParams>): React.JSX.Element {
  const entry = useK8s((st) => st.contexts.find((c) => c.key === contextKey(params.ref)))
  const readOnly = entry?.settings.readOnly ?? false
  const production = entry?.settings.color === 'red'
  const [kinds, setKinds] = useState<DiscoveredKind[] | null>(null)
  const [kindId, setKindId] = useState('pods')
  const [allNamespaces, setAllNamespaces] = useState<string[]>([])
  const [namespaces, setNamespaces] = useState<string[] | null>(
    params.namespace ? [params.namespace] : null
  )
  const [objects, setObjects] = useState<Map<string, K8sObject> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [sort, setSort] = useState<SortState<'name' | 'age'>>({ key: 'name', dir: 'asc' })
  const [forwards, setForwards] = useState<PortForwardInfo[]>([])
  const [showForwards, setShowForwards] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const watchSubs = useRef(new Set<string>())
  const filterRef = useRef<HTMLInputElement>(null)
  const { menu, open: openMenu } = useContextMenu()

  const onEvent = useCallback((event: string, data: unknown) => {
    if (event === 'watch') {
      const w = data as WatchEvent & { error?: string }
      if (!watchSubs.current.has(w.subscription)) return
      if (w.relist) {
        setReloadKey((k) => k + 1)
        return
      }
      if (w.events.length === 0) return
      setObjects((prev) => {
        const next = new Map(prev ?? [])
        for (const e of w.events) {
          const obj = e.object as K8sObject
          const key = obj.metadata.namespace
            ? `${obj.metadata.namespace}/${obj.metadata.name}`
            : obj.metadata.name
          if (e.type === 'DELETED') next.delete(key)
          else next.set(key, obj)
        }
        return next
      })
    } else if (event === 'forwards') {
      setForwards(data as PortForwardInfo[])
    } else if (event === 'edit') {
      const d = data as { name: string; ok: boolean; error?: string }
      setNotice(
        d.ok
          ? { tone: 'success', text: `Saved ${d.name} to the cluster` }
          : { tone: 'danger', text: `Could not save ${d.name}: ${d.error ?? 'unknown error'}` }
      )
    }
  }, [])
  const session = useK8sSession(tabId, params.ref, params.bastionHostId, readOnly, onEvent)
  const { ready, request, cluster } = session
  const nsForAccess = namespaces?.length === 1 ? namespaces[0] : undefined

  // Loại tài nguyên + quyền; danh sách namespace.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    request<DiscoveredKind[]>({
      op: 'discover',
      ...(nsForAccess ? { namespace: nsForAccess } : {})
    }).then(
      (k) => {
        if (!cancelled) setKinds(k)
      },
      (e: unknown) => {
        if (!cancelled) setLoadError(cleanError(e))
      }
    )
    request<{ names: string[]; canList: boolean }>({ op: 'namespaces' }).then(
      (r) => {
        if (cancelled) return
        setAllNamespaces(r.names)
        // Không list được namespace → mặc định namespace của context thay cho "tất cả".
        setNamespaces((cur) => cur ?? (r.canList ? [cluster?.namespace ?? 'default'] : r.names))
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [ready, request, nsForAccess, cluster?.namespace])

  const kind = kinds?.find((k) => k.id === kindId) ?? BUILTIN_KINDS.find((k) => k.id === kindId)
  const scope: (string | undefined)[] =
    !kind?.namespaced || !namespaces || namespaces.length === 0 ? [undefined] : namespaces

  // List (phân trang) rồi watch từ resourceVersion — cho từng namespace đang chọn.
  const scopeKey = scope.join(',')
  useEffect(() => {
    if (!ready || !kind || namespaces === null) return
    const state = { cancelled: false }
    // Đọc qua hàm để TS không thu hẹp kiểu qua `await`.
    const isCancelled = (): boolean => state.cancelled
    const subs: string[] = []
    const active = watchSubs.current
    const run = async (): Promise<void> => {
      const all = new Map<string, K8sObject>()
      const versions: { ns: string | undefined; rv: string }[] = []
      for (const ns of scope) {
        let cont: string | undefined
        let rv = ''
        for (let page = 0; page < MAX_PAGES; page++) {
          const r = await request<{
            items: K8sObject[]
            resourceVersion: string
            continue: string | null
          }>({
            op: 'list',
            kind: kind.id,
            ...(ns ? { namespace: ns } : {}),
            limit: PAGE,
            ...(cont ? { continue: cont } : {})
          })
          for (const obj of r.items)
            all.set(
              obj.metadata.namespace
                ? `${obj.metadata.namespace}/${obj.metadata.name}`
                : obj.metadata.name,
              obj
            )
          rv = r.resourceVersion
          if (!r.continue) break
          cont = r.continue
        }
        versions.push({ ns, rv })
      }
      if (isCancelled()) return
      setObjects(all)
      setLoadError(null)
      for (const v of versions) {
        const w = await request<{ subscription: string }>({
          op: 'watch',
          kind: kind.id,
          ...(v.ns ? { namespace: v.ns } : {}),
          resourceVersion: v.rv
        })
        if (isCancelled()) {
          void request({ op: 'unsubscribe', subscription: w.subscription })
          return
        }
        subs.push(w.subscription)
        active.add(w.subscription)
      }
    }
    run().catch((e: unknown) => {
      if (!state.cancelled) setLoadError(cleanError(e))
    })
    return () => {
      state.cancelled = true
      for (const sub of subs) {
        active.delete(sub)
        void request({ op: 'unsubscribe', subscription: sub }).catch(() => undefined)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKey đại diện cho scope
  }, [ready, request, kind?.id, scopeKey, reloadKey, namespaces === null])

  // Ctrl+K trong tab: tìm nhanh.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'k' &&
        document.activeElement?.closest(`[data-tab="${tabId}"]`)
      ) {
        e.preventDefault()
        filterRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [tabId])

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setNotice(null)
    try {
      await fn()
    } catch (e) {
      setNotice({ tone: 'danger', text: `${label}: ${cleanError(e)}` })
    }
  }

  const q = filter.trim().toLowerCase()
  const rows = [...(objects?.values() ?? [])]
    .map((obj) => ({ obj, row: toRow(kindId, obj) }))
    .filter(({ row }) => !q || row.name.toLowerCase().includes(q) || row.namespace.includes(q))
    .sort((x, y) => {
      const dir = sort.dir === 'asc' ? 1 : -1
      if (sort.key === 'age') return (x.row.created - y.row.created) * dir
      return x.row.key.localeCompare(y.row.key) * dir
    })
  const single =
    rows.length > 0 && selected.size === 1 ? rows.find((r) => selected.has(r.row.key)) : undefined

  const multiNs = kind?.namespaced && scope.length !== 1
  const columns: FileColumn<{ obj: K8sObject; row: ResourceRow }, 'name' | 'age'>[] = [
    ...(multiNs
      ? [{ id: 'ns', label: 'Namespace', render: (r: { row: ResourceRow }) => r.row.namespace }]
      : []),
    ...(COLUMNS[kindId] ?? []).map((c) => ({
      id: c.id,
      label: c.label,
      render: (r: { row: ResourceRow }) =>
        c.id === 'status' ? (
          <span className={TONE[r.row.tone]}>{r.row.cells[c.id]}</span>
        ) : (
          (r.row.cells[c.id] ?? '')
        )
    })),
    {
      id: 'age',
      label: 'Age',
      align: 'right',
      sort: { key: 'age', label: 'Age', kind: 'date' },
      render: (r) => r.row.cells['age'] ?? ''
    }
  ]
  // Lớp tĩnh (Tailwind cần thấy nguyên chuỗi): cột tên + N cột phụ (cột cuối là tuổi).
  const gridClass =
    [
      'grid-cols-[minmax(10rem,2fr)_4rem]',
      'grid-cols-[minmax(10rem,2fr)_minmax(4rem,1fr)_4rem]',
      'grid-cols-[minmax(10rem,2fr)_repeat(2,minmax(4rem,1fr))_4rem]',
      'grid-cols-[minmax(10rem,2fr)_repeat(3,minmax(4rem,1fr))_4rem]',
      'grid-cols-[minmax(10rem,2fr)_repeat(4,minmax(4rem,1fr))_4rem]',
      'grid-cols-[minmax(10rem,2fr)_repeat(5,minmax(4rem,1fr))_4rem]'
    ][columns.length - 1] ?? 'grid-cols-[minmax(10rem,2fr)_repeat(5,minmax(4rem,1fr))_4rem]'

  const confirmDestructive = (obj: K8sObject, verb: string): boolean => {
    if (production) {
      const typed = window.prompt(
        `${verb} ${obj.metadata.name} in a production context?\nType the name to confirm:`
      )
      return typed === obj.metadata.name
    }
    return window.confirm(`${verb} ${obj.metadata.name}?`)
  }

  const scale = (obj: K8sObject, replicas: number): void => {
    if (!['deployments.apps', 'statefulsets.apps', 'replicasets.apps'].includes(kindId)) return
    if (production && !confirmDestructive(obj, `Scale to ${replicas}`)) return
    void run('Scale failed', () =>
      request({
        op: 'scale',
        kind: kindId as 'deployments.apps',
        namespace: obj.metadata.namespace ?? '',
        name: obj.metadata.name,
        replicas
      })
    )
  }

  const actions = (obj: K8sObject): MenuEntry[] => {
    const ns = obj.metadata.namespace
    const entries: MenuEntry[] = []
    if (kindId === 'pods' && ns) {
      const containers = a(o(obj.spec)['containers']).map((c) => s(c['name']))
      entries.push(
        {
          id: 'logs',
          label: 'Logs',
          icon: <FileText size={14} />,
          onSelect: () =>
            openPodLogs({
              ref: params.ref,
              ...(params.bastionHostId ? { bastionHostId: params.bastionHostId } : {}),
              namespace: ns,
              pod: obj.metadata.name,
              ...(containers[0] ? { container: containers[0] } : {})
            })
        },
        ...containers.map((c, i) => ({
          id: `shell-${c}`,
          label: containers.length > 1 ? `Shell in ${c}` : 'Open shell',
          icon: i === 0 ? <SquareTerminal size={14} /> : undefined,
          onSelect: () => {
            openPodShell(
              { ref: params.ref, namespace: ns, pod: obj.metadata.name, container: c },
              params.bastionHostId
            )
          }
        }))
      )
    }
    if ((kindId === 'pods' || kindId === 'services') && ns) {
      const ports =
        kindId === 'pods'
          ? a(o(obj.spec)['containers']).flatMap((c) =>
              a(c['ports']).map((p) => Number(p['containerPort']))
            )
          : a(o(obj.spec)['ports']).map((p) => Number(p['port']))
      entries.push({
        id: 'forward',
        label: 'Forward a port…',
        icon: <ArrowLeftRight size={14} />,
        onSelect: () => {
          setDialog({ kind: 'forward', target: obj, ports })
        }
      })
    }
    entries.push({
      id: 'yaml',
      label: 'View YAML',
      icon: <FileCode size={14} />,
      onSelect: () => {
        void request<string>({
          op: 'get',
          kind: kindId,
          ...(ns ? { namespace: ns } : {}),
          name: obj.metadata.name,
          format: 'yaml'
        }).then(
          (text) => {
            setDialog({ kind: 'yaml', title: obj.metadata.name, text })
          },
          (e: unknown) => {
            setNotice({ tone: 'danger', text: cleanError(e) })
          }
        )
      }
    })
    if (!readOnly) {
      if (kindId !== 'secrets')
        entries.push({
          id: 'edit',
          label: 'Edit in editor',
          icon: <Pencil size={14} />,
          onSelect: () => {
            void run('Edit failed', async () => {
              const localPath = await window.shellhouse.prepareRemoteEdit(
                `${obj.metadata.name}.${kindId}.yaml`
              )
              await request({
                op: 'edit',
                kind: kindId,
                ...(ns ? { namespace: ns } : {}),
                name: obj.metadata.name,
                localPath
              })
              await window.shellhouse.openInEditor(localPath)
              setNotice({
                tone: 'success',
                text: `Editing ${obj.metadata.name} — every save is applied to the cluster`
              })
            })
          }
        })
      if (['deployments.apps', 'statefulsets.apps', 'daemonsets.apps'].includes(kindId) && ns)
        entries.push({
          id: 'restart',
          label: 'Rollout restart',
          icon: <RotateCw size={14} />,
          onSelect: () => {
            if (!production || confirmDestructive(obj, 'Restart'))
              void run('Restart failed', () =>
                request({
                  op: 'rolloutRestart',
                  kind: kindId as 'deployments.apps',
                  namespace: ns,
                  name: obj.metadata.name
                })
              )
          }
        })
      if (kindId === 'deployments.apps' && ns) {
        const paused = o(obj.spec)['paused'] === true
        entries.push({
          id: 'pause',
          label: paused ? 'Resume rollout' : 'Pause rollout',
          icon: paused ? <Play size={14} /> : <Pause size={14} />,
          onSelect: () => {
            void run('Failed', () =>
              request({
                op: 'rolloutPause',
                namespace: ns,
                name: obj.metadata.name,
                paused: !paused
              })
            )
          }
        })
      }
      entries.push('separator', {
        id: 'delete',
        label: 'Delete',
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => {
          setDialog({ kind: 'delete', target: obj })
        }
      })
    }
    return entries
  }

  if (session.error)
    return (
      <div className="flex h-full items-center justify-center bg-canvas p-6" data-testid="k8s-view">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <Ship size={28} className="text-faint" />
          <p className="text-sm text-fg" data-testid="k8s-error">
            {session.error}
          </p>
          <Button size="sm" icon={<RefreshCw size={13} />} onClick={session.retry}>
            Try again
          </Button>
        </div>
      </div>
    )

  const visibleKinds = (kinds ?? BUILTIN_KINDS.map((k) => ({ ...k, forbidden: false }))).filter(
    (k) => !k.forbidden
  )
  const sections = [
    'Workloads',
    'Network',
    'Config',
    'Storage',
    'Cluster',
    'Custom resources'
  ] as const

  return (
    <div
      className="@container relative flex h-full bg-surface"
      data-testid="k8s-view"
      data-tab={tabId}
      data-ready={ready && objects !== null}
    >
      <nav
        className="flex w-44 shrink-0 flex-col overflow-auto border-r border-line bg-subtle p-2"
        data-testid="k8s-nav"
      >
        {sections.map((section) => {
          const items = visibleKinds.filter(
            (k) =>
              (BUILTIN_KINDS.find((b) => b.id === k.id)?.section ?? 'Custom resources') === section
          )
          if (items.length === 0) return null
          return (
            <div key={section} className="mb-2">
              <div className="px-2 pb-0.5 text-[10px] font-semibold tracking-wider text-faint uppercase">
                {section}
              </div>
              {items.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  data-testid={`k8s-nav-${k.id}`}
                  aria-current={kindId === k.id}
                  title={k.id}
                  className={cx(
                    'block w-full truncate rounded-md px-2 py-1 text-left text-[13px]',
                    kindId === k.id
                      ? 'bg-surface font-medium text-fg shadow-sm'
                      : 'text-muted hover:bg-hover hover:text-fg'
                  )}
                  onClick={() => {
                    setKindId(k.id)
                    setObjects(null)
                    setSelected(new Set())
                    setFilter('')
                  }}
                >
                  {BUILTIN_KINDS.find((b) => b.id === k.id)?.title ?? k.kind}
                </button>
              ))}
            </div>
          )
        })}
      </nav>
      {/* Container riêng: cột của bảng co giãn theo chỗ còn lại (khi có bảng chi tiết bên phải). */}
      <div className="@container flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
          <span
            className={cx(
              'size-2 shrink-0 rounded-full',
              entry?.settings.color ? COLOR_DOT[entry.settings.color] : 'bg-line-strong'
            )}
          />
          <span
            className="truncate text-[13px] font-medium text-fg"
            data-testid="k8s-context-label"
          >
            {params.label}
          </span>
          {cluster && (
            <span className="hidden text-xs text-faint @lg:inline">{cluster.version}</span>
          )}
          <NamespacePicker
            all={allNamespaces}
            value={namespaces ?? []}
            onChange={(v) => {
              setNamespaces(v)
              setObjects(null)
              setSelected(new Set())
            }}
          />
          <div className="flex h-7 w-44 items-center gap-1.5 rounded-md border border-line bg-subtle px-2">
            <Search size={13} className="text-faint" />
            <input
              ref={filterRef}
              type="search"
              placeholder="Filter… (Ctrl+K)"
              data-testid="k8s-filter"
              className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
              }}
            />
          </div>
          <div className="flex-1" />
          {readOnly && (
            <span
              className="flex items-center gap-1 rounded bg-warning-soft px-1.5 py-px text-xs font-medium text-warning"
              data-testid="k8s-read-only"
            >
              <Eye size={12} /> Read-only
            </span>
          )}
          <ToolButton
            icon={<ArrowLeftRight size={13} />}
            label={`Port forwards${forwards.length ? ` (${forwards.length})` : ''}`}
            labelAt="3xl"
            pressed={showForwards}
            testId="k8s-forwards-toggle"
            onClick={() => {
              setShowForwards(!showForwards)
            }}
          />
          <ToolButton
            icon={<RefreshCw size={13} />}
            label="Reload"
            labelAt="4xl"
            onClick={() => {
              setReloadKey((k) => k + 1)
            }}
          />
        </div>
        {(loadError ?? notice) && (
          <div className="border-b border-line p-2">
            <Notice tone={loadError ? 'danger' : (notice?.tone ?? 'danger')} testId="k8s-notice">
              {loadError ?? notice?.text}
            </Notice>
          </div>
        )}
        {!ready || objects === null ? (
          <div
            className="flex flex-1 items-center justify-center text-xs text-faint"
            data-testid="k8s-status"
          >
            {ready ? 'Loading…' : session.status}
          </div>
        ) : (
          <FileTable
            items={rows}
            getKey={(r) => r.row.key}
            icon={(r) => <Box size={14} className={TONE[r.row.tone]} />}
            columns={columns}
            gridClass={gridClass}
            nameSort={{ key: 'name', label: 'Name', kind: 'text' }}
            sort={sort}
            onSort={setSort}
            selected={selected}
            onSelect={setSelected}
            onOpen={(r) => {
              if (kindId === 'pods') {
                const first = actions(r.obj).find(
                  (e): e is Exclude<MenuEntry, 'separator'> => e !== 'separator' && e.id === 'logs'
                )
                first?.onSelect()
              }
            }}
            onContextMenu={(e, items) => {
              const first = items[0]
              if (first && items.length === 1) openMenu(e, actions(first.obj))
            }}
            ariaLabel={kind?.kind ?? 'Resources'}
            rowTestId="k8s-row"
          >
            {rows.length === 0 && (
              <Empty
                icon={<Box size={18} />}
                title={q ? 'Nothing matches' : 'Nothing here'}
                text={
                  q
                    ? 'Try another filter.'
                    : `No ${BUILTIN_KINDS.find((b) => b.id === kindId)?.title.toLowerCase() ?? 'resources'} in this namespace.`
                }
                action={null}
              />
            )}
          </FileTable>
        )}
        {showForwards && (
          <div
            className="max-h-44 shrink-0 overflow-auto border-t border-line p-2 text-xs"
            data-testid="k8s-forwards"
          >
            {forwards.length === 0 ? (
              <p className="text-faint">
                No port forwards. Right-click a pod or service → Forward a port.
              </p>
            ) : (
              forwards.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-2 py-0.5"
                  data-testid="k8s-forward"
                >
                  <span className="font-mono text-fg">localhost:{f.localPort}</span>
                  <span className="text-faint">→</span>
                  <span className="truncate text-muted">
                    {f.namespace}/{f.target}:{f.remotePort}
                  </span>
                  <span className="text-faint">{f.connections} open</span>
                  {f.error && <span className="truncate text-danger">{f.error}</span>}
                  <div className="flex-1" />
                  <button
                    type="button"
                    title="Copy address"
                    className="text-faint hover:text-fg"
                    onClick={() =>
                      void window.shellhouse.writeClipboard(`localhost:${f.localPort}`)
                    }
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    type="button"
                    title="Stop"
                    className="text-faint hover:text-danger"
                    onClick={() => void request({ op: 'portForward.stop', id: f.id })}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      {single && (
        <Describe
          key={single.row.key}
          obj={single.obj}
          kindId={kindId}
          readOnly={readOnly}
          request={request}
          actions={actions(single.obj)}
          onScale={(n) => {
            scale(single.obj, n)
          }}
        />
      )}
      {session.prompt && <ConnectionPrompt prompt={session.prompt} onAnswer={session.answer} />}
      {dialog?.kind === 'yaml' && (
        <Modal
          title={`YAML — ${dialog.title}`}
          width="max-w-3xl"
          onClose={() => {
            setDialog(null)
          }}
          testId="k8s-yaml"
        >
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-subtle p-3 font-mono text-xs text-fg select-text">
            {dialog.text}
          </pre>
        </Modal>
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog
          obj={dialog.target}
          production={production}
          onClose={() => {
            setDialog(null)
          }}
          onDelete={() => {
            const t = dialog.target
            setDialog(null)
            void run('Delete failed', () =>
              request({
                op: 'delete',
                kind: kindId,
                ...(t.metadata.namespace ? { namespace: t.metadata.namespace } : {}),
                name: t.metadata.name
              })
            )
          }}
        />
      )}
      {dialog?.kind === 'forward' && (
        <ForwardDialog
          obj={dialog.target}
          ports={dialog.ports}
          onClose={() => {
            setDialog(null)
          }}
          onForward={(local, remote) => {
            const t = dialog.target
            setDialog(null)
            setShowForwards(true)
            void run('Port forward failed', () =>
              request({
                op: 'portForward',
                namespace: t.metadata.namespace ?? '',
                target: `${kindId === 'pods' ? 'pod' : 'service'}/${t.metadata.name}`,
                ports: [[local, remote]]
              })
            )
          }}
        />
      )}
      {menu}
    </div>
  )
}

function NamespacePicker({
  all,
  value,
  onChange
}: {
  all: string[]
  value: string[]
  onChange: (v: string[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // Đóng khi bấm ra ngoài (không đóng theo di chuột — chọn nhiều namespace liên tiếp).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])
  const label =
    value.length === 0
      ? 'All namespaces'
      : value.length === 1
        ? value[0]
        : `${value.length} namespaces`
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        data-testid="k8s-namespace"
        className="h-7 max-w-44 truncate rounded-md border border-line bg-surface px-2 text-xs text-fg hover:border-line-strong"
        onClick={() => {
          setOpen(!open)
        }}
      >
        {label} ▾
      </button>
      {open && (
        <div
          className="absolute top-8 left-0 z-20 max-h-72 w-56 overflow-auto rounded-md border border-line bg-elevated p-1 shadow-lg"
          data-testid="k8s-namespace-menu"
        >
          <button
            type="button"
            className={cx(
              'block w-full rounded px-2 py-1 text-left text-xs hover:bg-hover',
              value.length === 0 && 'font-medium text-accent'
            )}
            onClick={() => {
              onChange([])
              setOpen(false)
            }}
          >
            All namespaces
          </button>
          {all.map((ns) => (
            <label
              key={ns}
              className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-hover"
            >
              <input
                type="checkbox"
                data-testid={`k8s-ns-${ns}`}
                checked={value.includes(ns)}
                onChange={(e) => {
                  onChange(e.target.checked ? [...value, ns] : value.filter((v) => v !== ns))
                }}
              />
              <span className="truncate">{ns}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

/** Trang chi tiết kiểu `kubectl describe` + thao tác nhanh. */
function Describe({
  obj,
  kindId,
  readOnly,
  request,
  actions,
  onScale
}: {
  obj: K8sObject
  kindId: string
  readOnly: boolean
  request: <T>(op: import('../shared/ops').K8sOp) => Promise<T>
  actions: MenuEntry[]
  onScale: (replicas: number) => void
}): React.JSX.Element {
  const [events, setEvents] = useState<K8sObject[] | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const ns = obj.metadata.namespace
  useEffect(() => {
    let cancelled = false
    request<{ items: K8sObject[] }>({
      op: 'list',
      kind: 'events',
      ...(ns ? { namespace: ns } : {}),
      fieldSelector: `involvedObject.name=${obj.metadata.name}`,
      limit: 50
    }).then(
      (r) => {
        if (!cancelled)
          setEvents(
            r.items.sort((x, y) => s(o(y)['lastTimestamp']).localeCompare(s(o(x)['lastTimestamp'])))
          )
      },
      () => {
        if (!cancelled) setEvents([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, ns, obj.metadata.name])
  const spec = o(obj.spec)
  const status = o(obj.status)
  const conditions = a(status['conditions'])
  const labels = Object.entries(obj.metadata.labels ?? {})
  const scalable = ['deployments.apps', 'statefulsets.apps', 'replicasets.apps'].includes(kindId)
  const replicas = Number(spec['replicas'] ?? 0)
  return (
    <aside
      className="hidden w-80 shrink-0 flex-col gap-3 overflow-auto border-l border-line p-3 text-xs @3xl:flex"
      data-testid="k8s-describe"
    >
      <div>
        <div className="truncate text-[13px] font-semibold text-fg">{obj.metadata.name}</div>
        <div className="text-faint">
          {obj.kind} {ns ? `· ${ns}` : ''} · {age(Date.parse(obj.metadata.creationTimestamp ?? ''))}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {actions
          .filter(
            (e): e is Exclude<MenuEntry, 'separator'> => e !== 'separator' && e.id !== 'delete'
          )
          .slice(0, 6)
          .map((e) => (
            <Button
              key={e.id}
              size="sm"
              variant="ghost"
              data-testid={`k8s-action-${e.id}`}
              onClick={e.onSelect}
            >
              {e.label}
            </Button>
          ))}
      </div>
      {scalable && (
        <div className="flex items-center gap-2" data-testid="k8s-scale">
          <span className="text-faint">Replicas</span>
          {!readOnly && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Scale down"
              disabled={replicas === 0}
              onClick={() => {
                onScale(replicas - 1)
              }}
            >
              <Minus size={12} />
            </Button>
          )}
          <span
            className="min-w-6 text-center font-medium text-fg tabular-nums"
            data-testid="k8s-replicas"
          >
            {replicas}
          </span>
          {!readOnly && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Scale up"
              data-testid="k8s-scale-up"
              onClick={() => {
                onScale(replicas + 1)
              }}
            >
              <Plus size={12} />
            </Button>
          )}
        </div>
      )}
      {labels.length > 0 && (
        <div>
          <div className="mb-1 font-semibold text-muted">Labels</div>
          <div className="flex flex-wrap gap-1">
            {labels.map(([k, v]) => (
              <span key={k} className="rounded bg-subtle px-1 font-mono text-[11px] text-muted">
                {k}={v}
              </span>
            ))}
          </div>
        </div>
      )}
      {kindId === 'pods' && (
        <div>
          <div className="mb-1 font-semibold text-muted">Containers</div>
          {a(spec['containers']).map((c) => {
            const st = a(status['containerStatuses']).find((x) => x['name'] === c['name'])
            const state = Object.keys(o(st?.['state']))[0] ?? 'unknown'
            return (
              <div key={s(c['name'])} className="mb-1">
                <div className="font-medium text-fg">
                  {s(c['name'])}{' '}
                  <span className="text-faint">
                    · {state}
                    {st ? ` · ${s(st['restartCount'])} restarts` : ''}
                  </span>
                </div>
                <div className="truncate font-mono text-[11px] text-faint">{s(c['image'])}</div>
              </div>
            )
          })}
        </div>
      )}
      {kindId === 'secrets' && (
        <div data-testid="k8s-secret-keys">
          <div className="mb-1 font-semibold text-muted">Data</div>
          {Object.keys(obj.data ?? {}).map((key) => (
            <div key={key} className="flex items-center gap-2 py-0.5">
              <span className="font-mono text-fg">{key}</span>
              <div className="flex-1" />
              {revealed[key] !== undefined ? (
                <span
                  className="max-w-40 truncate font-mono text-muted select-text"
                  data-testid="k8s-secret-value"
                >
                  {revealed[key]}
                </span>
              ) : (
                <button
                  type="button"
                  className="text-accent hover:underline"
                  data-testid="k8s-secret-reveal"
                  onClick={() => {
                    if (!ns) return
                    void request<string>({
                      op: 'secret.reveal',
                      namespace: ns,
                      name: obj.metadata.name,
                      key
                    }).then((v) => {
                      setRevealed((r) => ({ ...r, [key]: v }))
                    })
                  }}
                >
                  Reveal
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {conditions.length > 0 && (
        <div>
          <div className="mb-1 font-semibold text-muted">Conditions</div>
          {conditions.map((c) => (
            <div key={s(c['type'])} className="flex gap-2">
              <span className={c['status'] === 'True' ? 'text-success' : 'text-warning'}>
                {s(c['status']) === 'True' ? '✓' : '✗'}
              </span>
              <span className="text-fg">{s(c['type'])}</span>
              <span className="truncate text-faint">{s(c['reason'])}</span>
            </div>
          ))}
        </div>
      )}
      <div data-testid="k8s-events">
        <div className="mb-1 font-semibold text-muted">Events</div>
        {events === null ? (
          <p className="text-faint">Loading…</p>
        ) : events.length === 0 ? (
          <p className="text-faint">No recent events.</p>
        ) : (
          events.slice(0, 20).map((e) => (
            <div key={e.metadata.name} className="mb-1">
              <span className={o(e)['type'] === 'Warning' ? 'text-warning' : 'text-muted'}>
                {s(o(e)['reason'])}
              </span>{' '}
              <span className="text-fg">{s(o(e)['message'])}</span>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

function DeleteDialog({
  obj,
  production,
  onClose,
  onDelete
}: {
  obj: K8sObject
  production: boolean
  onClose: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const ok = !production || typed === obj.metadata.name
  return (
    <Modal
      title={`Delete ${obj.kind ?? ''} ${obj.metadata.name}?`}
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
            Delete
          </Button>
        </>
      }
    >
      {production ? (
        <div className="flex flex-col gap-2 text-[13px]">
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
        </div>
      ) : (
        <p className="text-[13px] text-muted">
          {obj.metadata.namespace ? `Namespace ${obj.metadata.namespace}. ` : ''}This cannot be
          undone.
        </p>
      )}
    </Modal>
  )
}

function ForwardDialog({
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
            onClick={() => {
              onForward(l, r)
            }}
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
              onChange={(e) => {
                setRemote(e.target.value)
              }}
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
              onChange={(e) => {
                setRemote(e.target.value)
              }}
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
            onChange={(e) => {
              setLocal(e.target.value)
            }}
          />
        </label>
      </div>
    </Modal>
  )
}
