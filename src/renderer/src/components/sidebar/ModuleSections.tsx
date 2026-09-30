import { Puzzle } from 'lucide-react'
import { useEnabledModules } from '../../../../modules/registry/renderer-kit'
import { browseModules } from '../../stores/module-ui'

/** Mục thanh bên của các module đang bật, theo thứ tự đăng ký (ADR-014 mục 3.8). */
export function ModuleSections(): React.JSX.Element {
  const modules = useEnabledModules()
  return (
    <>
      {modules.map((m) => {
        const Section = m.SidebarSection
        return Section ? <Section key={m.manifest.id} /> : null
      })}
      <button
        type="button"
        data-testid="sidebar-add-module"
        className="mt-2 flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-xs text-faint hover:bg-hover hover:text-fg"
        onClick={() => {
          browseModules()
        }}
      >
        <Puzzle size={13} /> Add module…
      </button>
    </>
  )
}
