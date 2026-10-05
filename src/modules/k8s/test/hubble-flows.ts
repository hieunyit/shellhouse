import { writeMessage, type PbField } from '../session-host/protobuf'

/**
 * Flow mẫu của Hubble (message `flow.Flow`, số trường theo flow.proto của Cilium) cho test: bên
 * nguồn / đích là pod (kèm workload) hoặc địa chỉ ngoài cluster (identity world + tên DNS).
 */
export interface FlowSpec {
  from: { ns: string; pod: string; workload?: [kind: string, name: string] } | { ip: string }
  to:
    | { ns: string; pod: string; workload?: [kind: string, name: string] }
    | { ip: string; names?: string[] }
  port: number
  /** syn (mặc định) · ack (gói giữa chừng) · udp */
  packet?: 'syn' | 'ack' | 'udp'
  reply?: boolean
  dropped?: boolean
}

const endpoint = (e: FlowSpec['from'] | FlowSpec['to']): PbField[] =>
  'pod' in e
    ? [
        [2, 12345],
        [3, e.ns],
        [5, e.pod],
        ...(e.workload
          ? ([
              [
                6,
                [
                  [1, e.workload[1]],
                  [2, e.workload[0]]
                ]
              ]
            ] as PbField[])
          : [])
      ]
    : [[2, 2]]

export function hubbleFlow(spec: FlowSpec): Uint8Array {
  const packet = spec.packet ?? 'syn'
  const ip = (e: FlowSpec['from'] | FlowSpec['to'], fallback: string): string =>
    'ip' in e ? e.ip : fallback
  const l4: PbField[] =
    packet === 'udp'
      ? [
          [
            2,
            [
              [1, 40000],
              [2, spec.port]
            ]
          ]
        ]
      : [
          [
            1,
            [
              [1, 40000],
              [2, spec.port],
              [3, packet === 'syn' ? [[2, true]] : [[5, true]]]
            ]
          ]
        ]
  return writeMessage([
    [2, spec.dropped ? 2 : 1],
    [
      5,
      [
        [1, ip(spec.from, '10.0.0.1')],
        [2, ip(spec.to, '10.0.0.2')]
      ]
    ],
    [6, l4],
    [8, endpoint(spec.from)],
    [9, endpoint(spec.to)],
    [10, 1],
    [11, 'node-1'],
    ...('names' in spec.to ? (spec.to.names ?? []) : []).map((n): PbField => [14, n]),
    ...(spec.reply ? ([[26, [[1, true]]]] as PbField[]) : [])
  ])
}
