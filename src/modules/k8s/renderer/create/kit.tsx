import { useId, useState } from 'react'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { Input, Select, TextArea, cx } from '../../../../renderer/src/components/ui'
import type { FieldErrors, KV } from '../../shared/forms'
import { t } from '../../../registry/renderer-kit'

export function Section({
  title,
  description,
  children,
  collapsible = false,
  defaultOpen = true,
  testId
}: {
  title: string
  description?: string
  children: React.ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
  testId?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="rounded-lg border border-line bg-surface" data-testid={testId}>
      <button
        type="button"
        disabled={!collapsible}
        className="flex w-full items-start gap-2 px-4 py-3 text-left"
        onClick={() => {
          setOpen((o) => !o)
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg">{title}</div>
          {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
        </div>
        {collapsible && (
          <ChevronDown
            size={15}
            className={cx('mt-0.5 text-faint transition-transform', open && 'rotate-180')}
          />
        )}
      </button>
      {open && <div className="flex flex-col gap-3 border-t border-line px-4 py-3">{children}</div>}
    </section>
  )
}

export function F({
  label,
  hint,
  error,
  required,
  className,
  children
}: {
  label: string
  hint?: React.ReactNode
  error?: string | undefined
  required?: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className={cx('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-xs font-medium text-muted">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {error ? (
        <span className="text-[11px] text-danger" data-testid="k8s-form-error">
          {error}
        </span>
      ) : (
        hint && <span className="text-[11px] text-faint">{hint}</span>
      )}
    </label>
  )
}

export const invalid = (e: string | undefined): string | undefined =>
  e ? 'border-danger focus:border-danger focus:ring-danger/20' : undefined

export function Grid({
  cols = 2,
  children
}: {
  cols?: 2 | 3 | 4
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'grid gap-3',
        cols === 2 ? 'grid-cols-2' : cols === 3 ? 'grid-cols-3' : 'grid-cols-4'
      )}
    >
      {children}
    </div>
  )
}

export function RowButton({
  label,
  onClick,
  testId
}: {
  label: string
  onClick: () => void
  testId?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      className="inline-flex items-center gap-1 self-start rounded-md px-1.5 py-1 text-xs font-medium text-accent hover:bg-accent-soft"
      onClick={onClick}
    >
      <Plus size={13} /> {label}
    </button>
  )
}

export function RemoveButton({
  onClick,
  label = t('Remove')
}: {
  onClick: () => void
  label?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint hover:bg-danger-soft hover:text-danger"
      onClick={onClick}
    >
      <Trash2 size={14} />
    </button>
  )
}

/** Danh sách key = value (nhãn, annotation, dữ liệu ConfigMap…). */
export function KVEditor({
  value,
  onChange,
  errors,
  path,
  keyLabel = t('Key'),
  valueLabel = t('Value'),
  addLabel = t('Add'),
  multiline = false,
  secret = false,
  testId
}: {
  value: KV[]
  onChange: (v: KV[]) => void
  errors: FieldErrors
  path: string
  keyLabel?: string
  valueLabel?: string
  addLabel?: string
  multiline?: boolean
  secret?: boolean
  testId?: string
}): React.JSX.Element {
  const set = (i: number, patch: Partial<KV>): void => {
    onChange(value.map((kv, j) => (j === i ? { ...kv, ...patch } : kv)))
  }
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {value.map((kv, i) => (
        <div key={i} className={cx('flex gap-2', multiline ? 'items-start' : 'items-start')}>
          <F
            label={i === 0 ? keyLabel : ''}
            error={errors[`${path}.${String(i)}.key`]}
            className="w-2/5"
          >
            <Input
              mono
              value={kv.key}
              placeholder={keyLabel.toLowerCase()}
              className={invalid(errors[`${path}.${String(i)}.key`])}
              onChange={(e) => {
                set(i, { key: e.target.value })
              }}
            />
          </F>
          <F
            label={i === 0 ? valueLabel : ''}
            error={errors[`${path}.${String(i)}.value`]}
            className="flex-1"
          >
            {multiline ? (
              <TextArea
                rows={Math.min(8, Math.max(1, kv.value.split('\n').length))}
                value={kv.value}
                placeholder={t('value')}
                onChange={(e) => {
                  set(i, { value: e.target.value })
                }}
              />
            ) : (
              <Input
                mono
                type={secret ? 'password' : 'text'}
                value={kv.value}
                placeholder={t('value')}
                className={invalid(errors[`${path}.${String(i)}.value`])}
                onChange={(e) => {
                  set(i, { value: e.target.value })
                }}
              />
            )}
          </F>
          <div className={i === 0 ? 'pt-5' : ''}>
            <RemoveButton
              onClick={() => {
                onChange(value.filter((_, j) => j !== i))
              }}
            />
          </div>
        </div>
      ))}
      <RowButton
        label={addLabel}
        onClick={() => {
          onChange([...value, { key: '', value: '' }])
        }}
      />
    </div>
  )
}

export function NamespaceSelect({
  value,
  namespaces,
  onChange,
  error
}: {
  value: string
  namespaces: readonly string[]
  onChange: (v: string) => void
  error: string | undefined
}): React.JSX.Element {
  return (
    <F label="Namespace" required error={error}>
      <Select
        value={value}
        data-testid="k8s-form-namespace"
        className={invalid(error)}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      >
        <option value="">{t('Choose…')}</option>
        {namespaces.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
    </F>
  )
}

export function NameInput({
  value,
  onChange,
  error,
  placeholder = 'my-app'
}: {
  value: string
  onChange: (v: string) => void
  error: string | undefined
  placeholder?: string
}): React.JSX.Element {
  return (
    <F label={t('Name')} required error={error} hint={t('Lowercase letters, digits and “-”')}>
      <Input
        mono
        autoFocus
        value={value}
        placeholder={placeholder}
        data-testid="k8s-form-name"
        className={invalid(error)}
        onChange={(e) => {
          onChange(e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, '-'))
        }}
      />
    </F>
  )
}

/** Chọn một tên trong danh sách cluster, vẫn cho gõ tay (chưa tạo / không có quyền list). */
export function Pick({
  value,
  options,
  onChange,
  placeholder,
  error,
  testId
}: {
  value: string
  options: readonly string[]
  onChange: (v: string) => void
  placeholder: string
  error?: string | undefined
  testId?: string
}): React.JSX.Element {
  const id = `pick-${useId().replace(/:/g, '')}`
  return (
    <>
      <Input
        mono
        list={id}
        value={value}
        placeholder={placeholder}
        data-testid={testId}
        className={invalid(error)}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
      <datalist id={id}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  )
}
