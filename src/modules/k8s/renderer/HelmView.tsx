import { useEffect, useState } from 'react'
import { Package } from 'lucide-react'
import { FileTable } from '../../../renderer/src/components/files/FileTable'
import { Empty } from '../../../renderer/src/components/files/parts'
import { Notice } from '../../../renderer/src/components/ui'
import { Pill } from '../../../renderer/src/components/panels'
import type { SortState } from '../../../renderer/src/components/SortMenu'
import { cleanError } from '../../../renderer/src/lib/format'
import type { HelmRelease, K8sOp } from '../shared/ops'
import { HelmDetail, helmTone } from './HelmDetail'
import { age } from '../shared/resources'
import { t } from '../../registry/renderer-kit'

type Request = <T>(op: K8sOp) => Promise<T>

export { helmTone }

const key = (r: HelmRelease): string => `${r.namespace}/${r.name}`

/**
 * Helm releases (như Lens / "Installed Apps" của Rancher): đọc Secret của Helm 3 — không cần cài
 * helm. Bấm một release → chart, trạng thái, notes, values, manifest, lịch sử revision.
 */
export function HelmView({
  request,
  namespaces,
  active,
  filter,
  readOnly
}: {
  request: Request
  namespaces: readonly string[]
  active: boolean
  filter: string
  readOnly: boolean
}): React.JSX.Element {
  /** Tăng sau rollback / uninstall → tải lại ngay. */
  const [reload, setReload] = useState(0)
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
    const timer = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [request, nsKey, active, reload])

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
        {error && (
          <div className="border-b border-line p-2">
            <Notice tone="danger">{error}</Notice>
          </div>
        )}
        {releases === null && !error ? (
          <div className="flex flex-1 items-center justify-center text-xs text-faint">
            {t('Loading Helm releases…')}
          </div>
        ) : (
          <FileTable
            items={rows}
            getKey={key}
            getLabel={(r) => r.name}
            icon={() => <Package size={14} className="text-muted" />}
            columns={[
              ...(multiNs && !open
                ? [{ id: 'ns', label: t('Namespace'), render: (r: HelmRelease) => r.namespace }]
                : []),
              ...(open
                ? []
                : [
                    {
                      id: 'chart',
                      label: t('Chart'),
                      render: (r: HelmRelease) =>
                        `${r.chart}${r.chartVersion ? `-${r.chartVersion}` : ''}`
                    },
                    { id: 'app', label: t('App version'), render: (r: HelmRelease) => r.appVersion }
                  ]),
              {
                id: 'status',
                label: t('Status'),
                render: (r: HelmRelease) => <Pill tone={helmTone(r.status)}>{r.status}</Pill>
              },
              ...(open
                ? []
                : [
                    {
                      id: 'rev',
                      label: t('Revision'),
                      align: 'right' as const,
                      render: (r: HelmRelease) => r.revision
                    }
                  ]),
              {
                id: 'updated',
                label: t('Updated'),
                align: 'right' as const,
                sort: { key: 'updated' as const, label: t('Updated'), kind: 'date' as const },
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
            nameSort={{ key: 'name', label: t('Name'), kind: 'text' }}
            sort={sort}
            onSort={setSort}
            selected={selected}
            onSelect={(sel) => {
              setSelected(sel)
              const one = sel.size === 1 ? rows.find((r) => sel.has(key(r))) : undefined
              if (one) setOpen(one)
            }}
            onOpen={setOpen}
            ariaLabel={t('Helm releases')}
            rowTestId="k8s-helm-release"
          >
            {rows.length === 0 && (
              <Empty
                icon={<Package size={18} />}
                title={q ? t('Nothing matches') : t('No Helm releases')}
                text={
                  q
                    ? t('Try another filter.')
                    : t('Charts installed with Helm 3 (helm install, Rancher apps…) show up here.')
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
          readOnly={readOnly}
          onClose={() => {
            setOpen(null)
            setSelected(new Set())
          }}
          onChanged={() => {
            setReload((n) => n + 1)
          }}
        />
      )}
    </div>
  )
}
