import { mapKnown, type MapCoverage, type MapData } from './map'

export interface SnapshotResource {
  kind: string
  ns: string
  name: string
  fields: Record<string, string>
}
export interface TopologySnapshot {
  version: 1
  id: string
  at: number
  label: string
  cluster: string
  scope: string[]
  coverage: MapCoverage[]
  resources: SnapshotResource[]
}
export interface TopologyChange {
  resource: SnapshotResource
  type: 'added' | 'removed' | 'changed' | 'unknown'
  fields: { field: string; before?: string; after?: string }[]
}

/** Stable config only: excludes runtime status, object versions and all Secret values. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return value === undefined ? 'null' : JSON.stringify(value)
}

export function captureTopology(
  data: MapData,
  cluster: string,
  label: string,
  at = Date.now()
): TopologySnapshot {
  const resources: SnapshotResource[] = []
  const add = (kind: string, ns: string, name: string, fields: Record<string, unknown>): void => {
    resources.push({
      kind,
      ns,
      name,
      fields: Object.fromEntries(
        Object.entries(fields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, canonical(v)])
      )
    })
  }
  for (const w of data.workloads)
    add(w.kind, w.ns, w.name, {
      images: w.images,
      labels: w.labels,
      ports: w.ports ?? [],
      replicas: w.desired,
      dependencies: {
        configMaps: w.configMaps ?? [],
        secrets: w.secrets ?? [],
        pvcs: w.pvcs,
        serviceAccount: w.serviceAccount
      }
    })
  for (const s of data.services)
    add('services', s.ns, s.name, {
      type: s.type,
      selector: s.selector,
      ports: s.portList ?? [],
      externalName: s.externalName ?? '',
      clusterIP: s.clusterIP ?? ''
    })
  for (const r of data.routes)
    add(r.kind, r.ns, r.name, {
      hosts: r.hosts,
      rules: r.rules ?? [],
      backends: r.backends,
      parents: r.parents ?? [],
      tls: r.tls ?? [],
      className: r.className ?? ''
    })
  for (const p of data.policies)
    add('networkpolicies.networking.k8s.io', p.ns, p.name, {
      selector: p.selector,
      types: p.types,
      rules: p.rules
    })
  for (const p of data.pvcs)
    add('persistentvolumeclaims', p.ns, p.name, { storageClass: p.storageClass, volume: p.volume })
  for (const g of data.gateways ?? [])
    add('gateways.gateway.networking.k8s.io', g.ns, g.name, {
      className: g.className,
      listeners: g.listeners
    })
  const scope = [...(data.scope ?? [])].sort()
  return {
    version: 1,
    id: `${String(at)}-${Math.random().toString(36).slice(2, 10)}`,
    at,
    label: label.trim().slice(0, 120),
    cluster,
    scope,
    coverage: data.coverage ?? (data.truncated ? [{ kind: '*', reason: 'truncated' }] : []),
    resources: resources.sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)))
  }
}

const resourceKey = (r: SnapshotResource): string => `${r.kind}|${r.ns}|${r.name}`
function known(snapshot: TopologySnapshot, kind: string, ns: string): boolean {
  return (
    !snapshot.coverage.some((c) => c.kind === '*') &&
    mapKnown(
      { coverage: snapshot.coverage, scope: snapshot.scope, truncated: false } as MapData,
      kind,
      ns
    )
  )
}

export function compareTopology(
  before: TopologySnapshot,
  after: TopologySnapshot
): TopologyChange[] {
  if (before.cluster !== after.cluster || canonical(before.scope) !== canonical(after.scope))
    throw new Error('Snapshots must belong to the same cluster and namespace scope.')
  const old = new Map(before.resources.map((r) => [resourceKey(r), r]))
  const current = new Map(after.resources.map((r) => [resourceKey(r), r]))
  const changes: TopologyChange[] = []
  for (const key of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    const a = old.get(key)
    const b = current.get(key)
    const r = b ?? a
    if (!r) continue
    if (!a || !b) {
      changes.push({
        resource: r,
        type: known(a ? after : before, r.kind, r.ns) ? (a ? 'removed' : 'added') : 'unknown',
        fields: []
      })
      continue
    }
    const fields = [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])]
      .sort()
      .filter((f) => a.fields[f] !== b.fields[f])
      .map((field) => ({
        field,
        ...(a.fields[field] !== undefined ? { before: a.fields[field] } : {}),
        ...(b.fields[field] !== undefined ? { after: b.fields[field] } : {})
      }))
    if (fields.length)
      changes.push({
        resource: r,
        type: fields.some((f) => f.before === undefined || f.after === undefined)
          ? 'unknown'
          : 'changed',
        fields
      })
  }
  return changes
}

/** Bounded local history. Storage errors must be shown to the user, not silently ignored. */
export const SNAPSHOTS_KEY = 'shellhouse.k8s.topology-snapshots.v1'
export const MAX_SNAPSHOTS = 8
export const MAX_SNAPSHOT_BYTES = 2_000_000
export function readSnapshots(storage: Pick<Storage, 'getItem'>): TopologySnapshot[] {
  const raw = storage.getItem(SNAPSHOTS_KEY)
  if (!raw) return []
  if (new TextEncoder().encode(raw).byteLength > MAX_SNAPSHOT_BYTES)
    throw new Error('Stored topology snapshots exceed the size limit.')
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || !value.every(validSnapshot))
    throw new Error('Stored topology snapshots are invalid.')
  return value as TopologySnapshot[]
}
function validSnapshot(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<TopologySnapshot>
  return (
    s.version === 1 &&
    typeof s.id === 'string' &&
    typeof s.cluster === 'string' &&
    typeof s.label === 'string' &&
    typeof s.at === 'number' &&
    Number.isFinite(s.at) &&
    Array.isArray(s.scope) &&
    s.scope.every((x: unknown) => typeof x === 'string') &&
    Array.isArray(s.coverage) &&
    s.coverage.every((c: unknown) =>
      Boolean(
        c &&
        typeof c === 'object' &&
        typeof (c as MapCoverage).kind === 'string' &&
        ['forbidden', 'missing-api', 'truncated', 'error'].includes((c as MapCoverage).reason) &&
        ((c as MapCoverage).namespace === undefined ||
          typeof (c as MapCoverage).namespace === 'string')
      )
    ) &&
    Array.isArray(s.resources) &&
    s.resources.every((r: unknown) => {
      if (!r || typeof r !== 'object') return false
      const row = r as SnapshotResource
      const fields: unknown = row.fields
      return (
        typeof row.kind === 'string' &&
        typeof row.ns === 'string' &&
        typeof row.name === 'string' &&
        fields !== null &&
        typeof fields === 'object' &&
        !Array.isArray(fields) &&
        Object.values(fields).every((x) => typeof x === 'string')
      )
    })
  )
}
export function writeSnapshots(
  storage: Pick<Storage, 'setItem'>,
  snapshots: readonly TopologySnapshot[]
): void {
  const raw = JSON.stringify(snapshots)
  if (new TextEncoder().encode(raw).byteLength > MAX_SNAPSHOT_BYTES)
    throw new Error('Topology snapshots exceed local storage size limit. Delete an older snapshot.')
  storage.setItem(SNAPSHOTS_KEY, raw)
}
