import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { ModuleSuggestion } from '../ModuleSuggestion'

/**
 * Gợi ý bật module khi máy này có dấu hiệu (kubeconfig, socket Docker…) — kiểm một lần lúc mở app,
 * hiện ở cuối cây host (module đã bật có khu vực riêng trên activity bar).
 */
export function LocalModuleSuggestion(): React.JSX.Element | null {
  const [local, setLocal] = useState<string[]>([])
  useEffect(() => {
    window.shellhouse.detectLocalModules().then(setLocal, () => undefined)
  }, [])
  if (local.length === 0) return null
  return (
    <ModuleSuggestion
      candidates={local}
      where={t('on this computer')}
      className="mt-2 h-auto min-h-8 flex-wrap rounded-md border py-1"
    />
  )
}
