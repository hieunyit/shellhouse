import type { ModuleManifest } from '../registry/types'

export const s3Manifest: ModuleManifest = {
  id: 's3',
  name: 'S3 storage',
  summary: 'Browse buckets on AWS S3, MinIO, Cloudflare R2, Wasabi and other S3 services',
  description:
    'A file manager for S3 and S3-compatible storage: browse buckets and folders, upload and ' +
    'download files and folders, copy and rename, edit files in your editor, create share links ' +
    'that expire, and see how much space a bucket or folder uses.\n\n' +
    'Access keys are encrypted in your vault and only used to sign requests — they never leave ' +
    'this computer except as signatures to the storage service.',
  category: 'cloud',
  keywords: [
    's3',
    'bucket',
    'minio',
    'r2',
    'cloudflare',
    'wasabi',
    'ceph',
    'object storage',
    'aws',
    'storage',
    'backblaze'
  ],
  source: 'builtin',
  since: '1.2.0',
  permissions: [
    { kind: 'network', hosts: 'The S3 endpoints you add' },
    { kind: 'secrets', detail: 'Stores secret access keys encrypted in the vault' }
  ],
  version: 1,
  icon: 'database',
  enabledByDefault: true,
  contributes: {
    sidebarSection: true,
    tabKinds: ['browser'],
    settings: true,
    sessionKinds: ['browser'],
    syncRecordTypes: ['s3_account']
  }
}
