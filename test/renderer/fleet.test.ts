import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { FleetResult } from '../../src/modules/k8s/shared/ops'
import type { ModuleSessionEvents } from '../../src/modules/registry/renderer-kit'

/** Home › Infrastructure: tóm tắt cluster / Docker, thời hạn hỗ trợ, phiên chạy nền. */
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

const NOW = Date.parse('2026-10-06T12:00:00Z')
const group = (total: number) => ({ total, items: [] })

function result(over: Partial<FleetResult> = {}): FleetResult {
  return {
    version: 'v1.36.1',
    nodes: { total: 3, ready: 3 },
    problems: {
      failing: group(0),
      imagePull: group(0),
      nodes: group(0),
      pending: group(0),
      pvcs: group(0)
    },
    ...over
  }
}

describe('Thời hạn hỗ trợ Kubernetes', () => {
  it('đọc minor + nhà cung cấp; còn / sắp hết / đã hết / mới hơn bảng', async () => {
    const { k8sSupport } = await import('../../src/modules/k8s/shared/support')
    expect(k8sSupport('v1.34.2-eks-113cf36', NOW)).toMatchObject({
      minor: '1.34',
      status: 'ending',
      endOfLife: '2026-10-27',
      daysLeft: 21,
      provider: 'EKS'
    })
    expect(k8sSupport('v1.31.4-gke.1000', NOW)).toMatchObject({ status: 'ended', provider: 'GKE' })
    expect(k8sSupport('v1.36.0', NOW).status).toBe('supported')
    expect(k8sSupport('v1.40.0', NOW).status).toBe('supported')
    expect(k8sSupport('v1.18.0', NOW).status).toBe('ended')
    expect(k8sSupport('', NOW).status).toBe('unknown')
  })
})

describe('Tóm tắt cluster', () => {
  it('ghi chú: hết hỗ trợ, chứng chỉ API server / client sắp hoặc đã hết hạn', async () => {
    const { fleetNotes } = await import('../../src/modules/k8s/renderer/fleet')
    expect(fleetNotes(result(), NOW)).toEqual([])
    const notes = fleetNotes(
      result({
        version: 'v1.34.2-eks-1',
        serverCertExpiry: '2026-10-16T00:00:00Z',
        clientCertExpiry: '2026-10-01T00:00:00Z'
      }),
      NOW
    )
    expect(notes.map((n) => n.severity)).toEqual(['warning', 'warning', 'danger'])
    expect(notes[0]?.text).toContain('support ends in 21 days')
    expect(notes[0]?.text).toContain('EKS may support it longer')
    expect(notes[1]?.text).toContain('API server certificate expires in 9 days')
    expect(notes[2]?.text).toContain('client certificate in the kubeconfig expired')
    // Chứng chỉ còn lâu → không nhắc.
    expect(fleetNotes(result({ serverCertExpiry: '2027-10-01T00:00:00Z' }), NOW)).toEqual([])
  })

  it('số liệu: node chưa sẵn sàng đỏ, pod lỗi đếm cả kéo image, Pending chỉ hiện khi có', async () => {
    const { fleetStats } = await import('../../src/modules/k8s/renderer/fleet')
    expect(fleetStats(result()).map((s) => [s.label, s.value, s.tone])).toEqual([
      ['Nodes', '3/3', 'ok'],
      ['Failing pods', '0', 'muted']
    ])
    const r = result({
      nodes: { total: 3, ready: 2 },
      problems: {
        failing: group(2),
        imagePull: group(1),
        nodes: group(1),
        pending: group(4),
        pvcs: group(0)
      }
    })
    expect(fleetStats(r).map((s) => [s.label, s.value, s.tone])).toEqual([
      ['Nodes', '2/3', 'danger'],
      ['Failing pods', '3', 'danger'],
      ['Pending', '4', 'warning']
    ])
  })
})

describe('Tóm tắt Docker', () => {
  it('đếm unhealthy / restarting / thoát lỗi; thoát 0 và dừng tay (137 / 143) không tính', async () => {
    const { containerCounts, dockerStats } = await import('../../src/modules/docker/renderer/fleet')
    const row = (
      name: string,
      state: string,
      status: string,
      health: 'unhealthy' | null = null
    ) => ({
      id: name,
      name,
      image: 'shop/api:1.2',
      state,
      status,
      health,
      created: 0,
      ports: [],
      project: null,
      service: null,
      composeDir: null,
      composeFiles: null
    })
    const rows = [
      row('api', 'running', 'Up 2 days (unhealthy)', 'unhealthy'),
      row('worker', 'restarting', 'Restarting (1) 5 seconds ago'),
      row('job', 'exited', 'Exited (2) 1 hour ago'),
      row('done', 'exited', 'Exited (0) 1 hour ago'),
      row('stopped', 'exited', 'Exited (137) 1 hour ago'),
      row('web', 'running', 'Up 3 hours')
    ]
    expect(containerCounts(rows)).toEqual({
      total: 6,
      running: 2,
      unhealthy: 1,
      restarting: 1,
      failed: 1
    })
    expect(dockerStats(rows).map((s) => [s.label, s.value])).toEqual([
      ['Running', '2/6'],
      ['Restarting', '1'],
      ['Unhealthy', '1'],
      ['Exited with error', '1']
    ])
  })
})

