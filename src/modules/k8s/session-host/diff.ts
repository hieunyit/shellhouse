import { createHash } from 'node:crypto'
import { parseAllDocuments, stringify as toYaml } from 'yaml'
import { t } from '@shared/i18n'
import type { DiffItem } from '../shared/ops'
import { resourcePath, type K8sObject, type ResourceKind } from '../shared/resources'
import { KubeError, type KubeClient } from './client'
import { keepHiddenSecretValues } from './operations'

/**
 * Xem trước thay đổi (như `kubectl diff`): API server chạy thật với `dryRun=All` (kiểm tra, mặc định,
 * webhook…) nhưng không ghi gì; so bản đang có với kết quả. Bỏ phần "nhiễu" luôn đổi
 * (managedFields, resourceVersion, generation, status…) để diff chỉ còn thay đổi thật.
 */

type FindKind = (apiVersion: string, kind: string) => Promise<ResourceKind | undefined>

const NOISE_ANNOTATIONS = ['kubectl.kubernetes.io/last-applied-configuration']

/** Giá trị Secret không lộ ra trong diff: thay bằng dấu vân tay ngắn (đổi giá trị → đổi dấu). */
function fingerprint(value: string): string {
  return `<hidden sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}>`
}

/** Bản gọn để so sánh (không đổi đối tượng gốc). */
export function cleanForDiff(o: K8sObject): K8sObject {
  const c = structuredClone(o)
  const meta = c.metadata as K8sObject['metadata'] & Record<string, unknown>
  delete meta['managedFields']
  delete meta['resourceVersion']
  delete meta['generation']
  delete meta.uid
  delete meta.creationTimestamp
  delete meta['selfLink']
  if (meta.annotations) {
    meta.annotations = Object.fromEntries(
      Object.entries(meta.annotations).filter(([k]) => !NOISE_ANNOTATIONS.includes(k))
    )
    if (Object.keys(meta.annotations).length === 0) delete meta.annotations
  }
  delete c.status
  if (c.kind === 'Secret') {
    if (c.data)
      c.data = Object.fromEntries(Object.entries(c.data).map(([k, v]) => [k, fingerprint(v)]))
    const stringData = c['stringData'] as Record<string, string> | undefined
    if (stringData)
      c['stringData'] = Object.fromEntries(
        Object.entries(stringData).map(([k, v]) => [
          k,
          fingerprint(Buffer.from(v, 'utf8').toString('base64'))
        ])
      )
  }
  return c
}

const yamlOf = (o: K8sObject): string => toYaml(cleanForDiff(o))

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * replace = PUT (lưu YAML đã sửa, kiểm resourceVersion); apply = server-side apply từng tài liệu.
 * Mỗi tài liệu một kết quả; tài liệu lỗi không chặn tài liệu khác.
 */
export async function diffObjects(
  client: KubeClient,
  mode: 'replace' | 'apply',
  text: string,
  defaultNamespace: string,
  findKind: FindKind,
  signal?: AbortSignal
): Promise<DiffItem[]> {
  const sig = signal ? { signal } : {}
  const out: DiffItem[] = []
  const docs = parseAllDocuments(text)
  if (mode === 'replace' && docs.filter((d) => d.contents !== null).length > 1)
    throw new Error(t('Save one object at a time'))
  for (const doc of docs) {
    if (doc.errors.length) {
      out.push({
        object: t('(invalid YAML)'),
        live: null,
        result: null,
        error: doc.errors[0]?.message ?? t('Invalid YAML')
      })
      continue
    }
    const o = doc.toJS() as K8sObject | null
    if (!o) continue
    const meta = (o as { metadata?: K8sObject['metadata'] }).metadata
    let label = `${(o.kind ?? '?').toLowerCase()}/${meta?.name ?? '?'}`
    try {
      if (!o.apiVersion || !o.kind || !meta?.name)
        throw new Error(t('needs apiVersion, kind and metadata.name'))
      const kind = await findKind(o.apiVersion, o.kind)
      if (!kind)
        throw new Error(
          t('unknown kind {kind} ({apiVersion})', { kind: o.kind, apiVersion: o.apiVersion })
        )
      const namespace = kind.namespaced ? (meta.namespace ?? defaultNamespace) : undefined
      if (namespace) o.metadata.namespace = namespace
      label = namespace ? `${namespace}/${label}` : label
      const path = resourcePath(kind, namespace, o.metadata.name)
      const live = await client.json<K8sObject>('GET', path, sig).catch((error: unknown) => {
        if (error instanceof KubeError && error.status === 404) return null
        throw error
      })
      await keepHiddenSecretValues(client, kind, namespace, o, signal)
      let result: K8sObject
      if (mode === 'replace') {
        if (!live) throw new Error(t('{object} no longer exists on the cluster', { object: label }))
        if (!o.metadata.resourceVersion)
          throw new Error(
            t('metadata.resourceVersion is missing — reload the object before saving')
          )
        try {
          result = await client.json<K8sObject>('PUT', path, {
            body: o,
            query: { dryRun: 'All' },
            ...sig
          })
        } catch (error) {
          if (error instanceof KubeError && error.status === 409)
            throw new Error(
              t(
                'Someone changed this object since you opened it. Reload it and apply your change again.'
              ),
              { cause: error }
            )
          throw error
        }
      } else {
        delete o.metadata.resourceVersion
        result = await client.json<K8sObject>('PATCH', path, {
          body: o,
          contentType: 'application/apply-patch+yaml',
          query: { fieldManager: 'shellhouse', force: false, dryRun: 'All' },
          ...sig
        })
      }
      out.push({ object: label, live: live ? yamlOf(live) : null, result: yamlOf(result) })
    } catch (error) {
      out.push({ object: label, live: null, result: null, error: errText(error) })
    }
  }
  return out
}
