import {
  argEntries,
  endpointsIn,
  endpointsInEntries,
  type EgressItem,
  type EgressResult,
  type EgressSource,
  type EgressWorkloadRef
} from '../shared/egress'
import type { K8sObject } from '../shared/resources'
import { KubeError, type KubeClient } from './client'
import { listAll, templateOf, WORKLOAD_KINDS } from './map'

/**
 * Điểm đến "khai báo" của workload: quét pod template (env, args, command), rồi đọc đúng những
 * ConfigMap / Secret mà template tham chiếu (GET từng cái — không bao giờ list cả namespace) để tìm
 * host:port. Giá trị Secret chỉ đi qua bộ nhớ trong lúc rút host / cổng; kết quả trả về không chứa
 * giá trị, mật khẩu hay chuỗi kết nối gốc.
 */

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const a = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(o) : [])
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** Tối đa chừng này workload mỗi lần quét. */
export const MAX_WORKLOADS = 5000
/** Tối đa ConfigMap / Secret đọc mỗi lần (cluster quá lớn → bỏ phần còn lại). */
export const MAX_OBJECTS = 400
const CONCURRENCY = 8
/** Giá trị dài hơn mức này (chứng chỉ, bundle) không phải địa chỉ. */
const MAX_VALUE = 8192

interface Consumer {
  workload: EgressWorkloadRef
  /** Cả object (envFrom / volume) hay một khoá (configMapKeyRef / secretKeyRef). */
  key?: string
  /** Tên biến môi trường dùng khoá này (gợi ý tên khoá tốt hơn tên khoá trong object). */
  hint?: string
}

interface ObjectWant {
  kind: 'configmap' | 'secret'
  ns: string
  name: string
  consumers: Consumer[]
}

/** Mục tìm được thẳng trong pod template (không cần đọc object nào). */
function templateItems(
  workload: EgressWorkloadRef,
  tpl: Obj,
  want: (kind: 'configmap' | 'secret', name: string, c: Consumer) => void
): EgressItem[] {
  const out: EgressItem[] = []
  const spec = o(tpl['spec'])
  const push = (source: EgressSource, key: string, eps: ReturnType<typeof endpointsIn>): void => {
    for (const e of eps)
      out.push({
        workload,
        source,
        via: '',
        key,
        host: e.host,
        ...(e.port !== undefined ? { port: e.port } : {}),
        ...(e.scheme ? { scheme: e.scheme } : {}),
        ...(e.portImplied ? { portImplied: true } : {})
      })
  }
  for (const c of [...a(spec['initContainers']), ...a(spec['containers'])]) {
    const literal: { key: string; value: string }[] = []
    for (const e of a(c['env'])) {
      const name = s(e['name'])
      if (!name) continue
      const from = o(e['valueFrom'])
      const cmRef = o(from['configMapKeyRef'])
      const skRef = o(from['secretKeyRef'])
      if (s(cmRef['name']) && s(cmRef['key']))
        want('configmap', s(cmRef['name']), { workload, key: s(cmRef['key']), hint: name })
      else if (s(skRef['name']) && s(skRef['key']))
        want('secret', s(skRef['name']), { workload, key: s(skRef['key']), hint: name })
      else if (typeof e['value'] === 'string' && e['value'])
        literal.push({ key: name, value: e['value'].slice(0, MAX_VALUE) })
    }
    for (const x of endpointsInEntries(literal)) push('env', x.key, [x.endpoint])
    for (const e of a(c['envFrom'])) {
      const cm = s(o(e['configMapRef'])['name'])
      const sr = s(o(e['secretRef'])['name'])
      if (cm) want('configmap', cm, { workload })
      if (sr) want('secret', sr, { workload })
    }
    const argv = [...strs(c['command']), ...strs(c['args'])]
    for (const x of endpointsInEntries(argEntries(argv)))
      push('args', x.key || 'args', [x.endpoint])
  }
  for (const v of a(spec['volumes'])) {
    const cm = s(o(v['configMap'])['name'])
    const sr = s(o(v['secret'])['secretName'])
    if (cm) want('configmap', cm, { workload })
    if (sr) want('secret', sr, { workload })
    for (const src of a(o(v['projected'])['sources'])) {
      const pcm = s(o(src['configMap'])['name'])
      const psr = s(o(src['secret'])['name'])
      if (pcm) want('configmap', pcm, { workload })
      if (psr) want('secret', psr, { workload })
    }
  }
  return out
}

/** Giá trị Secret (base64) → chữ; nhị phân / quá dài → null. */
function secretText(b64: unknown): string | null {
  if (typeof b64 !== 'string' || b64.length > MAX_VALUE * 2) return null
  try {
    const text = Buffer.from(b64, 'base64').toString('utf8')
    return text.includes('\u0000') || text.includes('�') || text.startsWith('-----BEGIN')
      ? null
      : text
  } catch {
    return null
  }
}

