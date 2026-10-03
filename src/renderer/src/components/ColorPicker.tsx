import { Ban, Check } from 'lucide-react'
import { t } from '@shared/i18n'
import { HOST_COLORS, type HostColor } from '@shared/hosts'
import { hostColorClass } from './hostColors'
import { choiceKeyDown, cx } from './ui'

/** Tên màu hiển thị (đã dịch) — dùng cho tooltip, aria-label và các câu "Using red (from …)". */
export function colorName(color: HostColor): string {
  switch (color) {
    case 'red':
      return t('Red')
    case 'orange':
      return t('Orange')
    case 'yellow':
      return t('Yellow')
    case 'green':
      return t('Green')
    case 'teal':
      return t('Teal')
    case 'blue':
      return t('Blue')
    case 'purple':
      return t('Purple')
    case 'gray':
      return t('Gray')
  }
}

/**
 * Chọn màu môi trường (prod đỏ, staging cam…). Nhóm radio: Tab vào mục đang chọn, ←/→ đổi màu;
 * mục đang chọn có dấu tích (không chỉ dựa vào viền — dễ thấy cả trên nền tối / người mù màu).
 */
export function ColorPicker({
  value,
  onChange,
  noneLabel,
  testIdPrefix,
  label
}: {
  value: HostColor | null
  onChange: (color: HostColor | null) => void
  noneLabel?: string
  testIdPrefix?: string
  /** Tên nhóm radio cho trình đọc màn hình. */
  label?: string
}): React.JSX.Element {
  const values: readonly (HostColor | null)[] = [null, ...HOST_COLORS]
  const none = noneLabel ?? t('No color')
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="radiogroup"
      aria-label={label ?? t('Color')}
      onKeyDown={(e) => {
        choiceKeyDown(e, values, value, onChange)
      }}
    >
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        aria-label={none}
        title={none}
        tabIndex={value === null ? 0 : -1}
        data-testid={testIdPrefix ? `${testIdPrefix}-none` : undefined}
        className={cx(
          'flex size-6 items-center justify-center rounded-full border-2 border-dashed text-faint transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          value === null ? 'border-accent text-accent' : 'border-line-strong hover:text-muted'
        )}
        onClick={() => {
          onChange(null)
        }}
      >
        {value === null ? <Check size={12} strokeWidth={3} /> : <Ban size={11} />}
      </button>
      {HOST_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={colorName(c)}
          title={colorName(c)}
          tabIndex={value === c ? 0 : -1}
          data-testid={testIdPrefix ? `${testIdPrefix}-${c}` : undefined}
          className={cx(
            'flex size-6 items-center justify-center rounded-full text-white transition-transform outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-elevated',
            hostColorClass[c],
            value === c && 'ring-2 ring-fg/70 ring-offset-2 ring-offset-elevated'
          )}
          onClick={() => {
            onChange(c)
          }}
        >
          {value === c && <Check size={13} strokeWidth={3} className="drop-shadow-sm" />}
        </button>
      ))}
    </div>
  )
}
