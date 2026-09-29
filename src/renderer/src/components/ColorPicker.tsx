import { HOST_COLORS, type HostColor } from '@shared/hosts'
import { hostColorClass } from './hostColors'
import { cx } from './ui'

export function ColorPicker({
  value,
  onChange,
  noneLabel = 'No color',
  testIdPrefix
}: {
  value: HostColor | null
  onChange: (color: HostColor | null) => void
  noneLabel?: string
  testIdPrefix?: string
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup">
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        aria-label={noneLabel}
        title={noneLabel}
        data-testid={testIdPrefix ? `${testIdPrefix}-none` : undefined}
        className={cx(
          'size-5 rounded-full border-2 border-dashed',
          value === null ? 'border-accent' : 'border-line-strong'
        )}
        onClick={() => {
          onChange(null)
        }}
      />
      {HOST_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          title={c}
          data-testid={testIdPrefix ? `${testIdPrefix}-${c}` : undefined}
          className={cx(
            'size-5 rounded-full transition-transform hover:scale-110',
            hostColorClass[c],
            value === c && 'ring-2 ring-accent ring-offset-2 ring-offset-elevated'
          )}
          onClick={() => {
            onChange(c)
          }}
        />
      ))}
    </div>
  )
}
