import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fitColumns } from '../../shared/columns'
import { tempDir } from '../../../../../test/unit/helpers'
import {
  hideSecretValues,
  podStatus,
  resourcePath,
  slim,
  toRow,
  type K8sObject
} from '../../shared/resources'
import { K8sOp, isMutating } from '../../shared/ops'
import { listContexts, parseKubeconfig, resolveContext } from '../../main/kubeconfig'
import { credentialProvider, jwtExpiry, pluginBinary } from '../../session-host/auth'
import { statusMessage } from '../../session-host/client'
import type { LimitedSpawn } from '../../../registry/host-types'

const meta = (name: string, namespace?: string): K8sObject['metadata'] => ({
  name,
  ...(namespace ? { namespace } : {}),
  creationTimestamp: new Date(Date.now() - 90 * 60_000).toISOString()
})

describe('bảng tài nguyên', () => {
  it('trạng thái pod như kubectl', () => {
    const pod = (status: Record<string, unknown>, extra: Partial<K8sObject> = {}): K8sObject => ({
      metadata: meta('p', 'ns'),
      spec: { containers: [{ name: 'a' }] },
      status,
      ...extra
    })
    expect(
      podStatus(pod({ phase: 'Running', containerStatuses: [{ state: { running: {} } }] }))
    ).toEqual({ text: 'Running', tone: 'ok' })
    expect(
      podStatus(
        pod({
          phase: 'Running',
          containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }]
        })
      ).tone
    ).toBe('bad')
    expect(
      podStatus(
        pod({
          phase: 'Pending',
          containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }]
        })
      ).tone
    ).toBe('warn')
    expect(
      podStatus(
        pod({
          phase: 'Succeeded',
          containerStatuses: [{ state: { terminated: { reason: 'Completed' } } }]
        })
      )
    ).toEqual({ text: 'Completed', tone: 'muted' })
    expect(
      podStatus(pod({ phase: 'Running' }, { metadata: { ...meta('p'), deletionTimestamp: 'x' } }))
        .text
    ).toBe('Terminating')
  })

  it('dòng theo loại: pod, deployment, node, service, tuổi', () => {
    const row = toRow('pods', {
      metadata: meta('web', 'shop'),
      spec: { containers: [{}, {}], nodeName: 'n1' },
      status: {
        phase: 'Running',
        containerStatuses: [
          { ready: true, restartCount: 1, state: { running: {} } },
          { ready: false, restartCount: 2, state: { running: {} } }
        ]
      }
    })
    expect(row).toMatchObject({
      key: 'shop/web',
      cells: { ready: '1/2', restarts: '3', node: 'n1', age: '90m' },
      tone: 'ok'
    })
    expect(
      toRow('deployments.apps', {
        metadata: meta('d', 'x'),
        spec: { replicas: 3 },
        status: { readyReplicas: 1 }
      })
    ).toMatchObject({ cells: { ready: '1/3' }, tone: 'warn' })
    expect(
      toRow('nodes', {
        metadata: { ...meta('n1'), labels: { 'node-role.kubernetes.io/control-plane': '' } },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          nodeInfo: { kubeletVersion: 'v1.31' }
        }
      }).cells
    ).toMatchObject({ status: 'Ready', roles: 'control-plane', version: 'v1.31' })
    expect(
      toRow('services', {
        metadata: meta('s', 'x'),
        spec: { type: 'NodePort', ports: [{ port: 80, nodePort: 30080 }] }
      }).cells['ports']
    ).toBe('80:30080/TCP')
  })

  it('đường dẫn API; bỏ managedFields; secret giữ tên khoá, bỏ giá trị', () => {
    expect(
      resourcePath(
        { group: '', version: 'v1', plural: 'pods', namespaced: true },
        'a b',
        'p',
        'log'
      )
    ).toBe('/api/v1/namespaces/a%20b/pods/p/log')
    expect(
      resourcePath({ group: 'apps', version: 'v1', plural: 'deployments', namespaced: true })
    ).toBe('/apis/apps/v1/deployments')
    expect(
      resourcePath({ group: '', version: 'v1', plural: 'nodes', namespaced: false }, 'ignored', 'n')
    ).toBe('/api/v1/nodes/n')
    const o = slim({
      metadata: {
        ...meta('x'),
        managedFields: [1],
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}', keep: '1' }
      } as K8sObject['metadata']
    })
    expect(o.metadata).not.toHaveProperty('managedFields')
    expect(o.metadata.annotations).toEqual({ keep: '1' })
    expect(
      hideSecretValues({ metadata: meta('s'), data: { a: 'eA==' }, stringData: { b: 'y' } }).data
    ).toEqual({ a: '', b: '' })
  })

  it('schema: tên không hợp lệ bị chặn; nhận diện thao tác thay đổi', () => {
    expect(
      K8sOp.safeParse({ op: 'delete', kind: 'pods', namespace: 'ns', name: '../x' }).success
    ).toBe(false)
    expect(
      K8sOp.safeParse({
        op: 'portForward',
        namespace: 'ns',
        target: 'deployment/x',
        ports: [[0, 80]]
      }).success
    ).toBe(false)
    expect(isMutating(K8sOp.parse({ op: 'get', kind: 'pods', name: 'a', format: 'yaml' }))).toBe(
      false
    )
    expect(isMutating(K8sOp.parse({ op: 'apply', yaml: 'x' }))).toBe(true)
  })

  it('lỗi 403 / 401 thành câu dễ hiểu', () => {
    const body = Buffer.from(
      JSON.stringify({
        message:
          'pods is forbidden: User "u" cannot list resource "pods" in API group "" in the namespace "kube-system"'
      })
    )
    expect(statusMessage(403, body).message).toBe("You can't list pods in namespace kube-system")
    expect(statusMessage(401, Buffer.from('{}')).message).toMatch(/credentials/)
    expect(statusMessage(500, Buffer.from('boom')).message).toBe('boom')
  })
})

