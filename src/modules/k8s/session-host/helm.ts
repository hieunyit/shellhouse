import { gzipSync } from 'node:zlib'
import { stringify as toYamlText } from 'yaml'
import { t } from '@shared/i18n'
import { parseManifest, type ManifestObject } from '../shared/helm'
import type { HelmActionResult, HelmRevisionDetail } from '../shared/ops'
import { resourcePath, type K8sObject, type ResourceKind } from '../shared/resources'
import { KubeError, type KubeClient } from './client'
import {
  decodeHelmRelease,
  helmSecrets,
  summary,
  type HelmRecord,
  type HelmSecret
} from './operations'

/**
 * Helm 3 không cần cài helm (ADR-014 mục 7.4): đọc / ghi bản ghi release trong Secret
 * `sh.helm.release.v1.<tên>.v<revision>` (owner=helm, type helm.sh/release.v1) đúng định dạng của
 * Helm — helm CLI đọc lại được bình thường.
 *
 * Rollback / uninstall làm như `helm rollback|uninstall --no-hooks`: không chạy hook (Job…) của chart.
 * Upgrade cần render chart (template Go + Sprig) → không làm ở đây (cần helm CLI).
 */

const sig = (signal?: AbortSignal): { signal?: AbortSignal } => (signal ? { signal } : {})
const ns = (n: string): string => `/namespaces/${encodeURIComponent(n)}`
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const HELM_FIELD_MANAGER = 'helm'
export const RESOURCE_POLICY = 'helm.sh/resource-policy'

type FindKind = (apiVersion: string, kind: string) => Promise<ResourceKind | undefined>

interface ReleaseEntry {
  secret: HelmSecret
  record: HelmRecord
  version: number
}

/** Secret của Helm: data.release = base64(base64(gzip(JSON))) — ngược với decodeHelmRelease. */
export function encodeHelmRelease(record: HelmRecord): string {
  const inner = gzipSync(Buffer.from(JSON.stringify(record), 'utf8')).toString('base64')
  return Buffer.from(inner, 'utf8').toString('base64')
}

export function releaseSecretName(name: string, version: number): string {
  return `sh.helm.release.v1.${name}.v${String(version)}`
}

/** Mọi revision của release (mới nhất trước). */
async function releaseEntries(
  client: KubeClient,
  namespace: string,
  name: string,
  signal?: AbortSignal
): Promise<ReleaseEntry[]> {
  const secrets = await helmSecrets(client, [namespace], `owner=helm,name=${name}`, signal)
  const out: ReleaseEntry[] = []
  for (const secret of secrets) {
    const data = secret.data?.['release']
    if (!data) continue
    let record: HelmRecord
    try {
      record = decodeHelmRelease(data)
    } catch {
      continue
    }
    out.push({ secret, record, version: summary(record, secret).revision })
  }
  if (out.length === 0) throw new Error(t('Helm release {name} was not found', { name }))
  return out.sort((a, b) => b.version - a.version)
}

/** Values: con ghi đè cha (map gộp sâu); null = bỏ khoá — như coalesce của Helm. */
export function coalesceValues(
  base: Record<string, unknown> | null | undefined,
  override: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const isMap = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  const out = new Map<string, unknown>(Object.entries(base ?? {}))
  for (const [k, v] of Object.entries(override ?? {})) {
    const prev = out.get(k)
    if (v === null) out.delete(k)
    else if (isMap(v) && isMap(prev)) out.set(k, coalesceValues(prev, v))
    else out.set(k, v)
  }
  return Object.fromEntries(out)
}

const yamlOf = (v: Record<string, unknown> | null | undefined): string =>
  v && Object.keys(v).length ? toYamlText(v) : ''

/** Một revision: values người dùng / values gộp, manifest, hook (helm get all --revision N). */
export async function helmRevision(
  client: KubeClient,
  namespace: string,
  name: string,
  revision: number,
  signal?: AbortSignal
): Promise<HelmRevisionDetail> {
  let secret: HelmSecret | null = await client
    .json<HelmSecret>(
      'GET',
      `/api/v1${ns(namespace)}/secrets/${encodeURIComponent(releaseSecretName(name, revision))}`,
      sig(signal)
    )
    .catch((error: unknown) => {
      if (error instanceof KubeError && error.status === 404) return null
      throw error
    })
  if (!secret) {
    // Tên Secret khác chuẩn (hiếm): tìm theo nhãn.
    const list = await helmSecrets(
      client,
      [namespace],
      `owner=helm,name=${name},version=${String(revision)}`,
      signal
    )
    secret = list[0] ?? null
  }
  const data = secret?.data?.['release']
  if (!secret || !data)
    throw new Error(t('Revision {revision} of {name} was not found', { revision, name }))
  const record = decodeHelmRelease(data)
  const s = summary(record, secret)
  return {
    revision: s.revision,
    status: s.status,
    chart: s.chart,
    chartVersion: s.chartVersion,
    appVersion: s.appVersion,
    updated: s.updated,
    description: s.description,
    values: yamlOf(record.config),
    computedValues: yamlOf(coalesceValues(record.chart?.values, record.config)),
    manifest: record.manifest ?? '',
    notes: record.info?.notes ?? '',
    hooks: (record.hooks ?? []).map((h) => ({
      name: h.name ?? '',
      kind: h.kind ?? '',
      events: h.events ?? []
    }))
  }
}

