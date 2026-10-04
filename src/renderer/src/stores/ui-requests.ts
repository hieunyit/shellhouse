import { create } from 'zustand'
import { useSettings } from './settings'

/**
 * Yêu cầu mở hộp thoại của thanh bên từ nơi khác (màn chào, bảng lệnh): thanh bên giữ hộp thoại
 * "New host" / "Import" nên nó tự lắng nghe và mở. `seq` tăng mỗi lần để yêu cầu lặp lại vẫn chạy.
 */
export type SidebarRequest = 'new-host' | 'import-hosts' | 'edit-host' | 'export-hosts'

export interface HostPrefill {
  hostname: string
  port: number
  username: string
  jumpHostIds?: string[]
}

interface UiRequests {
  sidebar: { kind: SidebarRequest; hostId?: string; prefill?: HostPrefill; seq: number } | null
  requestSidebar: (kind: SidebarRequest, hostId?: string, prefill?: HostPrefill) => void
}

export const useUiRequests = create<UiRequests>((set, get) => ({
  sidebar: null,
  requestSidebar: (kind, hostId, prefill) => {
    set({
      sidebar: {
        kind,
        ...(hostId ? { hostId } : {}),
        ...(prefill ? { prefill } : {}),
        seq: (get().sidebar?.seq ?? 0) + 1
      }
    })
  }
}))

/** Mở "New host" / "Import" / sửa host từ bất kỳ đâu: thanh bên đang ẩn thì hiện ra trước. */
export async function openSidebarDialog(
  kind: SidebarRequest,
  hostId?: string,
  prefill?: HostPrefill
): Promise<void> {
  const { settings, update } = useSettings.getState()
  if (settings.appearance.sidebarHidden) await update({ appearance: { sidebarHidden: false } })
  requestAnimationFrame(() => {
    useUiRequests.getState().requestSidebar(kind, hostId, prefill)
  })
}

/** Đưa con trỏ vào ô Quick connect trên thanh công cụ. */
export function focusQuickConnect(): void {
  document.querySelector<HTMLInputElement>('[data-testid="quick-connect"]')?.focus()
}
