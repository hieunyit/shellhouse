import type { ModuleManifest } from './types'
import { s3Manifest } from '../s3/manifest'
import { dockerManifest } from '../docker/manifest'

/** Manifest của mọi module chính thức — dữ liệu tĩnh, đọc được mà không nạp code module. */
export const MANIFESTS: readonly ModuleManifest[] = [s3Manifest, dockerManifest]

export function manifestOf(id: string): ModuleManifest | undefined {
  return MANIFESTS.find((m) => m.id === id)
}
