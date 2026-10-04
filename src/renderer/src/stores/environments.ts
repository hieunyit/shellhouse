import { environmentFromColor, findEnvironment, type EnvironmentDef } from '@shared/environments'
import type { GroupDefaults } from '@shared/hosts'
import { useHosts } from './hosts'
import { useSettings } from './settings'

/**
 * Môi trường (Settings › Environments) ở phía renderer: danh sách, môi trường của host (kế thừa từ
 * nhóm), của nhóm, của nguồn trong module (cluster, Docker endpoint, tài khoản S3).
 */
export function useEnvironments(): readonly EnvironmentDef[] {
  return useSettings((s) => s.settings.environments)
}

export function useEnvironment(id: string | null | undefined): EnvironmentDef | undefined {
  return useSettings((s) => findEnvironment(s.settings.environments, id))
}

/** Môi trường hiệu lực của host (nhóm gần nhất có đặt; không có → suy từ màu cũ). */
export function useHostEnvironment(hostId: string | null | undefined): EnvironmentDef | undefined {
  const id = useHosts((s) => (hostId ? (s.effective.get(hostId)?.environment ?? null) : null))
  return useEnvironment(id)
}

/** Môi trường nhóm TỰ đặt (không tính kế thừa) — nhãn hiện ở hàng nhóm. */
export function groupOwnEnvironment(defaults: GroupDefaults): string | undefined {
  return defaults.environment ?? environmentFromColor(defaults.color)
}

/** Khoá nguồn trong cài đặt `sourceEnvironments`. */
export function sourceKey(module: string, id: string): string {
  return `${module}:${id}`
}

/**
 * Môi trường của một nguồn trong module. `legacy`: giá trị suy từ cài đặt cũ của module (vd. context
 * Kubernetes màu đỏ = Production) khi người dùng chưa chọn môi trường.
 */
export function useSourceEnvironment(
  module: string,
  id: string | null | undefined,
  legacy?: string
): EnvironmentDef | undefined {
  return useSettings((s) =>
    findEnvironment(
      s.settings.environments,
      (id ? s.settings.sourceEnvironments[sourceKey(module, id)] : undefined) ?? legacy
    )
  )
}

export function setSourceEnvironment(
  module: string,
  id: string,
  env: string | null
): Promise<void> {
  return useSettings.getState().update({ sourceEnvironments: { [sourceKey(module, id)]: env } })
}

/** Bảng môi trường đã chọn cho các nguồn (`<module>:<id>` → id môi trường). */
export function useSourceEnvironmentMap(): Readonly<Record<string, string>> {
  return useSettings((s) => s.settings.sourceEnvironments)
}
