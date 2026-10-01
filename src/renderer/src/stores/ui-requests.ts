import { create } from 'zustand'
import { useSettings } from './settings'

/**
 * Yêu cầu mở hộp thoại của thanh bên từ nơi khác (màn chào, bảng lệnh): thanh bên giữ hộp thoại
 * "New host" / "Import" nên nó tự lắng nghe và mở. `seq` tăng mỗi lần để yêu cầu lặp lại vẫn chạy.
 */
export type SidebarRequest = 'new-host' | 'import-hosts' | 'edit-host'

interface UiRequests {
  sidebar: { kind: SidebarRequest; hostId?: string; seq: number } | null
  requestSidebar: (kind: SidebarRequest, hostId?: string) => void
}

export const useUiRequests = create<UiRequests>((set, get) => ({
  sidebar: null,
  requestSidebar: (kind, hostId) => {
    set({ sidebar: { kind, ...(hostId ? { hostId } : {}), seq: (get().sidebar?.seq ?? 0) + 1 } })
  }
}))

/** Mở "New host" / "Import" / sửa host từ bất kỳ đâu: thanh bên đang ẩn thì hiện ra trước. */
export async function openSidebarDialog(kind: SidebarRequest, hostId?: string): Promise<void> {
  const { settings, update } = useSettings.getState()
  if (settings.appearance.sidebarHidden) await update({ appearance: { sidebarHidden: false } })
  requestAnimationFrame(() => {
    useUiRequests.getState().requestSidebar(kind, hostId)
  })
}

/** Đưa con trỏ vào ô Quick connect trên thanh công cụ. */
export function focusQuickConnect(): void {
  document.querySelector<HTMLInputElement>('[data-testid="quick-connect"]')?.focus()
}
