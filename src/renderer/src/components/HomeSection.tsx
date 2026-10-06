/** Mục của Home: tiêu đề + số đếm + thao tác bên phải. */
export function Section({
  title,
  count,
  action,
  testId,
  children
}: {
  title: string
  count?: number
  action?: React.ReactNode
  testId?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section data-testid={testId} className="min-w-0">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
        {count !== undefined && <span className="text-[13px] text-faint">{count}</span>}
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  )
}
