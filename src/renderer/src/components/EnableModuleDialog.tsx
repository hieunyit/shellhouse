import { ShieldCheck } from 'lucide-react'
import { manifestOf } from '../../../modules/registry/manifests'
import { ModuleIcon } from '../../../modules/registry/renderer-kit'
import { confirmEnableModule, useModuleUi } from '../stores/module-ui'
import { describeContributions, permissionLines } from './settings/ModulesSection'
import { Button, Modal } from './ui'

/** Hộp xác nhận khi bật module lần đầu: liệt kê quyền bằng câu dễ hiểu (ADR-014 mục 3.12.3). */
export function EnableModuleDialog(): React.JSX.Element | null {
  const id = useModuleUi((s) => s.confirming)
  const manifest = id ? manifestOf(id) : undefined
  if (!id || !manifest) return null
  const close = (): void => {
    useModuleUi.getState().setConfirming(null)
  }
  return (
    <Modal
      title={`Enable ${manifest.name}?`}
      description={manifest.summary}
      onClose={close}
      testId="module-enable-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="module-enable-confirm"
            onClick={() => void confirmEnableModule(id)}
          >
            Enable
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="flex items-center gap-2 text-muted">
          <ModuleIcon name={manifest.icon} size={15} className="text-accent" />{' '}
          {describeContributions(manifest)}
        </p>
        <div>
          <p className="mb-1 flex items-center gap-1.5 font-medium text-fg">
            <ShieldCheck size={14} /> This module:
          </p>
          <ul className="flex flex-col gap-1 text-fg">
            {permissionLines(manifest).map((line) => (
              <li key={line} className="flex gap-2">
                <span className="text-faint">•</span>
                {line}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  )
}