/** Đối tượng trong manifest → đường dẫn API (namespace của release nếu loại có namespace). */
async function locate(
  m: ManifestObject,
  releaseNamespace: string,
  findKind: FindKind
): Promise<{ kind: ResourceKind; namespace: string | undefined; label: string }> {
  const kind = await findKind(m.obj.apiVersion ?? '', m.obj.kind ?? '')
  if (!kind)
    throw new Error(
      t('unknown kind {kind} ({apiVersion})', {
        kind: m.obj.kind ?? '?',
        apiVersion: m.obj.apiVersion ?? '?'
      })
    )
  const namespace = kind.namespaced ? (m.obj.metadata.namespace ?? releaseNamespace) : undefined
  return { kind, namespace, label: namespace ? `${namespace}/${m.label}` : m.label }
}

interface ManagedField {
  manager?: string
  operation?: string
  subresource?: string
  [key: string]: unknown
}

/**
 * Trường do Helm 3 ghi (client-side, manager "helm" kiểu Update) → chuyển thành kiểu Apply (như
 * csaupgrade của client-go) để server-side apply sau đó gỡ được trường không còn trong manifest
 * đích — đúng như 3-way merge của helm rollback. Không làm được (xung đột…) thì bỏ qua.
 */
async function adoptHelmFields(
  client: KubeClient,
  path: string,
  live: K8sObject,
  signal?: AbortSignal
): Promise<void> {
  const fields = (live.metadata as { managedFields?: ManagedField[] }).managedFields
  if (!fields?.length) return
  const isHelm = (f: ManagedField): boolean => f.manager === HELM_FIELD_MANAGER && !f.subresource
  if (fields.some((f) => isHelm(f) && f.operation === 'Apply')) return
  const updates = fields.filter((f) => isHelm(f) && f.operation === 'Update')
  if (updates.length !== 1) return
  const next = fields.map((f) => (updates.includes(f) ? { ...f, operation: 'Apply' } : f))
  await client
    .json('PATCH', path, {
      body: {
        metadata: { resourceVersion: live.metadata.resourceVersion, managedFields: next }
      },
      contentType: 'application/merge-patch+json',
      ...sig(signal)
    })
    .catch(() => undefined)
}

async function getLive(
  client: KubeClient,
  path: string,
  signal?: AbortSignal
): Promise<K8sObject | null> {
  return client.json<K8sObject>('GET', path, sig(signal)).catch((error: unknown) => {
    if (error instanceof KubeError && error.status === 404) return null
    throw error
  })
}

/** Nhãn / annotation Helm gắn vào mọi tài nguyên của release (setMetadataVisitor). */
function withReleaseMetadata(o: K8sObject, release: string, namespace: string): K8sObject {
  const copy = structuredClone(o)
  copy.metadata.labels = { ...copy.metadata.labels, 'app.kubernetes.io/managed-by': 'Helm' }
  copy.metadata.annotations = {
    ...copy.metadata.annotations,
    'meta.helm.sh/release-name': release,
    'meta.helm.sh/release-namespace': namespace
  }
  return copy
}

// ——— Ghi bản ghi release ———

const unixNow = (): string => String(Math.floor(Date.now() / 1000))

function recordSecret(
  base: HelmSecret,
  record: HelmRecord,
  name: string,
  namespace: string,
  version: number,
  status: string
): HelmSecret & { apiVersion: string; kind: string } {
  const labels: Record<string, string> = { ...base.metadata.labels }
  delete labels['modifiedAt']
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'helm.sh/release.v1',
    metadata: {
      name: releaseSecretName(name, version),
      namespace,
      labels: {
        ...labels,
        name,
        owner: 'helm',
        status,
        version: String(version),
        createdAt: unixNow()
      }
    },
    data: { release: encodeHelmRelease(record) }
  }
}