describe('Store + lựa chọn theo dõi', () => {
  it('mặc định: Production thì theo dõi; lựa chọn riêng thắng; hàng có vấn đề lên đầu', async () => {
    const { fleetItems, isMonitored, useFleet } =
      await import('../../src/renderer/src/stores/fleet')
    expect(isMonitored({}, 'k8s:a', 'prod')).toBe(true)
    expect(isMonitored({}, 'k8s:a', 'dev')).toBe(false)
    expect(isMonitored({}, 'k8s:a', null)).toBe(false)
    expect(isMonitored({ 'k8s:a': false }, 'k8s:a', 'prod')).toBe(false)
    expect(isMonitored({ 'k8s:a': true }, 'k8s:a', 'dev')).toBe(true)
    const base = { module: 'k8s', kind: 'Kubernetes', stats: [], notes: [] }
    const s = useFleet.getState()
    s.put({ ...base, id: 'k8s:b', title: 'b', state: 'ok' })
    s.put({ ...base, id: 'k8s:a', title: 'a', state: 'ok' })
    s.put({ ...base, id: 'k8s:z', title: 'z', state: 'error' })
    expect(fleetItems(useFleet.getState().items).map((i) => i.id)).toEqual([
      'k8s:z',
      'k8s:a',
      'k8s:b'
    ])
    s.remove('k8s:z')
    s.remove('k8s:none')
    expect(Object.keys(useFleet.getState().items).sort()).toEqual(['k8s:a', 'k8s:b'])
  })

  it('cài đặt: sourceMonitor gộp vào bảng, null = về mặc định', async () => {
    const { applyPatch, DEFAULT_SETTINGS } = await import('../../src/shared/settings')
    expect(DEFAULT_SETTINGS.appearance.homeMonitor).toBe(true)
    let s = applyPatch(DEFAULT_SETTINGS, {
      sourceMonitor: { 'k8s:a': false, 'docker:local': true }
    })
    s = applyPatch(s, { sourceMonitor: { 'k8s:a': null } })
    expect(s.sourceMonitor).toEqual({ 'docker:local': true })
  })
})

describe('Phiên chạy nền', () => {
  type Fake = {
    events: ModuleSessionEvents
    closed: boolean
    answered: number[]
    requests: unknown[]
  }

  async function harness() {
    const { BackgroundSession } = await import('../../src/modules/registry/renderer-background')
    const opened: Fake[] = []
    const ready: number[] = []
    const failed: [string, string][] = []
    let resolveHost: () => void = () => undefined
    const session = new BackgroundSession(
      'k8s',
      () => ({ kind: 'module', sessionKind: 'cluster', params: {} }),
      {
        ready: (client) => {
          ready.push(opened.length)
          return client.request({ op: 'connect' }).then(() => undefined)
        },
        failed: (state, message) => {
          failed.push([state, message])
        }
      },
      {
        open: (_m, _t, events) => {
          const fake: Fake = { events: events ?? {}, closed: false, answered: [], requests: [] }
          opened.push(fake)
          return Promise.resolve({
            request: (op: unknown) => {
              fake.requests.push(op)
              return Promise.resolve({})
            },
            answer: (id: number) => {
              fake.answered.push(id)
            },
            close: () => {
              fake.closed = true
            }
          } as never)
        },
        whenHostRunning: () =>
          new Promise<void>((resolve) => {
            resolveHost = resolve
          })
      }
    )
    return {
      session,
      opened,
      ready,
      failed,
      host: () => {
        resolveHost()
      }
    }
  }

  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('sẵn sàng một lần khi có client VÀ connected (thứ tự nào cũng được)', async () => {
    const { session, opened, ready } = await harness()
    session.start()
    // "connected" tới trước khi open() trả client.
    opened[0]?.events.onStatus?.('connected', '')
    await tick()
    expect(ready).toEqual([1])
    opened[0]?.events.onStatus?.('connected', '')
    await tick()
    expect(ready).toEqual([1])
    session.stop()
    expect(opened[0]?.closed).toBe(true)
  })

  it('prompt (mật khẩu / host key) → từ chối, báo cần đăng nhập, đóng phiên, hẹn thử lại', async () => {
    vi.useFakeTimers()
    try {
      const { session, opened, failed } = await harness()
      session.start()
      await vi.advanceTimersByTimeAsync(0)
      opened[0]?.events.onPrompt?.({ id: 7, request: { kind: 'password' } as never })
      expect(opened[0]?.answered).toEqual([7])
      expect(opened[0]?.closed).toBe(true)
      expect(failed[0]?.[0]).toBe('signin')
      // Callback muộn của phiên cũ bị bỏ qua.
      opened[0]?.events.onExit?.('closed' as never)
      expect(failed).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(opened).toHaveLength(2)
      session.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Session Host khởi động lại → đợi chạy rồi mở phiên mới; later() của phiên cũ bị huỷ', async () => {
    vi.useFakeTimers()
    try {
      const { session, opened, host } = await harness()
      session.start()
      await vi.advanceTimersByTimeAsync(0)
      let fired = 0
      session.later(1000, () => {
        fired++
      })
      opened[0]?.events.onHostRestart?.()
      expect(opened[0]?.closed).toBe(true)
      host()
      await vi.advanceTimersByTimeAsync(1000)
      expect(opened).toHaveLength(2)
      expect(fired).toBe(0)
      session.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lỗi xác thực trong ready → signin; lỗi khác → error', async () => {
    const { isSignInError } = await import('../../src/modules/registry/renderer-background')
    expect(isSignInError(new Error('aws could not get a token: ExpiredToken'))).toBe(true)
    expect(isSignInError(new Error('Unauthorized'))).toBe(true)
    expect(isSignInError(new Error('connect ECONNREFUSED 10.0.0.1:6443'))).toBe(false)
  })
})
