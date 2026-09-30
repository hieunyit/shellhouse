import { describe, expect, it } from 'vitest'
import { applyPatch, DEFAULT_SETTINGS, parseSettings } from '@shared/settings'
import { Workspace } from '@shared/workspaces'
import { normalize, scoreModule, searchModules } from '../../src/modules/registry/search'
import { matchPathPattern, type ModuleManifest } from '../../src/modules/registry/types'
import { MANIFESTS } from '../../src/modules/registry/manifests'

function m(id: string, name: string, extra: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id,
    name,
    summary: '',
    description: '',
    category: 'other',
    keywords: [],
    source: 'builtin',
    since: '1.3.0',
    permissions: [],
    version: 1,
    icon: 'puzzle',
    enabledByDefault: false,
    contributes: {},
    ...extra
  }
}

const docker = m('docker', 'Docker', {
  summary: 'Containers on this computer and on servers over SSH',
  keywords: ['container', 'compose', 'podman', 'image']
})
const k8s = m('k8s', 'Kubernetes', {
  summary: 'Clusters, pods and logs',
  keywords: ['k8s', 'kube', 'kubectl', 'pod', 'helm', 'cluster'],
  description: 'Works through an SSH bastion.'
})
const s3 = m('s3', 'S3 storage', { keywords: ['bucket', 'minio', 'object storage'] })

describe('tìm module (3.12.2)', () => {
  it('thang điểm: đầu tên > từ trong tên > từ khoá > summary > description > gần đúng; đang bật +5', () => {
    expect(scoreModule(docker, 'dock', false)).toBe(100)
    expect(scoreModule(s3, 'storage', false)).toBe(80)
    expect(scoreModule(docker, 'podman', false)).toBe(60)
    expect(scoreModule(docker, 'servers over', false)).toBe(40)
    expect(scoreModule(k8s, 'bastion', false)).toBe(20)
    expect(scoreModule(k8s, 'kubernets', false)).toBe(10)
    expect(scoreModule(k8s, 'kubernets', true)).toBe(15)
    expect(scoreModule(docker, 'zzz', true)).toBe(0)
    // Gần đúng chỉ cho từ ≥ 5 ký tự.
    expect(scoreModule(docker, 'dokr', false)).toBe(0)
  })

  it('không phân biệt hoa thường, bỏ dấu; sắp theo điểm rồi theo tên', () => {
    expect(normalize('  Đám MÂY ')).toBe('dam may')
    const items = [docker, k8s, s3].map((manifest) => ({
      manifest,
      enabled: manifest.id === 's3'
    }))
    expect(searchModules(items, 'CONTAINER').map((i) => i.manifest.id)).toEqual(['docker'])
    expect(searchModules(items, '').map((i) => i.manifest.id)).toEqual(['s3', 'docker', 'k8s'])
    // "pod" khớp từ khoá của cả hai (pod, podman) — cùng điểm → theo tên.
    expect(searchModules(items, 'pod').map((i) => i.manifest.id)).toEqual(['docker', 'k8s'])
  })

  it('mẫu đường dẫn: * là một đoạn không có "/"', () => {
    expect(matchPathPattern('/run/user/*/docker.sock', '/run/user/1000/docker.sock')).toBe(true)
    expect(matchPathPattern('/run/user/*/docker.sock', '/run/user/1/2/docker.sock')).toBe(false)
    expect(matchPathPattern('/var/run/docker.sock', '/var/run/docker.sockX')).toBe(false)
    expect(matchPathPattern('/a.b', '/aXb')).toBe(false)
  })

  it('manifest chính thức hợp lệ: id duy nhất, tóm tắt ≤ 80 ký tự, quyền khớp chương trình', () => {
    const ids = MANIFESTS.map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const x of MANIFESTS) {
      expect(x.id).toMatch(/^[a-z0-9-]{1,40}$/)
      expect(x.summary.length).toBeLessThanOrEqual(80)
      expect(x.keywords.every((k) => k === k.toLowerCase())).toBe(true)
      for (const b of x.binaries ?? [])
        expect(x.permissions).toContainEqual({ kind: 'run-program', binary: b })
    }
  })
})

describe('cài đặt module', () => {
  it('chuyển files.s3Requests / s3Transfers cũ → modules.s3 (giữ giá trị người dùng)', () => {
    const s = parseSettings({ files: { s3Requests: 32, s3Transfers: 2, sftpRequests: 4 } })
    expect(s.modules['s3']).toMatchObject({ requests: 32, transfers: 2 })
    expect(s.files).not.toHaveProperty('s3Requests')
    expect(s.files.sftpRequests).toBe(4)
    // Đã có giá trị mới → không bị giá trị cũ ghi đè.
    const both = parseSettings({ files: { s3Requests: 32 }, modules: { s3: { requests: 8 } } })
    expect(both.modules['s3']).toMatchObject({ requests: 8 })
  })

  it('patch gộp theo từng module; trường hỏng không làm mất module khác', () => {
    let s = applyPatch(DEFAULT_SETTINGS, { modules: { s3: { enabled: false, requests: 8 } } })
    s = applyPatch(s, { modules: { s3: { seen: true }, docker: { enabled: true } } })
    expect(s.modules).toEqual({
      s3: { enabled: false, requests: 8, seen: true },
      docker: { enabled: true }
    })
    const broken = parseSettings({ modules: { s3: { enabled: 'yes', requests: 8 }, docker: {} } })
    expect(broken.modules['s3']).toEqual({ requests: 8 })
    expect(broken.modules['docker']).toEqual({})
  })
})

describe('workspace', () => {
  it('đọc được tab S3 kiểu cũ → tab của module s3', () => {
    const w = Workspace.parse({
      id: 'w',
      name: 'Old',
      items: [
        {
          target: { kind: 's3', accountId: 'a1', bucket: 'logs', prefix: 'x/' },
          title: 'logs/x',
          after: null,
          direction: 'within'
        },
        { target: { kind: 's3', accountId: 'a2' }, title: 'S3', after: null, direction: 'within' }
      ]
    })
    expect(w.items.map((i) => i.target)).toEqual([
      {
        kind: 'module',
        module: 's3',
        tab: 'browser',
        params: { accountId: 'a1', bucket: 'logs', prefix: 'x/' }
      },
      { kind: 'module', module: 's3', tab: 'browser', params: { accountId: 'a2' } }
    ])
  })

  it('tham số tab module quá lớn → không lưu', () => {
    const big = { kind: 'module', module: 's3', tab: 'browser', params: { x: 'y'.repeat(5000) } }
    expect(
      Workspace.safeParse({
        id: 'w',
        name: 'Big',
        items: [{ target: big, title: 't', after: null, direction: 'within' }]
      }).success
    ).toBe(false)
  })
})
