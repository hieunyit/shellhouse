import { useEffect, useState } from 'react'
import { Package, X } from 'lucide-react'
import { FileTable } from '../../../renderer/src/components/files/FileTable'
import { Empty } from '../../../renderer/src/components/files/parts'
import {
  DefList,
  Heading,
  Pill,
  TabStrip,
  SidePanel,
  type Tone
} from '../../../renderer/src/components/panels'
import type { SortState } from '../../../renderer/src/components/SortMenu'
import { cleanError } from '../../../renderer/src/lib/format'
import type { HelmRelease, HelmReleaseDetail, K8sOp } from '../shared/ops'
import { age } from '../shared/resources'

type Request = <T>(op: K8sOp) => Promise<T>

/** Trạng thái Helm → màu (deployed xanh, failed đỏ, pending-* vàng). */
export function helmTone(status: string): Tone {
  if (status === 'deployed') return 'ok'
  if (status === 'failed') return 'bad'
  if (status.startsWith('pending') || status === 'uninstalling') return 'warn'
  return 'muted'
}

const key = (r: HelmRelease): string => `${r.namespace}/${r.name}`

/**
 * Helm releases (như Lens / "Installed Apps" của Rancher): đọc Secret của Helm 3 — không cần cài
 * helm. Bấm một release → chart, trạng thái, notes, values, manifest, lịch sử revision.
 */
export function HelmView({
  request,
  namespaces,
  active,
  filter
}: {
  request: Request
  namespaces: readonly string[]
  active: boolean
  filter: string
}): React.JSX.Element {
  const [releases, setReleases] = useState<HelmRelease[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [open, setOpen] = useState<HelmRelease | null>(null)
  const [sort, setSort] = useState<SortState<'name' | 'updated'>>({ key: 'name', dir: 'asc' })
  const nsKey = namespaces.join(',')

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const load = (): void => {
      request<HelmRelease[]>({
        op: 'helm.releases',
        namespaces: nsKey ? nsKey.split(',') : []
      }).then(
        (r) => {
          if (cancelled) return
          setReleases(r)
          setError(null)
        },
        (e: unknown) => {
          if (!cancelled) setError(cleanError(e))
        }
      )
    }
    load()
    const t = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [request, nsKey, active])

  const q = filter.trim().toLowerCase()
  const dir = sort.dir === 'asc' ? 1 : -1
  const rows = (releases ?? [])
    .filter(
      (r) =>
        !q ||
        r.name.toLowerCase().includes(q) ||
        r.chart.toLowerCase().includes(q) ||
        r.namespace.includes(q) ||
        r.status.includes(q)
    )
    .sort((a, b) =>
      sort.key === 'updated' ? (a.updated - b.updated) * dir : key(a).localeCompare(key(b)) * dir
    )
  const multiNs = namespaces.length !== 1

  return (
    <div className="flex min-h-0 flex-1" data-testid="k8s-helm">
      <div className="flex min-w-0 flex-1 flex-col">
        {error && <p className="border-b border-line p-2 text-xs text-danger">{error}</p>}
        {releases === null && !error ? (
          <div className="flex flex-1 items-center justify-center text-xs text-faint">
            Loading Helm releases…
          </div>
        ) : (
          <FileTable
            items={rows}
            getKey={key}
            getLabel={(r) => r.name}
            icon={() => <Package size={14} className="text-muted" />}
            columns={[
              ...(multiNs && !open
                ? [{ id: 'ns', label: 'Namespace', render: (r: HelmRelease) => r.namespace }]
                : []),
              ...(open
                ? []
                : [
                    {
                      id: 'chart',
                      label: 'Chart',
                      render: (r: HelmRelease) =>
                        `${r.chart}${r.chartVersion ? `-${r.chartVersion}` : ''}`
                    },
                    { id: 'app', label: 'App version', render: (r: HelmRelease) => r.appVersion }
                  ]),
              {
                id: 'status',
                label: 'Status',
                render: (r: HelmRelease) => <Pill tone={helmTone(r.status)}>{r.status}</Pill>
              },
              ...(open
                ? []
                : [
                    {
                      id: 'rev',
                      label: 'Revision',
                      align: 'right' as const,
                      render: (r: HelmRelease) => r.revision
                    }
                  ]),
              {
                id: 'updated',
                label: 'Updated',
                align: 'right' as const,
                sort: { key: 'updated' as const, label: 'Updated', kind: 'date' as const },
                render: (r: HelmRelease) => age(r.updated)
              }
            ]}
            gridClass={
              open
                ? 'grid-cols-[minmax(8rem,2fr)_8rem_5rem]'
                : multiNs
                  ? 'grid-cols-[minmax(10rem,2fr)_minmax(6rem,1fr)_minmax(8rem,1.5fr)_6rem_8rem_4.5rem_5rem]'
                  : 'grid-cols-[minmax(10rem,2fr)_minmax(8rem,1.5fr)_6rem_8rem_4.5rem_5rem]'
            }
            nameSort={{ key: 'name', label: 'Name', kind: 'text' }}
            sort={sort}
            onSort={setSort}
            selected={selected}
            onSelect={(sel) => {
              setSelected(sel)
              const one = sel.size === 1 ? rows.find((r) => sel.has(key(r))) : undefined
              if (one) setOpen(one)
            }}
            onOpen={setOpen}
            ariaLabel="Helm releases"
            rowTestId="k8s-helm-release"
          >
            {rows.length === 0 && (
              <Empty
                icon={<Package size={18} />}
                title={q ? 'Nothing matches' : 'No Helm releases'}
                text={
                  q
                    ? 'Try another filter.'
                    : 'Charts installed with Helm 3 (helm install, Rancher apps…) show up here.'
                }
                action={null}
              />
            )}
          </FileTable>
        )}
      </div>
      {open && (
        <HelmDetail
          key={key(open)}
          release={open}
          request={request}
          onClose={() => {
            setOpen(null)
            setSelected(new Set())
          }}
        />
      )}
    </div>
  )
}

