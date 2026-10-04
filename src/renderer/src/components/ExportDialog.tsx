import { useMemo, useState } from 'react'
import { Copy, Download, ShieldCheck } from 'lucide-react'
import { t, tn } from '@shared/i18n'
import { exportHosts, type ExportFormat } from '@shared/host-export'
import { useHosts } from '../stores/hosts'
import { toast } from '../stores/toasts'
import { GroupSelect } from './GroupSelect'
import { Button, Field, Modal, Segmented } from './ui'

const FILE_NAMES: Record<ExportFormat, string> = {
  yaml: 'shellhouse-hosts.yaml',
  ssh: 'ssh_config',
  csv: 'shellhouse-hosts.csv'
}

/**
 * Xuất danh sách host (thiết kế v0.7): Shellhouse YAML (giữ cây nhóm, môi trường, mặc định),
 * OpenSSH config, CSV; chọn phạm vi nhóm; xem trước; Copy / Save. Không bao giờ xuất mật khẩu /
 * khoá — chỉ tên tài khoản dùng chung.
 */
export function ExportDialog({
  initialGroup = null,
  onClose
}: {
  initialGroup?: string | null
  onClose: () => void
}): React.JSX.Element {
  const tree = useHosts((s) => s.tree)
  const [format, setFormat] = useState<ExportFormat>('yaml')
  const [scope, setScope] = useState<string | null>(initialGroup)
  const result = useMemo(() => exportHosts(tree, format, scope), [tree, format, scope])
  return (
    <Modal
      title={t('Export hosts')}
      onClose={onClose}
      width="max-w-2xl"
      testId="export-dialog"
      footer={
        <>
          <span className="mr-auto text-xs text-muted" data-testid="export-count">
            {tn(result.hosts, '{n} host', '{n} hosts')}
            {result.skipped.length > 0 &&
              ` · ${tn(result.skipped.length, '{n} skipped (not SSH)', '{n} skipped (not SSH)')}`}
          </span>
          <Button
            icon={<Copy size={14} />}
            data-testid="export-copy"
            onClick={() => {
              void window.shellhouse.writeClipboard(result.text).then(() => {
                toast.success(t('Copied'))
              })
            }}
          >
            {t('Copy')}
          </Button>
          <Button
            variant="primary"
            icon={<Download size={14} />}
            data-testid="export-save"
            onClick={() => {
              void window.shellhouse.saveTextFile(FILE_NAMES[format], result.text).then((path) => {
                if (!path) return
                toast.success(t('Saved {name}', { name: path }))
                onClose()
              })
            }}
          >
            {t('Save…')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-[auto_1fr] items-end gap-4">
          <Field label={t('Format')}>
            <Segmented
              value={format}
              testIdPrefix="export-format"
              options={[
                { value: 'yaml', label: t('Shellhouse YAML') },
                { value: 'ssh', label: t('OpenSSH config') },
                { value: 'csv', label: 'CSV' }
              ]}
              onChange={setFormat}
            />
          </Field>
          <Field label={t('Hosts in')}>
            <GroupSelect
              testId="export-scope"
              value={scope}
              onChange={setScope}
              noneLabel={t('All groups')}
              movingGroupId={null}
            />
          </Field>
        </div>
        <pre
          className="sh-selectable max-h-80 overflow-auto rounded-ds-md bg-subtle p-3 font-mono text-xs leading-relaxed text-fg"
          data-testid="export-preview"
        >
          {result.text}
        </pre>
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <ShieldCheck size={13} className="text-success" />
          {t('Passwords and keys are never exported — only the names of shared accounts.')}
        </p>
      </div>
    </Modal>
  )
}
