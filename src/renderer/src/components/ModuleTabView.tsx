import { createElement } from 'react'
import { Puzzle, Server, House, SquareTerminal, type LucideIcon } from 'lucide-react'
import {
  moduleIcon,
  moduleTab,
  rendererModule,
  setModuleEnabled,
  useModuleEnabled,
  useModules
} from '../../../modules/registry/renderer-kit'
import { manifestOf } from '../../../modules/registry/manifests'
import type { ModuleTabTarget, TabTarget } from '../stores/tabs'
import { Button, Notice } from './ui'

/** Tab của module (ADR-014 mục 3.8): tra registry thay cho nhánh `if (kind === 's3')`. */
export function ModuleTabView({
  tabId,
  target,
  active,
  visible
}: {
  tabId: string
  target: ModuleTabTarget
  active: boolean
  visible: boolean
}): React.JSX.Element | null {
  const enabled = useModuleEnabled(target.module)
  const loaded = useModules((s) => s.loaded)
  const def = moduleTab(target.module, target.tab)
  if (!loaded) return null
  const name = manifestOf(target.module)?.name ?? target.module
  if (!enabled || !def)
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center"
        data-testid="module-off"
      >
        <Puzzle size={28} className="text-faint" />
        <p className="text-sm text-muted">
          {def ? `The ${name} module is turned off.` : `This tab needs the ${name} module.`}
        </p>
        {def && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void setModuleEnabled(target.module, true)
            }}
          >
            Enable {name}
          </Button>
        )}
      </div>
    )
  const parsed = def.params.safeParse(target.params)
  if (!parsed.success)
    return (
      <div className="p-6">
        <Notice tone="danger">
          This tab can no longer be opened (its saved location is invalid).
        </Notice>
      </div>
    )
  const Component = def.component
  return <Component tabId={tabId} params={parsed.data} active={active} visible={visible} />
}

/** Icon của tab theo loại (tab module lấy từ định nghĩa tab / manifest). */
export function TabIcon({
  target,
  size,
  className
}: {
  target: TabTarget | undefined
  size: number
  className?: string
}): React.JSX.Element {
  let icon: LucideIcon = Server
  if (target?.kind === 'home') icon = House
  else if (!target || target.kind === 'local' || target.kind === 'module-terminal')
    icon = SquareTerminal
  else if (target.kind === 'module')
    icon =
      (moduleTab(target.module, target.tab)?.icon as LucideIcon | undefined) ??
      moduleIcon(rendererModule(target.module)?.manifest.icon)
  return createElement(icon, { size, className })
}
