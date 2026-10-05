import { createContext, useContext } from 'react'
import { bandOf, formatRate, type TrafficSource, type TrafficUnit } from '../shared/traffic'

/**
 * Đơn vị traffic của cluster đang xem: byte / giây (Caretta) hay kết nối mới / giây (Hubble). Map,
 * Topology, tab Traffic đặt theo nguồn của chính chúng — mỗi tab cluster đúng đơn vị của nó.
 */
export const TrafficUnitContext = createContext<TrafficUnit>('bytes')

export function useTrafficUnit(): TrafficUnit {
  return useContext(TrafficUnitContext)
}

/** `rateText(unit)(rate)`: định dạng theo đơn vị (1.2 MB/s · 0.4 conn/s). */
export const rateText =
  (unit: TrafficUnit) =>
  (rate: number): string =>
    formatRate(rate, unit)

/** `bandFor(unit)(rate)`: băng độ dày / màu theo đơn vị. */
export const bandFor =
  (unit: TrafficUnit) =>
  (rate: number): number =>
    bandOf(rate, unit)

/** Dưới mức này là "idle" (không vẽ đậm / không ghi số): 1 B/s · 0.01 kết nối/s. */
export const idleBelow = (unit: TrafficUnit): number => (unit === 'connections' ? 0.01 : 1)

/** Tên nguồn traffic cho người dùng. */
export const sourceName = (source: TrafficSource | undefined): string =>
  source === 'hubble' ? 'Hubble' : 'Caretta'

/** Lệnh bật Hubble Relay trên cluster Cilium (cilium CLI). */
export const HUBBLE_ENABLE = 'cilium hubble enable'
