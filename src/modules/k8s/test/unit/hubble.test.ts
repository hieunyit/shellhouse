import { describe, expect, it } from 'vitest'
import { flowLink } from '../../session-host/hubble'
import { GrpcFrameReader, grpcFrame, readMessage, writeMessage } from '../../session-host/protobuf'
import { hubbleFlow } from '../hubble-flows'

const link = (spec: Parameters<typeof hubbleFlow>[0]): ReturnType<typeof flowLink> =>
  flowLink(readMessage(hubbleFlow(spec)))

describe('Hubble: flow → kết nối', () => {
  it('pod → pod: quy về workload (như Caretta), cổng đích', () => {
    expect(
      link({
        from: {
          ns: 'ingress-nginx',
          pod: 'ctrl-1',
          workload: ['Deployment', 'ingress-nginx-controller']
        },
        to: { ns: 'console-stg', pod: 'backend-6c-x', workload: ['Deployment', 'console-backend'] },
        port: 8080
      })
    ).toEqual({
      client: { ns: 'ingress-nginx', name: 'ingress-nginx-controller', kind: 'Deployment' },
      server: { ns: 'console-stg', name: 'console-backend', kind: 'Deployment' },
      port: '8080'
    })
  })

  it('đích ngoài cluster: tên miền từ DNS của Cilium, không có thì IP', () => {
    const from = {
      ns: 'console-stg',
      pod: 'b',
      workload: ['Deployment', 'console-backend'] as [string, string]
    }
    expect(
      link({ from, to: { ip: '104.26.12.64', names: ['api.stripe.com'] }, port: 443 })?.server
    ).toEqual({
      ns: '',
      name: 'api.stripe.com',
      kind: 'external'
    })
    expect(link({ from, to: { ip: '10.152.3.127' }, port: 5432 })?.server.name).toBe('10.152.3.127')
  })

  it('chỉ đếm gói mở kết nối (SYN) và UDP; bỏ gói giữa chừng, gói trả lời, bị chặn', () => {
    const base = {
      from: { ns: 'a', pod: 'p' },
      to: { ns: 'b', pod: 'q' },
      port: 53
    }
    expect(link({ ...base, packet: 'syn' })).not.toBeNull()
    expect(link({ ...base, packet: 'udp' })).not.toBeNull()
    expect(link({ ...base, packet: 'ack' })).toBeNull()
    expect(link({ ...base, reply: true })).toBeNull()
    expect(link({ ...base, dropped: true })).toBeNull()
    // Pod không có workload (pod lẻ) → chính pod.
    expect(link(base)?.client).toEqual({ ns: 'a', name: 'p', kind: 'Pod' })
  })

  it('protobuf: ghi / đọc lại; khung gRPC tách đúng khi bị cắt giữa chừng', () => {
    const m = readMessage(
      writeMessage([
        [1, 'x'],
        [3, true],
        [7, [[1, 300]]]
      ])
    )
    expect(m.get(3)?.[0]).toEqual({ kind: 'varint', value: 1n })
    const frames = Buffer.concat([
      grpcFrame(writeMessage([[1, 'a']])),
      grpcFrame(writeMessage([[1, 'bb']]))
    ])
    const got: number[] = []
    const reader = new GrpcFrameReader()
    reader.push(frames.subarray(0, 7), (msg) => got.push(msg.length))
    reader.push(frames.subarray(7), (msg) => got.push(msg.length))
    expect(got).toEqual([3, 4])
  })
})
