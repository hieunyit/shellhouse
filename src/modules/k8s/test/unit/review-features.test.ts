import { describe, expect, it } from 'vitest'
import { diffStats, foldUnchanged, lineDiff, splitRows } from '../../shared/diff'
import { aggregateEvents, filterEvents, reasonsOf } from '../../shared/events'
import { isSecretKey, MASK, maskSecretValues, parseManifest } from '../../shared/helm'
import type { K8sObject } from '../../shared/resources'
import { cleanForDiff } from '../../session-host/diff'
import { coalesceValues, encodeHelmRelease } from '../../session-host/helm'
import { decodeHelmRelease, findProblems } from '../../session-host/operations'
import { nodeDebugPod } from '../../session-host/debug'

describe('diff theo dòng', () => {
  it('giữ / thêm / xoá đúng thứ tự, đánh số dòng hai bên', () => {
    const d = lineDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n')
    expect(d.map((l) => `${l.op[0] ?? ''}${l.text}`)).toEqual(['sa', 'db', 'aB', 'sc', 'sd', 'ae'])
    expect(d[1]).toMatchObject({ op: 'del', a: 2 })
    expect(d[2]).toMatchObject({ op: 'add', b: 2 })
    expect(d.at(-1)).toMatchObject({ op: 'add', b: 5 })
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 })
  })

  it('giống nhau / rỗng', () => {
    expect(lineDiff('x\ny', 'x\ny').every((l) => l.op === 'same')).toBe(true)
    expect(lineDiff('', 'a\nb').map((l) => l.op)).toEqual(['add', 'add'])
    expect(lineDiff('a\nb', '').map((l) => l.op)).toEqual(['del', 'del'])
  })

  it('kết quả luôn dựng lại được hai bên (ngẫu nhiên)', () => {
    let seed = 7
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: rnd(30) }, () => `l${String(rnd(8))}`)
      const b = Array.from({ length: rnd(30) }, () => `l${String(rnd(8))}`)
      const d = lineDiff(a.join('\n'), b.join('\n'))
      expect(d.filter((l) => l.op !== 'add').map((l) => l.text)).toEqual(a)
      expect(d.filter((l) => l.op !== 'del').map((l) => l.text)).toEqual(b)
    }
  })

  it('gập đoạn không đổi dài, giữ 3 dòng quanh thay đổi; ghép hai cột', () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`)
    const b = [...a]
    b[15] = 'changed'
    const chunks = foldUnchanged(lineDiff(a.join('\n'), b.join('\n')))
    expect(chunks.map((c) => c.kind)).toEqual(['fold', 'lines', 'fold'])
    expect(chunks[0]).toMatchObject({ kind: 'fold', count: 12 })
    const rows = splitRows(lineDiff('a\nold\nz', 'a\nnew\nextra\nz'))
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['old', 'new'],
      [null, 'extra'],
      ['z', 'z']
    ])
  })
})

describe('Helm: che values bí mật, gộp values, mã hoá bản ghi', () => {
  it('khoá giống bí mật', () => {
    for (const k of ['password', 'adminPassword', 'apiKey', 'secretKey', 'token', 'clientSecret'])
      expect(isSecretKey(k), k).toBe(true)
    for (const k of ['existingSecret', 'secretName', 'key', 'keyName', 'image', 'publicKey'])
      expect(isSecretKey(k), k).toBe(false)
  })

  it('che scalar dưới khoá bí mật (kể cả map / list con), giữ phần còn lại', () => {
    const { text, masked } = maskSecretValues(
      'auth:\n  username: app\n  password: s3cret\nsecrets:\n  a: x\n  b: [y, z]\nimage: nginx\nexistingSecret: db-creds\n'
    )
    expect(masked).toBe(4)
    expect(text).toContain('username: app')
    expect(text).toContain(`password: ${MASK}`)
    expect(text).not.toContain('s3cret')
    expect(text).not.toMatch(/\by\b/)
    expect(text).toContain('existingSecret: db-creds')
    expect(maskSecretValues('image: nginx\n')).toEqual({ text: 'image: nginx\n', masked: 0 })
    expect(maskSecretValues('a: [unclosed').masked).toBe(0)
  })

  it('coalesce: gộp sâu, người dùng ghi đè, null bỏ khoá', () => {
    expect(
      coalesceValues(
        { image: { repository: 'nginx', tag: 'stable' }, replicas: 1, debug: true },
        { image: { tag: '1.27' }, debug: null, extra: [1] }
      )
    ).toEqual({ image: { repository: 'nginx', tag: '1.27' }, replicas: 1, extra: [1] })
  })

  it('encode ↔ decode như Helm (base64(base64(gzip(JSON))))', () => {
    const record = { name: 'x', version: 4, info: { status: 'deployed' }, manifest: 'a: b' }
    expect(decodeHelmRelease(encodeHelmRelease(record))).toEqual(record)
  })

  it('manifest: tách tài liệu, bỏ tài liệu rỗng, theo thứ tự cài của Helm', () => {
    const objs = parseManifest(
      '---\n# Source: x\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n---\n\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n'
    )
    expect(objs.map((o) => o.label)).toEqual(['configmap/cfg', 'service/web', 'deployment/web'])
    expect(objs[2]?.key).toBe('apps|Deployment||web')
  })
})

describe('Diff trước khi áp dụng: bỏ nhiễu', () => {
  it('bỏ managedFields / resourceVersion / status / last-applied; che giá trị Secret', () => {
    const obj: K8sObject = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 's',
        resourceVersion: '5',
        uid: 'u',
        creationTimestamp: 'x',
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
        managedFields: []
      } as K8sObject['metadata'],
      data: { a: 'c2VjcmV0' },
      status: { x: 1 }
    }
    const c = cleanForDiff(obj)
    expect(c.metadata).toEqual({ name: 's' })
    expect(c.status).toBeUndefined()
    expect(c.data?.['a']).toMatch(/^<hidden sha256:[0-9a-f]{12}>$/)
    expect(obj.metadata.resourceVersion).toBe('5')
  })
})

describe('Sự kiện: gộp như kubectl, lọc', () => {
  const ev = (
    name: string,
    reason: string,
    type: string,
    last: string,
    count = 1,
    object = 'web-1'
  ): K8sObject => ({
    metadata: { name, namespace: 'shop', creationTimestamp: last },
    involvedObject: { kind: 'Pod', name: object, namespace: 'shop' },
    reason,
    type,
    message: `${reason} happened`,
    count,
    firstTimestamp: '2026-10-01T00:00:00Z',
    lastTimestamp: last,
    source: { component: 'kubelet' }
  })

  it('gộp sự kiện trùng (cộng số lần, khoảng thời gian), mới nhất trước', () => {
    const list = aggregateEvents([
      ev('a', 'BackOff', 'Warning', '2026-10-01T00:05:00Z', 3),
      ev('b', 'BackOff', 'Warning', '2026-10-01T00:09:00Z', 2),
      ev('c', 'Pulled', 'Normal', '2026-10-01T00:01:00Z'),
      ev('d', 'BackOff', 'Warning', '2026-10-01T00:02:00Z', 1, 'web-2')
    ])
    expect(list.map((e) => [e.reason, e.object.name, e.count])).toEqual([
      ['BackOff', 'web-1', 5],
      ['BackOff', 'web-2', 1],
      ['Pulled', 'web-1', 1]
    ])
    expect(list[0]?.names).toEqual(['a', 'b'])
    expect(list[0]?.first).toBe(Date.parse('2026-10-01T00:00:00Z'))
    expect(list[0]?.last).toBe(Date.parse('2026-10-01T00:09:00Z'))
    expect(list[0]?.source).toBe('kubelet')
    expect(filterEvents(list, { type: 'Normal', reasons: [], text: '' })).toHaveLength(1)
    expect(filterEvents(list, { type: 'all', reasons: ['BackOff'], text: 'web-2' })).toHaveLength(1)
    expect(reasonsOf(list)[0]).toEqual({ reason: 'BackOff', warning: true, count: 2 })
  })

  it('events.k8s.io kiểu mới: series / eventTime / note', () => {
    const [e] = aggregateEvents([
      {
        metadata: { name: 'n', namespace: 'x' },
        regarding: { kind: 'Pod', name: 'p' },
        reason: 'Killing',
        note: 'Stopping container',
        eventTime: '2026-10-01T00:00:00Z',
        series: { count: 4, lastObservedTime: '2026-10-01T00:03:00Z' },
        reportingController: 'kubelet'
      }
    ])
    expect(e).toMatchObject({
      count: 4,
      message: 'Stopping container',
      type: 'Normal',
      source: 'kubelet'
    })
    expect(e?.last).toBe(Date.parse('2026-10-01T00:03:00Z'))
  })
})

describe('Tổng quan: vấn đề theo nhóm', () => {
  const now = Date.parse('2026-10-03T10:00:00Z')
  const pod = (
    name: string,
    status: Record<string, unknown>,
    created = '2026-10-03T09:00:00Z'
  ): K8sObject => ({
    metadata: { name, namespace: 'shop', creationTimestamp: created },
    status
  })
  it('pod lỗi / kéo image / Pending lâu; node NotReady; PVC chưa bound', () => {
    const p = findProblems(
      [
        { metadata: { name: 'n1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
        {
          metadata: { name: 'n2' },
          status: {
            conditions: [
              { type: 'Ready', status: 'Unknown', message: 'Kubelet stopped posting node status.' }
            ]
          }
        }
      ],
      [
        pod('crash', {
          phase: 'Running',
          containerStatuses: [
            { name: 'a', restartCount: 9, state: { waiting: { reason: 'CrashLoopBackOff' } } }
          ]
        }),
        pod('pull', {
          phase: 'Pending',
          containerStatuses: [{ name: 'a', state: { waiting: { reason: 'ImagePullBackOff' } } }]
        }),
        pod('stuck', {
          phase: 'Pending',
          conditions: [
            {
              type: 'PodScheduled',
              status: 'False',
              reason: 'Unschedulable',
              message: '0/3 nodes are available'
            }
          ]
        }),
        pod('fresh', { phase: 'Pending' }, '2026-10-03T09:59:30Z'),
        pod('done', { phase: 'Succeeded' }),
        pod('ok', { phase: 'Running', containerStatuses: [{ name: 'a', state: { running: {} } }] })
      ],
      [
        { metadata: { name: 'data', namespace: 'shop' }, status: { phase: 'Pending' } },
        { metadata: { name: 'bound', namespace: 'shop' }, status: { phase: 'Bound' } }
      ],
      now
    )
    expect(p.failing.items.map((i) => [i.name, i.reason, i.restarts])).toEqual([
      ['crash', 'CrashLoopBackOff', 9]
    ])
    expect(p.imagePull.items.map((i) => i.name)).toEqual(['pull'])
    expect(p.pending.items.map((i) => [i.name, i.reason])).toEqual([['stuck', 'Unschedulable']])
    expect(p.nodes.items.map((i) => [i.name, i.reason])).toEqual([['n2', 'NodeStatusUnknown']])
    expect(p.pvcs.items.map((i) => i.name)).toEqual(['data'])
  })
})

describe('Pod debug node', () => {
  it('đặc quyền, hostPID / hostNetwork, / của node ở /host, chịu mọi taint', () => {
    const pod = nodeDebugPod('worker-1', 'busybox', 'node-debugger-worker-1-abcde')
    expect(pod.spec).toMatchObject({
      nodeName: 'worker-1',
      hostPID: true,
      hostNetwork: true,
      hostIPC: true,
      restartPolicy: 'Never',
      tolerations: [{ operator: 'Exists' }]
    })
  })
})
