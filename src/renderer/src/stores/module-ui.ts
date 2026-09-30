import { create } from 'zustand'
import { manifestOf } from '../../../modules/registry/manifests'
import { setModuleEnabled } from '../../../modules/registry/renderer-kit'
import { useTabs } from './tabs'
import { useSettings } from './settings'

/**
 * Bật / tắt module từ giao diện (ADR-014 mục 3.12): lần đầu bật → hộp xác nhận liệt kê quyền;
 * tắt khi còn tab của module → hỏi đóng.
 */
interface ModuleUi {
  /** Module đang chờ người dùng xác nhận quyền. */
  confirming: string | null
  /** Trang Settings → Modules được yêu cầu mở (id module = mở trang chi tiết). */
  browse: { module: string | null; seq: number } | null
  setConfirming: (id: string | null) => void
}

export const useModuleUi = create<ModuleUi>((set) => ({
  confirming: null,
  browse: null,
  setConfirming: (id) => {
    set({ confirming: id })
  }
}))

/** Mở Settings → Modules (tuỳ chọn: thẳng trang chi tiết của một module). */
export function browseModules(module: string | null = null): void {
  useModuleUi.setState((s) => ({ browse: { module, seq: (s.browse?.seq ?? 0) + 1 } }))
}

/** Bật module: hỏi xác nhận quyền nếu người dùng chưa từng xác nhận. */
export async function requestEnableModule(id: string): Promise<void> {
  const confirmed = useSettings.getState().settings.modules[id]?.['confirmed'] === true
  if (!confirmed && (manifestOf(id)?.permissions.length ?? 0) > 0) {
    useModuleUi.getState().setConfirming(id)
    return
  }
  await setModuleEnabled(id, true)
}

/** Người dùng đã đọc quyền và đồng ý. */
export async function confirmEnableModule(id: string): Promise<void> {
  useModuleUi.getState().setConfirming(null)
  await useSettings.getState().update({ modules: { [id]: { confirmed: true } } })
  await setModuleEnabled(id, true)
}

/** Tắt module; còn tab của nó đang mở → hỏi trước (các tab sẽ đóng). false = người dùng huỷ. */
export async function requestDisableModule(id: string): Promise<boolean> {
  const open = useTabs
    .getState()
    .tabs.filter(
      (t) =>
        (t.target.kind === 'module' || t.target.kind === 'module-terminal') &&
        t.target.module === id
    ).length
  const name = manifestOf(id)?.name ?? id
  if (open > 0 && !window.confirm(`Turn off ${name}? Its ${open} open tab(s) will be closed.`))
    return false
  await setModuleEnabled(id, false)
  return true
}

// ——— Gợi ý đúng lúc (ADR-014 mục 3.12.4) ———

const SUGGEST_EVERY_MS = 30 * 24 * 3600 * 1000
const PROBE_EVERY_MS = 7 * 24 * 3600 * 1000
const PROBE_KEY = 'shellhouse.moduleProbe'

/** Trong các module có dấu hiệu, những module nên gợi ý lúc này (đang tắt, chưa bị từ chối…). */
export function suggestable(ids: readonly string[], now = Date.now()): string[] {
  const { settings } = useSettings.getState()
  if (!settings.moduleOptions.suggest) return []
  return ids.filter((id) => {
    const entry = settings.modules[id]
    const manifest = manifestOf(id)
    if (!manifest || entry?.neverSuggest) return false
    const enabled = entry?.enabled ?? manifest.enabledByDefault
    if (enabled) return false
    return entry?.suggestedAt === undefined || now - entry.suggestedAt > SUGGEST_EVERY_MS
  })
}

/** Đã hiện gợi ý → không hiện lại trong 30 ngày. */
export function markSuggested(id: string, now = Date.now()): void {
  void useSettings.getState().update({ modules: { [id]: { suggestedAt: now } } })
}

export function neverSuggest(id: string): void {
  void useSettings.getState().update({ modules: { [id]: { neverSuggest: true } } })
}

/** Nên dò host này chưa (mỗi host tối đa một lần / 7 ngày; nhớ trên máy này). */
export function shouldProbe(hostKey: string, now = Date.now()): boolean {
  if (!useSettings.getState().settings.moduleOptions.suggest) return false
  let seen: Record<string, number>
  try {
    seen = JSON.parse(localStorage.getItem(PROBE_KEY) ?? '{}') as Record<string, number>
  } catch {
    seen = {}
  }
  const last = seen[hostKey]
  if (last !== undefined && now - last < PROBE_EVERY_MS) return false
  seen[hostKey] = now
  try {
    localStorage.setItem(PROBE_KEY, JSON.stringify(seen))
  } catch {
    // Không lưu được — lần sau dò lại, không sao.
  }
  return true
}
