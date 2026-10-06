import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { TimelineEntry } from '../../src/modules/k8s/shared/timeline'

/** Tab Timeline: tiêu đề / chi tiết từng mục, image đổi, lần chết gần nhất. */
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

const entry = (over: Partial<TimelineEntry>): TimelineEntry => ({
  at: 0,
  lane: 'events',
  type: 'event',
  severity: 'info',
  object: { kind: 'Pod', name: 'web-1', namespace: 'shop' },
  ...over
})

describe('Timeline', () => {
  it('image đổi: cùng repo chỉ ghi tag; khác repo ghi đủ; không có bản trước → image hiện tại', async () => {
    const { imageChange, entryDetail, entryTitle } =
      await import('../../src/modules/k8s/renderer/Timeline')
    expect(imageChange('registry.io/shop/api:1.4', 'registry.io/shop/api:1.5')).toBe(
      'api: 1.4 → 1.5'
    )
    expect(imageChange('nginx:1.26', 'caddy:2')).toBe('nginx:1.26 → caddy:2')
    expect(imageChange('', 'nginx:1.27')).toBe('nginx:1.27')
    const r = entry({
      lane: 'rollout',
      type: 'rollout',
      revision: '7',
      images: ['shop/api:1.5', 'envoy:1.30'],
      previousImages: ['shop/api:1.4', 'envoy:1.30']
    })
    expect(entryTitle(r)).toBe('Rollout · revision 7')
    expect(entryDetail(r)).toBe('api: 1.4 → 1.5')
    expect(entryDetail({ ...r, images: r.previousImages ?? [] })).toBe(
      'Same images — pod template settings changed'
    )
    expect(
      entryTitle(
        entry({
          lane: 'pods',
          type: 'container-terminated',
          severity: 'danger',
          container: 'app',
          reason: 'OOMKilled',
          exitCode: 137
        })
      )
    ).toBe('Container app crashed — OOMKilled, exit code 137')
    expect(entryDetail(entry({ reason: 'BackOff', message: 'Back-off' }))).toBe(
      'Pod/web-1 — Back-off'
    )
  })

  it('lần chết gần nhất: container chết bất thường trước, không có thì event lỗi nặng', async () => {
    const { lastCrash } = await import('../../src/modules/k8s/renderer/Timeline')
    const ev = entry({ at: 3, severity: 'danger', reason: 'BackOff' })
    const crash = entry({ at: 2, lane: 'pods', type: 'container-terminated', severity: 'danger' })
    const clean = entry({ at: 4, lane: 'pods', type: 'container-terminated', severity: 'info' })
    expect(lastCrash([clean, ev, crash])).toBe(crash)
    expect(lastCrash([clean, ev])).toBe(ev)
    expect(lastCrash([clean])).toBeNull()
  })
})
