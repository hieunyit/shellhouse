import { beforeAll, describe, expect, it, vi } from 'vitest'

/** Home › Needs attention: vấn đề do module báo (Kubernetes, Docker) và store gộp. */
beforeAll(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined
  })
  // renderer-kit nạp kéo theo nhiều store gọi preload: on…() → hàm huỷ; còn lại → promise treo.
  vi.stubGlobal('window', {
    shellhouse: new Proxy(
      {},
      {
        get: (_t, name) =>
          typeof name === 'string' && name.startsWith('on')
            ? () => () => undefined
            : () => new Promise(() => undefined)
      }
    ),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined })
  })
  vi.stubGlobal('navigator', { userAgent: 'node', platform: 'Linux' })
})

describe('Needs attention', () => {
  it('Kubernetes: pod lỗi / kéo image hỏng → danger, Pending → warning; nguồn cluster / namespace; bấm mở đúng đối tượng', async () => {
    const { attentionOf } = await import('../../src/modules/k8s/renderer/attention')
    const opened: string[] = []
    const empty = { total: 0, items: [] }
    const items = attentionOf(
      {
        failing: {
          total: 1,
          items: [
            {
              kind: 'pods',
              namespace: 'shop',
              name: 'web-2',
              reason: 'CrashLoopBackOff',
              message: 'back-off restarting',
              since: '',
              restarts: 7
            }
          ]
        },
        imagePull: empty,
        pending: {
          total: 1,
          items: [
            {
              kind: 'pods',
              namespace: 'shop',
              name: 'job-1',
              reason: 'Unschedulable',
              message: '',
              since: ''
            }
          ]
        },
        nodes: empty,
        pvcs: empty
      },
      'prod-cluster',
      (kind, ns, name) => opened.push(`${kind}/${ns ?? ''}/${name}`)
    )
    expect(items.map((i) => [i.title, i.severity, i.badge, i.source])).toEqual([
      ['web-2', 'danger', 'CrashLoopBackOff', 'prod-cluster / shop'],
      ['job-1', 'warning', 'Unschedulable', 'prod-cluster / shop']
    ])
    expect(items[0]?.description).toBe('7 restarts — back-off restarting')
    items[0]?.open?.()
    expect(opened).toEqual(['pods/shop/web-2'])
  })

  it('store: gộp các nguồn, nặng trước; gỡ nguồn khi đóng tab', async () => {
    const { attentionItems, useAttention } = await import('../../src/renderer/src/stores/attention')
    const s = useAttention.getState()
    s.publish('a', [{ id: '1', severity: 'warning', title: 'b-warn', source: 'x' }])
    s.publish('b', [{ id: '2', severity: 'danger', title: 'z-danger', source: 'y' }])
    expect(attentionItems(useAttention.getState().sources).map((i) => i.title)).toEqual([
      'z-danger',
      'b-warn'
    ])
    s.remove('b')
    expect(attentionItems(useAttention.getState().sources).map((i) => i.title)).toEqual(['b-warn'])
  })
})
