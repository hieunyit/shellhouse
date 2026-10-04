import { useEffect } from 'react'
import { create } from 'zustand'
import {
  chooseRdpEngine,
  type RdpEngineChoice,
  type RdpNativeAvailability
} from '@shared/rdp-native'
import { useHosts } from '../stores/hosts'
import { isWindows } from '../lib/platform'

/**
 * Engine của từng tab Remote Desktop: control gốc của Windows hay IronRDP. Chọn MỘT LẦN khi tab mở
 * (sửa host trong lúc tab đang mở không đổi engine giữa chừng — sẽ làm rớt phiên); "Open in IronRDP"
 * đổi engine của riêng tab đó.
 */
interface EngineState {
  /** null = chưa hỏi main. */
  availability: RdpNativeAvailability | null
  byTab: Record<string, RdpEngineChoice>
}

export const useRdpEngine = create<EngineState>(() => ({ availability: null, byTab: {} }))

let loading: Promise<void> | null = null

/** Hỏi main một lần: có control gốc / tiến trình phụ trên máy này không. */
export function loadNativeAvailability(): Promise<void> {
  loading ??= window.shellhouse.rdpNativeAvailable().then(
    (availability) => {
      useRdpEngine.setState({ availability })
    },
    () => {
      useRdpEngine.setState({ availability: { available: false, reason: null } })
    }
  )
  return loading
}

/** Đặt engine cho một tab (nút "Open in IronRDP" trên tab native). */
export function setTabEngine(tabId: string, engine: RdpEngineChoice): void {
  useRdpEngine.setState((s) => ({ byTab: { ...s.byTab, [tabId]: engine } }))
}

/** Engine của tab; null = đang hỏi main (chỉ trên Windows, vài ms lúc mở tab đầu tiên). */
export function useTabEngine(tabId: string, hostId: string): RdpEngineChoice | null {
  const pinned = useRdpEngine((s) => s.byTab[tabId])
  const availability = useRdpEngine((s) => s.availability)
  const engine = useHosts((s) => s.tree.hosts.find((h) => h.id === hostId)?.rdp?.engine)
  const windows = isWindows()
  const decided: RdpEngineChoice | null =
    pinned ??
    (!windows
      ? 'ironrdp'
      : availability
        ? chooseRdpEngine({
            platform: 'win32',
            nativeAvailable: availability.available,
            engine
          })
        : null)

  useEffect(() => {
    if (windows && !availability) void loadNativeAvailability()
  }, [windows, availability])

  useEffect(() => {
    if (decided && !pinned) setTabEngine(tabId, decided)
  }, [decided, pinned, tabId])

  return decided
}