/** Ghi lại bản ghi (đổi trạng thái…) — PUT có resourceVersion; xung đột → đọc lại, thử một lần nữa. */
async function updateRecord(
  client: KubeClient,
  entry: ReleaseEntry,
  namespace: string,
  signal?: AbortSignal
): Promise<void> {
  const path = `/api/v1${ns(namespace)}/secrets/${encodeURIComponent(entry.secret.metadata.name)}`
  for (let attempt = 0; ; attempt++) {
    const live =
      attempt === 0 ? entry.secret : await client.json<HelmSecret>('GET', path, sig(signal))
    const status = entry.record.info?.status ?? 'unknown'
    const body = {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'helm.sh/release.v1',
      metadata: {
        ...live.metadata,
        labels: { ...live.metadata.labels, status, modifiedAt: unixNow() }
      },
      data: { ...live.data, release: encodeHelmRelease(entry.record) }
    }
    try {
      await client.json('PUT', path, { body, ...sig(signal) })
      return
    } catch (error) {
      if (attempt === 0 && error instanceof KubeError && error.status === 409) continue
      throw error
    }
  }
}

function assertIdle(entry: ReleaseEntry, name: string): void {
  const status = entry.record.info?.status ?? ''
  if (status.startsWith('pending-'))
    throw new Error(
      t('Another operation ({status}) is in progress on {name} — try again when it finishes', {
        status,
        name
      })
    )
}

/**
 * `helm rollback <tên> <revision> --no-hooks`: revision mới (= mới nhất + 1) mang manifest / values
 * / chart của revision đích; tài nguyên được server-side apply (manager "helm", force — như Helm
 * ghi đè thay đổi tay); tài nguyên chỉ có ở revision hiện tại bị xoá (trừ resource-policy keep).
 * Thành công: revision mới `deployed`, các revision deployed cũ → `superseded`. Lỗi: revision mới
 * `failed`, revision hiện tại `superseded` (như Helm).
 */
export async function helmRollback(
  client: KubeClient,
  namespace: string,
  name: string,
  revision: number,
  findKind: FindKind,
  signal?: AbortSignal
): Promise<HelmActionResult> {
  const entries = await releaseEntries(client, namespace, name, signal)
  const current = entries[0] as ReleaseEntry
  assertIdle(current, name)
  const target = entries.find((e) => e.version === revision)
  if (!target) throw new Error(t('Revision {revision} of {name} was not found', { revision, name }))
  const now = new Date().toISOString()
  const version = current.version + 1
  const record: HelmRecord = {
    ...structuredClone(target.record),
    name,
    namespace,
    version,
    info: {
      ...target.record.info,
      first_deployed: current.record.info?.first_deployed ?? target.record.info?.first_deployed,
      last_deployed: now,
      status: 'pending-rollback',
      notes: target.record.info?.notes ?? '',
      description: `Rollback to ${String(revision)}`
    }
  }
  // Tạo bản ghi trước (pending-rollback) — tên đã có = thao tác khác đang chạy (409).
  const created = recordSecret(target.secret, record, name, namespace, version, 'pending-rollback')
  try {
    await client.json('POST', `/api/v1${ns(namespace)}/secrets`, { body: created, ...sig(signal) })
  } catch (error) {
    if (error instanceof KubeError && error.status === 409)
      throw new Error(
        t('Another operation is in progress on {name} — try again when it finishes', { name }),
        { cause: error }
      )
    throw error
  }
  const entry: ReleaseEntry = {
    secret: { ...created, metadata: { ...created.metadata } },
    record,
    version
  }
  // PUT cần resourceVersion → đọc lại bản vừa tạo khi ghi trạng thái cuối.
  const refresh = async (): Promise<void> => {
    entry.secret = await client.json<HelmSecret>(
      'GET',
      `/api/v1${ns(namespace)}/secrets/${encodeURIComponent(created.metadata.name)}`,
      sig(signal)
    )
  }

  const result: HelmActionResult = {
    revision: version,
    applied: [],
    deleted: [],
    kept: [],
    failed: [],
    hooksSkipped: (target.record.hooks ?? []).filter((h) =>
      (h.events ?? []).some((e) => e === 'pre-rollback' || e === 'post-rollback')
    ).length
  }
  const targetObjs = parseManifest(target.record.manifest ?? '')
  const currentObjs = parseManifest(current.record.manifest ?? '')
  const keep = new Set(targetObjs.map((m) => m.key))

  for (const m of targetObjs) {
    let label = m.label
    try {
      const loc = await locate(m, namespace, findKind)
      label = loc.label
      const path = resourcePath(loc.kind, loc.namespace, m.obj.metadata.name)
      const live = await getLive(client, path, signal)
      if (live) await adoptHelmFields(client, path, live, signal)
      const body = withReleaseMetadata(m.obj, name, namespace)
      if (loc.namespace) body.metadata.namespace = loc.namespace
      await client.json('PATCH', path, {
        body,
        contentType: 'application/apply-patch+yaml',
        query: { fieldManager: HELM_FIELD_MANAGER, force: true },
        ...sig(signal)
      })
      result.applied.push(label)
    } catch (error) {
      result.failed.push(`${label}: ${errText(error)}`)
    }
  }
  if (result.failed.length === 0) {
    // Tài nguyên không còn trong revision đích → xoá (trừ resource-policy keep).
    for (const m of [...currentObjs].reverse()) {
      if (keep.has(m.key)) continue
      let label = m.label
      try {
        const loc = await locate(m, namespace, findKind)
        label = loc.label
        const path = resourcePath(loc.kind, loc.namespace, m.obj.metadata.name)
        const live = await getLive(client, path, signal)
        if (!live) continue
        if (live.metadata.annotations?.[RESOURCE_POLICY] === 'keep') {
          result.kept.push(label)
          continue
        }
        await client.json('DELETE', path, {
          query: { propagationPolicy: 'Background' },
          ...sig(signal)
        })
        result.deleted.push(label)
      } catch (error) {
        result.failed.push(`${label}: ${errText(error)}`)
      }
    }
  }

  await refresh()
  if (result.failed.length) {
    const message = `Rollback "${name}" failed: ${result.failed[0] ?? ''}`
    record.info = { ...record.info, status: 'failed', description: message }
    current.record.info = { ...current.record.info, status: 'superseded' }
    await updateRecord(client, current, namespace, signal)
    await updateRecord(client, entry, namespace, signal)
    return result
  }
  // Mọi revision đang deployed → superseded (Helm issue #2941), rồi revision mới → deployed.
  for (const e of entries)
    if (e.record.info?.status === 'deployed') {
      e.record.info = { ...e.record.info, status: 'superseded' }
      await updateRecord(client, e, namespace, signal)
    }
  record.info = { ...record.info, status: 'deployed' }
  await updateRecord(client, entry, namespace, signal)
  return result
}