/** Dữ liệu (đã rút) của một ConfigMap / Secret: mục cho mọi consumer. */
function objectItems(
  want: ObjectWant,
  entries: readonly { key: string; value: string }[]
): EgressItem[] {
  const source: EgressSource = want.kind
  const out: EgressItem[] = []
  const emit = (
    workload: EgressWorkloadRef,
    key: string,
    ep: ReturnType<typeof endpointsIn>[number]
  ): void => {
    out.push({
      workload,
      source,
      via: want.name,
      key,
      host: ep.host,
      ...(ep.port !== undefined ? { port: ep.port } : {}),
      ...(ep.scheme ? { scheme: ep.scheme } : {}),
      ...(ep.portImplied ? { portImplied: true } : {})
    })
  }
  const all = endpointsInEntries(entries)
  const byKey = new Map(entries.map((e) => [e.key, e.value]))
  for (const c of want.consumers) {
    if (c.key === undefined) {
      for (const x of all) emit(c.workload, x.key, x.endpoint)
      continue
    }
    const value = byKey.get(c.key)
    if (value === undefined) continue
    for (const ep of endpointsIn(value, c.hint ?? c.key)) emit(c.workload, c.key, ep)
  }
  return out
}

async function readObject(
  client: KubeClient,
  want: ObjectWant,
  signal?: AbortSignal
): Promise<{ entries: { key: string; value: string }[] } | 'denied' | 'missing'> {
  const plural = want.kind === 'configmap' ? 'configmaps' : 'secrets'
  try {
    const obj = await client.json<K8sObject>(
      'GET',
      `/api/v1/namespaces/${encodeURIComponent(want.ns)}/${plural}/${encodeURIComponent(want.name)}`,
      signal ? { signal } : {}
    )
    const data = o((obj as unknown as Obj)['data'])
    const entries: { key: string; value: string }[] = []
    for (const [key, raw] of Object.entries(data)) {
      const value = want.kind === 'secret' ? secretText(raw) : typeof raw === 'string' ? raw : null
      if (value && value.length <= MAX_VALUE) entries.push({ key, value })
    }
    return { entries }
  } catch (error) {
    if (error instanceof KubeError && error.status === 403) return 'denied'
    if (error instanceof KubeError && error.status === 404) return 'missing'
    throw error
  }
}

/** Chạy `fn` cho từng phần tử, tối đa `limit` cái cùng lúc. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  fn: (x: T) => Promise<void>
): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        await fn(items[i] as T)
      }
    })
  )
}

export async function egressData(
  client: KubeClient,
  namespaces: readonly string[],
  readSecrets: boolean,
  signal?: AbortSignal
): Promise<EgressResult> {
  const lists = await Promise.all(
    WORKLOAD_KINDS.map((k) => listAll(client, k.path, k.plural, namespaces, signal))
  )
  const items: EgressItem[] = []
  const wants = new Map<string, ObjectWant>()
  let scanned = 0
  let truncated = lists.some((l) => l.truncated)
  outer: for (const [i, list] of lists.entries()) {
    const kind = WORKLOAD_KINDS[i]?.id ?? ''
    for (const w of list.items) {
      if (scanned >= MAX_WORKLOADS) {
        truncated = true
        break outer
      }
      scanned++
      const ns = w.metadata.namespace ?? ''
      const workload: EgressWorkloadRef = { kind, ns, name: w.metadata.name }
      items.push(
        ...templateItems(workload, templateOf(kind, w), (k, name, consumer) => {
          const key = `${k}|${ns}/${name}`
          const want = wants.get(key) ?? { kind: k, ns, name, consumers: [] }
          wants.set(key, want)
          want.consumers.push(consumer)
        })
      )
    }
  }

  const skipped = { configMaps: 0, secrets: 0, denied: 0 }
  const queue: ObjectWant[] = []
  let cm = 0
  let sec = 0
  for (const want of wants.values()) {
    if (want.kind === 'secret') {
      if (!readSecrets || sec >= MAX_OBJECTS) {
        skipped.secrets++
        continue
      }
      sec++
    } else {
      if (cm >= MAX_OBJECTS) {
        skipped.configMaps++
        continue
      }
      cm++
    }
    queue.push(want)
  }
  await pool(queue, CONCURRENCY, async (want) => {
    const r = await readObject(client, want, signal)
    if (r === 'denied') skipped.denied++
    else if (r !== 'missing') items.push(...objectItems(want, r.entries))
  })

  // Cùng workload × nguồn × đích chỉ giữ một.
  const seen = new Set<string>()
  const unique = items.filter((it) => {
    const k = `${it.workload.kind}|${it.workload.ns}/${it.workload.name}|${it.source}|${it.via}|${it.key}|${it.host}|${it.port ?? ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { items: unique, skipped, scanned, truncated, readSecrets }
}
