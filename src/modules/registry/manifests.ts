import type { ModuleManifest } from './types'
import { s3Manifest } from '../s3/manifest'
import { dockerManifest } from '../docker/manifest'
import { k8sManifest } from '../k8s/manifest'
import { runbookManifest } from '../runbook/manifest'

/** Manifest của mọi module chính thức — dữ liệu tĩnh, đọc được mà không nạp code module. */
export const MANIFESTS: readonly ModuleManifest[] = [
  s3Manifest,
  dockerManifest,
  k8sManifest,
  runbookManifest
]

export function manifestOf(id: string): ModuleManifest | undefined {
  return MANIFESTS.find((m) => m.id === id)
}
