import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { exportHosts, sshAlias } from '../../src/shared/host-export'
import type { HostSummary, HostTree } from '../../src/shared/hosts'

/** Xuất host: YAML giữ cây nhóm, OpenSSH config bỏ qua host không phải SSH, CSV; không có bí mật. */
const host = (over: Partial<HostSummary>): HostSummary => ({
  id: 'h',
  groupId: null,
  label: 'web',
  hostname: 'web.example.com',
  port: null,
  username: 'deploy',
  auth: 'password',
  hasPassword: true,
  keyId: null,
  keyFile: null,
  proxyJump: null,
  jumpHostIds: [],
  mode: 'builtin',
  direct: false,
  legacyAlgorithms: false,
  protocol: 'ssh',
  serial: null,
  tags: [],
  color: null,
  lastUsedAt: null,
  favorite: false,
  sort: 0,
  ...over
})

const tree: HostTree = {
  groups: [
    {
      id: 'p',
      parentId: null,
      name: 'Production',
      sort: 0,
      defaults: { environment: 'prod', port: 2222 }
    },
    { id: 'w', parentId: 'p', name: 'Web', sort: 0, defaults: {} },
    { id: 's', parentId: null, name: 'Staging', sort: 1, defaults: {} }
  ],
  hosts: [
    host({ id: 'b', groupId: 'p', label: 'bastion', hostname: '10.0.0.1' }),
    host({
      id: 'w1',
      groupId: 'w',
      label: 'Web 01',
      hostname: '10.0.1.1',
      jumpHostIds: ['b'],
      tags: ['web']
    }),
    host({ id: 'r', groupId: 'p', label: 'win-ad', hostname: '10.0.0.9', protocol: 'rdp' }),
    host({
      id: 's1',
      groupId: 's',
      label: 'stg',
      hostname: '10.1.0.1',
      accountId: 'a1',
      username: 'ignored'
    })
  ],
  keys: [],
  accounts: [
    {
      id: 'a1',
      name: 'ops',
      username: 'ops',
      hasPassword: true,
      keyId: null,
      hasPassphrase: false,
      domain: '',
      notes: '',
      usedBy: 1
    } as unknown as HostTree['accounts'][number]
  ]
}

describe('xuất danh sách host', () => {
  it('YAML: cây nhóm, môi trường, mặc định, jump theo tên, tài khoản theo tên', () => {
    const out = exportHosts(tree, 'yaml')
    const doc = parse(out.text) as {
      groups: {
        name: string
        environment?: string
        groups?: { hosts: { label: string; jump?: string[] }[] }[]
        defaults?: { port: number }
      }[]
    }
    expect(doc.groups.map((g) => g.name)).toEqual(['Production', 'Staging'])
    expect(doc.groups[0]?.environment).toBe('prod')
    expect(doc.groups[0]?.defaults?.port).toBe(2222)
    expect(doc.groups[0]?.groups?.[0]?.hosts[0]).toMatchObject({
      label: 'Web 01',
      jump: ['bastion']
    })
    expect(out.text).toContain('account: ops')
    // Tài khoản dùng chung chỉ ghi tên; không có trường bí mật nào.
    expect(out.text).not.toContain('ignored')
    expect(out.text).not.toMatch(/hasPassword|passphrase|secret/i)
  })

  it('OpenSSH config: bí danh, ProxyJump, bỏ RDP kèm ghi chú; phạm vi một nhóm', () => {
    const out = exportHosts(tree, 'ssh', 'p')
    expect(out.text).toContain(
      'Host web-01\n  HostName 10.0.1.1\n  User deploy\n  ProxyJump bastion'
    )
    expect(out.skipped).toEqual(['win-ad'])
    expect(out.text).toContain('# Not exported (not SSH): win-ad')
    expect(out.text).not.toContain('stg')
    expect(sshAlias('Máy chủ Đà Nẵng')).toBe('may-chu-da-nang')
  })

  it('CSV: trích dẫn ô có dấu phẩy, nhóm dạng đường dẫn', () => {
    const out = exportHosts(
      { ...tree, hosts: [host({ id: 'x', groupId: 'w', label: 'a,b' })] },
      'csv'
    )
    expect(out.text.split('\n')[1]).toBe('"a,b",Production / Web,web.example.com,,deploy,ssh,,')
  })
})

describe('nhập lại file YAML đã xuất', () => {
  it('giữ đường dẫn nhóm, port mặc định của nhóm; host RDP bỏ qua; trùng tên đánh dấu', async () => {
    const { scanShellhouseYaml } = await import('../../src/main/hosts/yaml-import')
    const yaml = exportHosts(tree, 'yaml').text
    const scan = scanShellhouseYaml(yaml, { existingLabels: ['bastion'], defaultUser: null })
    const web = scan.candidates.find((c) => c.label === 'Web 01')
    expect(web).toMatchObject({
      group: ['Production', 'Web'],
      hostname: '10.0.1.1',
      port: 2222,
      username: 'deploy',
      problem: null,
      tags: ['web']
    })
    expect(scan.candidates.find((c) => c.label === 'bastion')?.duplicate).toBe(true)
    expect(scan.ignored).toEqual({ RDP: 1 })
    // Host dùng tài khoản chung: không có username trong file → báo rõ, không nhập nhầm.
    expect(scan.candidates.find((c) => c.label === 'stg')?.problem).toContain('ops')
    expect(() => scanShellhouseYaml('a: 1', { existingLabels: [], defaultUser: null })).toThrow()
  })
})