describe('kubeconfig', () => {
  const yaml = (dir: string): string => `
apiVersion: v1
current-context: dev
clusters:
- name: c1
  cluster:
    server: https://10.0.0.1:6443
    certificate-authority: ca.crt
    tls-server-name: api.internal
- name: c2
  cluster:
    server: https://eks.example.com
    certificate-authority-data: ${Buffer.from('CA-PEM').toString('base64')}
users:
- name: u1
  user:
    client-certificate: ${join(dir, 'client.crt')}
    client-key-data: ${Buffer.from('KEY').toString('base64')}
- name: eks
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: /usr/local/bin/aws
      args: [eks, get-token, --cluster-name, prod]
      env:
      - name: AWS_PROFILE
        value: prod
- name: oidc
  user:
    auth-provider:
      name: oidc
      config:
        id-token: aaa.bbb.ccc
        refresh-token: r
        idp-issuer-url: https://idp.example.com
        client-id: k8s
contexts:
- name: dev
  context: {cluster: c1, user: u1, namespace: team}
- name: prod
  context: {cluster: c2, user: eks}
- name: sso
  context: {cluster: c2, user: oidc}
`
  it('liệt kê context (plugin xác thực hiện tên chương trình), phân giải file tương đối theo thư mục kubeconfig', async () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ca.crt'), 'CA-FROM-FILE')
    writeFileSync(join(dir, 'client.crt'), 'CERT-FROM-FILE')
    const doc = parseKubeconfig(yaml(dir))
    const list = listContexts(doc, 'file:/k/config', '~/.kube/config')
    expect(list.map((c) => [c.name, c.server, c.namespace, c.execPlugin])).toEqual([
      ['dev', 'https://10.0.0.1:6443', 'team', null],
      ['prod', 'https://eks.example.com', null, 'aws'],
      ['sso', 'https://eks.example.com', null, null]
    ])
    const read: string[] = []
    const readFile = (p: string): Promise<string> => {
      read.push(p)
      return import('node:fs/promises').then((fs) => fs.readFile(p, 'utf8'))
    }
    const dev = await resolveContext(
      doc,
      { source: 'file:x', context: 'dev' },
      join(dir, 'config'),
      readFile
    )
    expect(dev).toMatchObject({
      ca: 'CA-FROM-FILE',
      tlsServerName: 'api.internal',
      namespace: 'team',
      auth: { cert: 'CERT-FROM-FILE', key: 'KEY' }
    })
    expect(read).toEqual([join(dir, 'client.crt'), join(dir, 'ca.crt')])
    const prod = await resolveContext(
      doc,
      { source: 'file:x', context: 'prod' },
      join(dir, 'config'),
      readFile
    )
    expect(prod.auth.exec).toEqual({
      command: '/usr/local/bin/aws',
      args: ['eks', 'get-token', '--cluster-name', 'prod'],
      env: { AWS_PROFILE: 'prod' },
      apiVersion: 'client.authentication.k8s.io/v1beta1'
    })
    expect(prod.ca).toBe('CA-PEM')
    expect(
      (await resolveContext(doc, { source: 'x', context: 'sso' }, null, readFile)).auth.oidc
    ).toMatchObject({ refreshToken: 'r', clientId: 'k8s' })
    // Bản import không được trỏ tới file trên máy.
    await expect(
      resolveContext(doc, { source: 'imported:1', context: 'dev' }, null, readFile)
    ).rejects.toThrow(/must embed/)
    await expect(
      resolveContext(doc, { source: 'x', context: 'nope' }, null, readFile)
    ).rejects.toThrow(/not in this kubeconfig/)
  })
})