type Tab = 'overview' | 'values' | 'manifest' | 'history'

function HelmDetail({
  release,
  request,
  onClose
}: {
  release: HelmRelease
  request: Request
  onClose: () => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<HelmReleaseDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  useEffect(() => {
    let cancelled = false
    request<HelmReleaseDetail>({
      op: 'helm.release',
      namespace: release.namespace,
      name: release.name
    }).then(
      (d) => {
        if (!cancelled) setDetail(d)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, release.namespace, release.name])
  const d = detail ?? { ...release, values: '', notes: '', manifest: '', history: [] }
  return (
    <SidePanel storageKey="k8s-helm" defaultWidth={448} testId="k8s-helm-detail">
      <div className="flex items-start gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg">{release.name}</span>
            <Pill tone={helmTone(release.status)}>{release.status}</Pill>
          </div>
          <div className="truncate text-xs text-faint">
            Helm release · {release.namespace} · revision {release.revision}
          </div>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      <TabStrip<Tab>
        value={tab}
        onChange={setTab}
        testIdPrefix="k8s-helm-tab"
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'values', label: 'Values' },
          { id: 'manifest', label: 'Manifest' },
          { id: 'history', label: 'History', count: d.history.length || undefined }
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error && <p className="mb-2 text-xs text-danger">{error}</p>}
        {tab === 'overview' && (
          <div className="flex flex-col gap-4">
            <DefList
              items={[
                ['Chart', `${d.chart}${d.chartVersion ? ` ${d.chartVersion}` : ''}`],
                ['App version', d.appVersion || '—'],
                [
                  'Status',
                  <Pill key="s" tone={helmTone(d.status)}>
                    {d.status}
                  </Pill>
                ],
                ['Revision', String(d.revision)],
                ['Updated', d.updated ? new Date(d.updated).toLocaleString() : '—'],
                ['Description', d.description || '—']
              ]}
            />
            {d.notes && (
              <section>
                <Heading>Notes</Heading>
                <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg select-text">
                  {d.notes}
                </pre>
              </section>
            )}
          </div>
        )}
        {tab === 'values' && (
          <>
            <p className="mb-2 text-xs text-muted">
              Values set for this release (helm get values). They may contain passwords.
            </p>
            <Code
              text={
                detail ? d.values || '# No values set — the chart defaults are used.' : 'Loading…'
              }
            />
          </>
        )}
        {tab === 'manifest' && <Code text={detail ? d.manifest : 'Loading…'} />}
        {tab === 'history' && (
          <div className="flex flex-col text-xs" data-testid="k8s-helm-history">
            {d.history.map((h) => (
              <div
                key={h.revision}
                className="flex items-center gap-2 border-b border-line py-1.5 last:border-0"
              >
                <span className="w-8 shrink-0 text-right font-mono text-muted">{h.revision}</span>
                <Pill tone={helmTone(h.status)}>{h.status}</Pill>
                <span className="min-w-0 flex-1 truncate text-fg" title={h.description}>
                  {h.chart}-{h.chartVersion}
                  <span className="ml-2 text-faint">{h.description}</span>
                </span>
                <span className="shrink-0 text-faint">{age(h.updated)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </SidePanel>
  )
}

function Code({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className="overflow-auto font-mono text-[11px] leading-relaxed text-fg select-text">
      {text}
    </pre>
  )
}
