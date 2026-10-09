import { useEffect, useState } from 'react'
import {
  ChevronRight,
  CopyPlus,
  Download,
  ListChecks,
  MoreHorizontal,
  Plus,
  Trash2,
  Upload
} from 'lucide-react'
import { cx, IconButton } from '../../../renderer/src/components/ui'
import { useContextMenu } from '../../../renderer/src/components/ContextMenu'
import {
  closeTabNow,
  confirmAction,
  findModuleTab,
  t,
  tn,
  toast
} from '../../registry/renderer-kit'
import { duplicateRunbook, exportToFile, importFromFile, openRunbook } from './actions'
import { runbookApi } from './api'
import { useRunbooks } from './store'

export { openRunbook }

/** Mục "Runbooks" ở thanh bên: danh sách runbook đã lưu, bấm để mở / chạy. */
export function RunbookSection(): React.JSX.Element {
  const runbooks = useRunbooks((s) => s.runbooks)
  const loaded = useRunbooks((s) => s.loaded)
  const [open, setOpen] = useState(true)
  const { menu, open: openMenu } = useContextMenu()
  useEffect(() => {
    void useRunbooks.getState().reload()
  }, [])
  return (
    <div data-testid="runbook-section">
      <div className="flex h-7 items-center gap-1.5 px-1 text-xs font-medium text-faint">
        <button
          type="button"
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 hover:text-muted"
          onClick={() => {
            setOpen(!open)
          }}
        >
          <ChevronRight
            size={13}
            className={cx('transition-transform duration-150', open && 'rotate-90')}
          />
          <span className="flex-1 text-left">{t('Runbooks')}</span>
        </button>
        <IconButton
          label={t('Import / export')}
          size="sm"
          data-testid="runbook-more"
          onClick={(e) => {
            openMenu(e, [
              {
                id: 'runbook-import',
                label: t('Import runbooks…'),
                icon: <Upload size={14} />,
                onSelect: () => void importFromFile()
              },
              {
                id: 'runbook-export-all',
                label: t('Export all runbooks…'),
                icon: <Download size={14} />,
                disabled: runbooks.length === 0,
                onSelect: () => void exportToFile(runbooks, 'runbooks')
              }
            ])
          }}
        >
          <MoreHorizontal size={13} />
        </IconButton>
        <IconButton
          label={t('New runbook')}
          size="sm"
          data-testid="runbook-new"
          onClick={() => {
            openRunbook()
          }}
        >
          <Plus size={13} />
        </IconButton>
      </div>
      {open && loaded && runbooks.length === 0 && (
        <p className="px-3 py-2 text-xs text-faint" data-testid="runbook-section-empty">
          {t('Save the checks you run after a deploy, then run them in one click.')}
        </p>
      )}
      {open &&
        runbooks.map((r) => (
          <div
            key={r.id}
            role="button"
            tabIndex={0}
            data-testid="runbook-row"
            data-name={r.name}
            title={r.description || tn(r.steps.length, '{n} step', '{n} steps')}
            className="group flex h-(--ds-tree-row-h) cursor-default items-center gap-2 rounded-ds-md px-2 outline-none hover:bg-ds-hover focus-visible:shadow-ds-focus"
            onClick={() => {
              openRunbook(r.id)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openRunbook(r.id)
            }}
            onContextMenu={(e) => {
              openMenu(e, [
                {
                  id: 'runbook-open',
                  label: t('Open'),
                  icon: <ListChecks size={14} />,
                  onSelect: () => {
                    openRunbook(r.id)
                  }
                },
                {
                  id: 'runbook-duplicate',
                  label: t('Duplicate'),
                  icon: <CopyPlus size={14} />,
                  onSelect: () => void duplicateRunbook(r)
                },
                {
                  id: 'runbook-export',
                  label: t('Export…'),
                  icon: <Download size={14} />,
                  onSelect: () => void exportToFile([r], r.name)
                },
                'separator',
                {
                  id: 'runbook-delete',
                  label: t('Delete'),
                  icon: <Trash2 size={14} />,
                  danger: true,
                  onSelect: () => {
                    void confirmAction({
                      title: t('Delete “{name}”?', { name: r.name }),
                      message: t('The runbook and its steps are deleted. This cannot be undone.'),
                      confirmLabel: t('Delete'),
                      danger: true,
                      testId: 'runbook-delete-confirm'
                    }).then(async (ok) => {
                      if (!ok) return
                      await runbookApi.remove(r.id)
                      // Tab đang mở runbook này không còn gì để sửa / chạy.
                      const tab = findModuleTab(
                        'runbook',
                        (p) => (p as { id?: string } | null)?.id === r.id
                      )
                      if (tab) closeTabNow(tab)
                      void useRunbooks.getState().reload()
                      toast.success(t('Deleted'))
                    })
                  }
                }
              ])
            }}
          >
            <ListChecks size={14} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{r.name}</span>
            <span className="shrink-0 text-[11px] text-faint tabular-nums">{r.steps.length}</span>
          </div>
        ))}
      {menu}
    </div>
  )
}