describe('xác thực', () => {
  it('chỉ chạy plugin trong danh sách cho phép', () => {
    expect(pluginBinary('/opt/homebrew/bin/aws')).toBe('aws')
    expect(pluginBinary('C:\\tools\\kubelogin.exe')).toBe('kubelogin')
    expect(() => pluginBinary('/tmp/evil')).toThrow(/does not run/)
  })

  it('exec plugin: env + KUBERNETES_EXEC_INFO, cache tới gần hết hạn, làm mới khi bị 401', async () => {
    const calls: { binary: string; args: readonly string[]; env?: Record<string, string> }[] = []
    let now = 1_000_000
    const spawn: LimitedSpawn = {
      available: () => true,
      spawn: () => Promise.reject(new Error('x')),
      openPty: () => Promise.reject(new Error('x')),
      exec: (binary, args, options) => {
        calls.push({ binary, args, ...(options?.env ? { env: options.env } : {}) })
        return Promise.resolve({
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            kind: 'ExecCredential',
            status: {
              token: `tok-${calls.length}`,
              expirationTimestamp: new Date(now + 15 * 60_000).toISOString()
            }
          })
        })
      }
    }
    const creds = credentialProvider(
      {
        exec: {
          command: 'aws',
          args: ['eks', 'get-token'],
          env: { AWS_PROFILE: 'p' },
          apiVersion: 'client.authentication.k8s.io/v1'
        }
      },
      spawn,
      'https://x',
      () => now
    )
    expect((await creds(false)).headers).toEqual({ Authorization: 'Bearer tok-1' })
    expect((await creds(false)).headers).toEqual({ Authorization: 'Bearer tok-1' })
    expect(calls[0]?.env?.['AWS_PROFILE']).toBe('p')
    expect(JSON.parse(calls[0]?.env?.['KUBERNETES_EXEC_INFO'] ?? '{}')).toMatchObject({
      spec: { cluster: { server: 'https://x' } }
    })
    now += 14.5 * 60_000
    expect((await creds(false)).headers).toEqual({ Authorization: 'Bearer tok-2' })
    expect((await creds(true)).headers).toEqual({ Authorization: 'Bearer tok-3' })
  })

  it('JWT: đọc hạn dùng', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 2000 })).toString('base64url')
    expect(jwtExpiry(`h.${payload}.s`)).toBe(2_000_000)
    expect(jwtExpiry('garbage')).toBeNull()
  })
})

