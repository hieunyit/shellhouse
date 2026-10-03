import { useEffect, useState } from 'react'
import { Puzzle } from 'lucide-react'
import { t } from '@shared/i18n'
import { ModuleSuggestion } from '../ModuleSuggestion'
import { useEnabledModules } from '../../../../modules/registry/renderer-kit'
import { browseModules } from '../../stores/module-ui'

/** Mục thanh bên của các module đang bật, theo thứ tự đăng ký (ADR-014 mục 3.8). */
export function ModuleSections(): React.JSX.Element {
  const modules = useEnabledModules()
  // Dấu hiệu trên máy này (kubeconfig, socket Docker…) — kiểm một lần lúc mở app.
  const [local, setLocal] = useState<string[]>([])
  useEffect(() => {
    window.shellhouse.detectLocalModules().then(setLocal, () => undefined)
  }, [])
  return (
    <>
      {local.length > 0 && (
        <ModuleSuggestion
          candidates={local}
          where={t('on this computer')}
          className="mt-2 h-auto min-h-8 flex-wrap rounded-md border py-1"
        />
      )}
      {modules.map((m) => {
        const Section = m.SidebarSection
        // Neo cho thanh icon (bấm icon module → mở thanh bên tới đúng mục).
        return Section ? (
          <div key={m.manifest.id} data-module-section={m.manifest.id} className="scroll-mt-2">
            <Section />
          </div>
        ) : null
      })}
      <button
        type="button"
        data-testid="sidebar-add-module"
        className="mt-2 flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-xs text-faint hover:bg-hover hover:text-fg"
        onClick={() => {
          browseModules()
        }}
      >
        <Puzzle size={13} /> {t('Add module…')}
      </button>
    </>
  )
}