/**
 * `helm uninstall <tên> --no-hooks [--keep-history]`: đánh dấu `uninstalling`, xoá tài nguyên trong
 * manifest (thứ tự ngược thứ tự cài; giữ tài nguyên có `helm.sh/resource-policy: keep`), rồi xoá
 * mọi bản ghi release — hoặc giữ lịch sử với trạng thái `uninstalled`.
 */
export async function helmUninstall(
  client: KubeClient,
  namespace: string,
  name: string,
  keepHistory: boolean,
  findKind: FindKind,
  signal?: AbortSignal
): Promise<HelmActionResult> {
  const entries = await releaseEntries(client, namespace, name, signal)
  const current = entries[0] as ReleaseEntry
  const result: HelmActionResult = {
    revision: 0,
    applied: [],
    deleted: [],
    kept: [],
    failed: [],
    hooksSkipped: (current.record.hooks ?? []).filter((h) =>
      (h.events ?? []).some((e) => e === 'pre-delete' || e === 'post-delete')
    ).length
  }
  const alreadyGone = current.record.info?.status === 'uninstalled'
  if (!alreadyGone) {
    assertIdle(current, name)
    current.record.info = {
      ...current.record.info,
      status: 'uninstalling',
      deleted: new Date().toISOString()
    }
    await updateRecord(client, current, namespace, signal)
    current.secret = await client.json<HelmSecret>(
      'GET',
      `/api/v1${ns(namespace)}/secrets/${encodeURIComponent(current.secret.metadata.name)}`,
      sig(signal)
    )
    for (const m of parseManifest(current.record.manifest ?? '').reverse()) {
      let label = m.label
      try {
        const loc = await locate(m, namespace, findKind)
        label = loc.label
        const path = resourcePath(loc.kind, loc.namespace, m.obj.metadata.name)
        const live = await getLive(client, path, signal)
        if (!live) continue
        if (
          live.metadata.annotations?.[RESOURCE_POLICY] === 'keep' ||
          m.obj.metadata.annotations?.[RESOURCE_POLICY] === 'keep'
        ) {
          result.kept.push(label)
          continue
        }
        await client.json('DELETE', path, {
          query: { propagationPolicy: 'Background' },
          ...sig(signal)
        })
        result.deleted.push(label)
      } catch (error) {
        result.failed.push(`${label}: ${errText(error)}`)
      }
    }
  }
  if (keepHistory) {
    if (!alreadyGone) {
      current.record.info = {
        ...current.record.info,
        status: 'uninstalled',
        description: 'Uninstallation complete'
      }
      await updateRecord(client, current, namespace, signal)
    }
    return result
  }
  // Như Helm: xoá bản ghi kể cả khi có tài nguyên không xoá được (báo trong `failed`).
  for (const e of entries) {
    try {
      await client.json(
        'DELETE',
        `/api/v1${ns(namespace)}/secrets/${encodeURIComponent(e.secret.metadata.name)}`,
        sig(signal)
      )
    } catch (error) {
      if (!(error instanceof KubeError && error.status === 404))
        result.failed.push(`secret/${e.secret.metadata.name}: ${errText(error)}`)
    }
  }
  return result
}