describe('import kubeconfig từ file', () => {
  it('nhúng CA / chứng chỉ / khoá / tokenFile vào bản lưu; file thiếu → lỗi nêu tên', async () => {
    const { embedReferences } = await import('../../main/kubeconfig')
    const files: Record<string, string> = {
      'ca.crt': 'CA',
      '/abs/client.crt': 'CERT',
      'key.pem': 'KEY',
      tok: 'TOKEN\n'
    }
    const read = (p: string): Promise<string> =>
      p in files ? Promise.resolve(files[p] ?? '') : Promise.reject(new Error('ENOENT'))
    const out = await embedReferences(
      `clusters:
- name: c
  cluster:
    server: https://x
    certificate-authority: ca.crt
users:
- name: u
  user:
    client-certificate: /abs/client.crt
    client-key: key.pem
- name: t
  user:
    tokenFile: tok
contexts:
- name: a
  context: {cluster: c, user: u}
`,
      read
    )
    const doc = parseKubeconfig(out)
    expect(doc.clusters.get('c')).toEqual({
      server: 'https://x',
      'certificate-authority-data': Buffer.from('CA').toString('base64')
    })
    expect(doc.users.get('u')).toEqual({
      'client-certificate-data': Buffer.from('CERT').toString('base64'),
      'client-key-data': Buffer.from('KEY').toString('base64')
    })
    expect(doc.users.get('t')).toEqual({ token: 'TOKEN' })
    await expect(
      embedReferences(
        'clusters:\n- name: c\n  cluster: {server: x, certificate-authority: missing.crt}\n',
        read
      )
    ).rejects.toThrow('missing.crt')
  })

  it('quantity và selector', async () => {
    const { parseCpu, parseMemory, formatCpu, formatMemory, selectorString } =
      await import('../../shared/resources')
    expect([
      parseCpu('250m'),
      parseCpu('2'),
      parseCpu('1500000n'),
      parseCpu('3u'),
      parseCpu('x')
    ]).toEqual([250, 2000, 1.5, 0.003, 0])
    expect([
      parseMemory('1Gi'),
      parseMemory('500M'),
      parseMemory('1e3'),
      parseMemory('128974848'),
      parseMemory('5Q')
    ]).toEqual([1024 ** 3, 5e8, 1000, 128974848, 0])
    expect([
      formatCpu(120),
      formatCpu(1500),
      formatCpu(12000),
      formatMemory(64 * 1024 ** 2),
      formatMemory(1.5 * 1024 ** 3)
    ]).toEqual(['120m', '1.5', '12', '64Mi', '1.5Gi'])
    expect(
      selectorString({
        matchLabels: { app: 'web' },
        matchExpressions: [
          { key: 'tier', operator: 'In', values: ['a', 'b'] },
          { key: 'x', operator: 'Exists' }
        ]
      })
    ).toBe('app=web,tier in (a,b),x')
    expect(selectorString({ app: 'db' })).toBe('app=db')
    expect(selectorString(undefined)).toBeNull()
  })
})

describe('bố cục cột bảng (bỏ bớt cột khi hẹp)', () => {
  const pods = ['ready', 'status', 'restarts', 'node', 'cpu', 'mem', 'age']
  it('rộng → giữ hết; chưa đo (0) → giữ hết', () => {
    expect([...fitColumns(pods, 2000).keep]).toEqual(pods)
    expect([...fitColumns(pods, 0).keep]).toEqual(pods)
  })
  it('hẹp → bỏ Node trước, rồi CPU / Memory; Status và Age luôn còn', () => {
    const mid = fitColumns(pods, 640).keep
    expect(mid.has('node')).toBe(false)
    expect(mid.has('status')).toBe(true)
    const narrow = fitColumns(pods, 300).keep
    expect([...narrow]).toEqual(['status', 'age'])
  })
  it('mẫu grid: cột tên + cột giữ lại, Status đủ rộng', () => {
    const { template } = fitColumns(['status', 'age'], 2000)
    expect(template).toBe('minmax(10rem,2fr) minmax(8.5rem,1fr) 3.5rem')
  })
})
