import { describe, expect, it } from 'vitest'
import { rolloutState } from '../../shared/rollout'

const deploy = (spec: object, status: object, generation = 1) => ({
  metadata: { generation },
  spec,
  status: { observedGeneration: generation, ...status }
})

describe('rolloutState — kiểm tra triển khai xong chưa', () => {
  it('Deployment: đủ bản mới, sẵn sàng, available, không còn bản cũ → sẵn sàng', () => {
    const r = rolloutState(
      'deployments.apps',
      deploy(
        { replicas: 3 },
        { replicas: 3, updatedReplicas: 3, readyReplicas: 3, availableReplicas: 3 }
      )
    )
    expect(r).toEqual({ ready: true, detail: '3/3 replicas ready, 3 updated' })
  })

  it('Deployment: đang cuốn chiếu (còn bản cũ / chưa đủ sẵn sàng) → chưa xong, nói rõ số', () => {
    const rolling = rolloutState(
      'deployments.apps',
      deploy(
        { replicas: 3 },
        { replicas: 4, updatedReplicas: 2, readyReplicas: 3, availableReplicas: 3 }
      )
    )
    expect(rolling.ready).toBe(false)
    expect(rolling.detail).toBe('3/3 replicas ready, 2 updated')
    expect(
      rolloutState(
        'deployments.apps',
        deploy(
          { replicas: 2 },
          { updatedReplicas: 2, readyReplicas: 1, availableReplicas: 1, replicas: 2 }
        )
      ).ready
    ).toBe(false)
  })

  it('controller chưa thấy bản mới (observedGeneration < generation) → chưa xong dù số đếm trông đủ', () => {
    const r = rolloutState('deployments.apps', {
      metadata: { generation: 5 },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 4,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1
      }
    })
    expect(r.ready).toBe(false)
    expect(r.detail).toMatch(/notice the latest change/)
  })

  it('scale về 0 không phải "sẵn sàng"; mặc định replicas = 1; tạm dừng rollout báo riêng', () => {
    const zero = rolloutState('deployments.apps', deploy({ replicas: 0 }, {}))
    expect(zero).toEqual({ ready: false, detail: 'Scaled to 0 — nothing is running' })
    const dflt = rolloutState(
      'deployments.apps',
      deploy({}, { replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 })
    )
    expect(dflt.ready).toBe(true)
    const paused = rolloutState(
      'deployments.apps',
      deploy(
        { replicas: 1, paused: true },
        { replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 }
      )
    )
    expect(paused).toEqual({ ready: false, detail: 'The rollout is paused' })
  })

  it('StatefulSet: sẵn sàng khi ready và updated đều bằng replicas', () => {
    expect(
      rolloutState(
        'statefulsets.apps',
        deploy({ replicas: 2 }, { readyReplicas: 2, updatedReplicas: 2 })
      ).ready
    ).toBe(true)
    expect(
      rolloutState(
        'statefulsets.apps',
        deploy({ replicas: 2 }, { readyReplicas: 2, updatedReplicas: 1 })
      ).ready
    ).toBe(false)
  })

  it('DaemonSet: mọi pod sẵn sàng và đã cập nhật, không pod nào unavailable; không có node nào → chưa', () => {
    const ok = { desiredNumberScheduled: 3, numberReady: 3, updatedNumberScheduled: 3 }
    expect(rolloutState('daemonsets.apps', deploy({}, ok)).ready).toBe(true)
    expect(rolloutState('daemonsets.apps', deploy({}, { ...ok, numberUnavailable: 1 })).ready).toBe(
      false
    )
    expect(rolloutState('daemonsets.apps', deploy({}, { ...ok, numberReady: 2 })).detail).toBe(
      '2/3 pods ready, 3 updated'
    )
    expect(rolloutState('daemonsets.apps', deploy({}, {})).detail).toBe(
      'No node runs this DaemonSet'
    )
  })

  it('đối tượng rỗng / thiếu trường → không sập, chưa sẵn sàng', () => {
    expect(rolloutState('deployments.apps', null).ready).toBe(false)
    expect(rolloutState('statefulsets.apps', {}).ready).toBe(false)
  })
})
