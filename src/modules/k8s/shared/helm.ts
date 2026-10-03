import { parseAllDocuments, parseDocument, isMap, isPair, isScalar, isSeq, type Node } from 'yaml'
import type { K8sObject } from './resources'

/**
 * Values của Helm thường có mật khẩu / token: che giá trị của khoá "giống bí mật" khi hiện (bấm
 * Reveal mới thấy). Che theo tên khoá — như Lens / Headlamp; không đoán theo nội dung.
 */

const SECRET_KEY =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|client[-_]?secret|dsn|connection[-_]?string|pwd|key)$|^(password|secret|token|credentials?)/i

/** Khoá không phải bí mật dù khớp mẫu (tên / tham chiếu tới secret, khoá công khai…). */
const NOT_SECRET =
  /(secret[-_]?(name|ref|key[-_]?ref)|existing[-_]?secret|key[-_]?(name|ref|path|file)|password[-_]?(key|file)|token[-_]?(ttl|url|path)|secrets?[-_]?(store|provider)|public[-_]?key|^key$)/i

export const MASK = '••••••'

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !NOT_SECRET.test(key)
}

/**
 * Che giá trị: khoá bí mật → scalar thành MASK; map / list dưới khoá bí mật → che mọi scalar bên
 * trong. Trả YAML (giữ thứ tự, chú thích) và số giá trị đã che. YAML hỏng → trả nguyên văn.
 */
export function maskSecretValues(text: string): { text: string; masked: number } {
  if (!text.trim()) return { text, masked: 0 }
  const doc = parseDocument(text)
  if (doc.errors.length) return { text, masked: 0 }
  let masked = 0
  const maskAll = (node: Node | null | undefined): void => {
    if (!node) return
    if (isScalar(node)) {
      if (node.value !== null && node.value !== '') {
        node.value = MASK
        node.type = 'PLAIN'
        masked++
      }
    } else if (isMap(node)) {
      for (const pair of node.items) maskAll(pair.value as Node | null)
    } else if (isSeq(node)) {
      for (const item of node.items) maskAll(item as Node)
    }
  }
  const walk = (node: Node | null | undefined): void => {
    if (!node) return
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isPair(pair)) continue
        const key = isScalar(pair.key) ? String(pair.key.value) : ''
        if (key && isSecretKey(key)) maskAll(pair.value as Node | null)
        else walk(pair.value as Node | null)
      }
    } else if (isSeq(node)) for (const item of node.items) walk(item as Node)
  }
  walk(doc.contents)
  return { text: masked ? doc.toString() : text, masked }
}

// ——— Manifest ———

/** Thứ tự cài của Helm (InstallOrder); gỡ theo thứ tự ngược lại. Loại lạ cài sau cùng / gỡ trước. */
const INSTALL_ORDER = [
  'PriorityClass',
  'Namespace',
  'NetworkPolicy',
  'ResourceQuota',
  'LimitRange',
  'PodSecurityPolicy',
  'PodDisruptionBudget',
  'ServiceAccount',
  'Secret',
  'SecretList',
  'ConfigMap',
  'StorageClass',
  'PersistentVolume',
  'PersistentVolumeClaim',
  'CustomResourceDefinition',
  'ClusterRole',
  'ClusterRoleList',
  'ClusterRoleBinding',
  'ClusterRoleBindingList',
  'Role',
  'RoleList',
  'RoleBinding',
  'RoleBindingList',
  'Service',
  'DaemonSet',
  'Pod',
  'ReplicationController',
  'ReplicaSet',
  'Deployment',
  'HorizontalPodAutoscaler',
  'StatefulSet',
  'Job',
  'CronJob',
  'IngressClass',
  'Ingress',
  'APIService'
]

const rank = (kind: string | undefined): number => {
  const i = INSTALL_ORDER.indexOf(kind ?? '')
  return i === -1 ? INSTALL_ORDER.length : i
}

export interface ManifestObject {
  obj: K8sObject
  /** "apiVersion|Kind|namespace|tên" — so khớp giữa hai revision. */
  key: string
  label: string
}

/** Tách manifest của release thành đối tượng (bỏ tài liệu rỗng / hỏng), theo thứ tự cài. */
export function parseManifest(manifest: string): ManifestObject[] {
  const out: ManifestObject[] = []
  for (const doc of parseAllDocuments(manifest)) {
    if (doc.errors.length) continue
    const o = doc.toJS() as K8sObject | null
    if (
      !o ||
      typeof o !== 'object' ||
      !o.apiVersion ||
      !o.kind ||
      !(o.metadata as K8sObject['metadata'] | undefined)?.name
    )
      continue
    out.push({
      obj: o,
      key: `${o.apiVersion.split('/')[0] ?? ''}|${o.kind}|${o.metadata.namespace ?? ''}|${o.metadata.name}`,
      label: `${o.kind.toLowerCase()}/${o.metadata.name}`
    })
  }
  return out.sort((a, b) => rank(a.obj.kind) - rank(b.obj.kind))
}
