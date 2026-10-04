import { Check, Layers } from 'lucide-react'
import { t } from '@shared/i18n'
import type { EnvironmentDef } from '@shared/environments'
import { useShell } from '../shell/store'
import { confirmAction } from '../stores/confirm'
import { useEnvironments } from '../stores/environments'
import { toast } from '../stores/toasts'
import type { MenuEntry } from './ContextMenu'
import { cx } from './ui'

/**
 * Chọn môi trường (nhóm host, cluster, Docker endpoint, tài khoản S3): "None" + các môi trường
 * trong Settings › Environments; ô vuông magenta cho môi trường nổi bật.
 */
export function EnvironmentPicker({
  value,
  onChange,
  noneLabel,
  testIdPrefix
}: {
  value: string | null
  onChange: (id: string | null) => void
  /** Nhãn của lựa chọn "không đặt" ("None", "Inherit"…). */
  noneLabel?: string
  testIdPrefix: string
}): React.JSX.Element {
  const environments = useEnvironments()
  return (
    <div
      role="radiogroup"
      aria-label={t('Environment')}
      className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1.5"
    >
      {[null, ...environments].map((env) => {
        const checked = (env?.id ?? null) === value
        return (
          <button
            key={env?.id ?? 'none'}
            type="button"
            role="radio"
            aria-checked={checked}
            data-testid={`${testIdPrefix}-${env?.id ?? 'none'}`}
            className={cx(
              'flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-ds-md px-2 text-xs outline-none focus-visible:shadow-ds-focus',
              checked
                ? 'bg-ds-surface-2 text-fg shadow-[inset_0_0_0_1.5px_var(--ds-accent)]'
                : 'text-muted shadow-[inset_0_0_0_1px_var(--ds-border)] hover:text-fg'
            )}
            onClick={() => {
              onChange(env?.id ?? null)
            }}
          >
            {env && (
              <span
                aria-hidden
                className={cx(
                  'size-1.5 shrink-0 rounded-[1px]',
                  env.highlight ? 'bg-ds-env-prod' : 'bg-ds-fg-3'
                )}
              />
            )}
            <span className="truncate">{env ? env.name : (noneLabel ?? t('None'))}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Tóm tắt quy tắc sẽ áp dụng: "Type name to delete · read-only · line at the top". */
export function environmentRules(env: EnvironmentDef): string {
  return [
    env.confirm === 'type'
      ? t('type the name to delete')
      : env.confirm === 'confirm'
        ? t('confirm before deleting')
        : t('delete right away, with Undo'),
    env.readOnly && t('read-only'),
    env.topLine && t('line at the top')
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Mục menu chuột phải "đổi môi trường nhanh" cho một nguồn / nhóm: tiêu đề + mỗi môi trường một mục
 * (dấu ✓ ở mục đang chọn) + "Edit environments…". Rời môi trường yêu cầu gõ tên (Production) phải
 * xác nhận (hạ mức bảo vệ); đổi xong có toast Undo.
 */
export function environmentMenu(
  environments: readonly EnvironmentDef[],
  current: string | null,
  onPick: (id: string | null) => void
): MenuEntry[] {
  const leaving = environments.find((e) => e.id === current)
  const pick = async (id: string | null): Promise<void> => {
    if (id === current) return
    if (leaving?.confirm === 'type') {
      const ok = await confirmAction({
        title: t('Leave {env}?', { env: leaving.name }),
        message: t('Deleting things here will no longer ask you to type their name.'),
        confirmLabel: t('Change environment'),
        danger: true,
        testId: 'environment-leave-confirm'
      })
      if (!ok) return
    }
    onPick(id)
    const next = environments.find((e) => e.id === id)
    toast.info(next ? t('Environment: {name}', { name: next.name }) : t('No environment'), {
      group: 'environment-change',
      action: {
        label: t('Undo'),
        run: () => {
          onPick(current)
        }
      }
    })
  }
  return [
    {
      id: 'env-header',
      label: t('Environment'),
      icon: <Layers size={14} />,
      disabled: true,
      onSelect: () => undefined
    },
    ...[null, ...environments].map((env): MenuEntry => ({
      id: `env-${env?.id ?? 'none'}`,
      label: env ? env.name : t('No environment'),
      icon: (env?.id ?? null) === current ? <Check size={14} /> : <span className="size-3.5" />,
      onSelect: () => {
        void pick(env?.id ?? null)
      }
    })),
    {
      id: 'env-manage',
      label: t('Edit environments…'),
      icon: <span className="size-3.5" />,
      onSelect: () => {
        useShell.getState().openSettings('environments')
      }
    }
  ]
}
