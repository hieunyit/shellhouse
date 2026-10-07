/** Nút, chip, menu "View", chú giải và nhãn zoom nhỏ trên thanh công cụ / góc bản đồ. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Radio } from 'lucide-react'
import { useStore } from '@xyflow/react'
import { cx, Segmented } from '../../../renderer/src/components/ui'
import { formatRelative, t } from '../../registry/renderer-kit'
import { type TrafficState } from './useTraffic'
import { HUBBLE_ENABLE } from './trafficUnit'
import type { MapGrouping } from '../shared/map'

/**
 * Độ rộng hiện tại của một phần tử (ResizeObserver) — gắn `ref` trả về vào phần tử cần đo. Đo
 * ngay khi gắn để thanh công cụ không nháy giữa dạng đầy đủ và dạng gọn.
 */
/**
 * Danh sách kết quả tìm kiếm / popover: đóng khi bấm ra NGOÀI `ref` (pha capture — React Flow chặn
 * mousedown lan lên) — không dựa vào blur của ô nhập: blur xảy ra cả khi cửa sổ mất focus hay
 * focus bị kéo đi tạm thời, làm danh sách đóng ngay trước cú bấm vào kết quả.
 */
export function useCloseOnOutside(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void
): void {
  const latest = useRef(onClose)
  useEffect(() => {
    latest.current = onClose
  })
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent | MouseEvent): void => {
      const target = e.target as Node | null
      if (target && ref.current?.contains(target)) return
      latest.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [open, ref])
}

export function useElementWidth(): [(el: HTMLElement | null) => () => void, number] {
  const [width, setWidth] = useState(0)
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return () => undefined
    setWidth(Math.round(el.getBoundingClientRect().width))
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined) setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
    }
  }, [])
  return [ref, width]
}

export function ZoomLabel(): React.JSX.Element {
  const pct = useStore((s) => Math.round(s.transform[2] * 100))
  return (
    <span
      className="flex w-12 items-center justify-center border-x border-line text-[11px] text-faint tabular-nums"
      data-testid="k8s-map-zoom"
    >
      {pct}%
    </span>
  )
}

function TrafficDot({ status }: { status: TrafficState['status'] }): React.JSX.Element {
  return (
    <span
      className={cx(
        'size-1.5 shrink-0 rounded-full',
        status === 'live'
          ? 'bg-success'
          : status === 'connecting'
            ? 'animate-pulse bg-warning'
            : 'bg-line-strong'
      )}
      data-testid="k8s-map-traffic-status"
      data-status={status}
    />
  )
}

export function MapButton({
  label,
  testId,
  onClick,
  children
}: {
  label: string
  testId?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      className="flex size-7 items-center justify-center text-muted hover:bg-hover hover:text-fg"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/**
 * Nút mở menu nổi (bấm ra ngoài / Esc để đóng). Gom các tuỳ chọn hiển thị vào một chỗ — thanh công
 * cụ chỉ còn một hàng.
 */
export function MenuButton({
  label,
  icon,
  testId,
  active,
  align = 'right',
  width = 'w-64',
  title,
  iconOnly = false,
  children
}: {
  label: React.ReactNode
  icon?: React.ReactNode
  testId?: string
  /** Tooltip + tên cho trình đọc màn hình (bắt buộc nên có khi `iconOnly`). */
  title?: string
  /** Thanh công cụ hẹp: chỉ còn icon, chữ ở tooltip. */
  iconOnly?: boolean
  /** Có tuỳ chọn khác mặc định → viền nhấn. */
  active?: boolean
  align?: 'left' | 'right'
  width?: string
  children: React.ReactNode | ((close: () => void) => React.ReactNode)
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Menu tràn khỏi cửa sổ (nút nằm sát mép) → dịch vào trong, chừa 8 px. Đo ngay khi gắn menu.
  const [shift, setShift] = useState(0)
  const menuRef = useCallback((m: HTMLDivElement | null) => {
    if (!m) {
      setShift(0)
      return
    }
    const r = m.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    if (r.right > vw - 8) setShift(Math.max(8 - r.left, vw - 8 - r.right))
    else if (r.left < 8) setShift(8 - r.left)
  }, [])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Esc trong menu chỉ đóng menu; ngoài menu thì để ô đang gõ / bản đồ xử lý tiếp.
      if (ref.current?.contains(e.target as Node)) e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  const close = (): void => {
    setOpen(false)
  }
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={iconOnly ? title : undefined}
        title={title}
        data-testid={testId}
        className={cx(
          'flex h-7 shrink-0 items-center gap-1.5 rounded-md border font-medium whitespace-nowrap',
          iconOnly ? 'px-1.5' : 'px-2',
          open || active
            ? 'border-accent/40 bg-accent-soft text-fg'
            : 'border-line text-muted hover:text-fg'
        )}
        onClick={() => {
          setOpen(!open)
        }}
      >
        {icon}
        {!iconOnly && label}
        <ChevronDown size={12} className="shrink-0 text-faint" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className={cx(
            'absolute top-8 z-40 flex max-w-[calc(100vw-16px)] flex-col gap-0.5 rounded-lg bg-ds-popover p-1.5 text-xs shadow-ds-popover',
            align === 'right' ? 'right-0' : 'left-0',
            width
          )}
          style={shift ? { transform: `translateX(${String(shift)}px)` } : undefined}
          data-testid={testId ? `${testId}-menu` : undefined}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  )
}

/** Dòng bật / tắt trong menu (dấu tích + chú thích nhỏ). */
export function MenuToggle({
  on,
  label,
  hint,
  testId,
  onChange
}: {
  on: boolean
  label: string
  hint?: string
  testId?: string
  onChange: (on: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      aria-pressed={on}
      data-testid={testId}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
      onClick={() => {
        onChange(!on)
      }}
    >
      <span
        className={cx(
          'mt-px flex size-3.5 shrink-0 items-center justify-center rounded border',
          on ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong'
        )}
      >
        {on && <Check size={10} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-fg">{label}</span>
        {hint && <span className="block text-[11px] leading-snug text-faint">{hint}</span>}
      </span>
    </button>
  )
}

export function MenuHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-faint">{children}</div>
}

export function MenuItem({
  label,
  icon,
  testId,
  onClick
}: {
  label: string
  icon?: React.ReactNode
  testId?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-fg hover:bg-hover"
      onClick={onClick}
    >
      {icon && (
        <span className="flex size-3.5 shrink-0 items-center justify-center text-faint">
          {icon}
        </span>
      )}
      {label}
    </button>
  )
}

/**
 * Chọn chế độ xem: nút chia đoạn khi đủ chỗ, menu thả khi thanh công cụ hẹp (cùng test id cho
 * từng lựa chọn).
 */
export function ViewSwitch<T extends string>({
  value,
  options,
  compact,
  testIdPrefix,
  onChange
}: {
  value: T
  /** hint: một câu giải thích chế độ (chú thích khi rê chuột / dòng phụ trong menu). */
  options: readonly { value: T; label: string; hint?: string }[]
  compact: boolean
  testIdPrefix: string
  onChange: (value: T) => void
}): React.JSX.Element {
  if (!compact)
    return (
      <div className="shrink-0">
        <Segmented
          value={value}
          options={options}
          testIdPrefix={testIdPrefix}
          onChange={onChange}
        />
      </div>
    )
  const current = options.find((o) => o.value === value)
  return (
    <MenuButton
      testId={`${testIdPrefix}-menu`}
      label={current?.label ?? value}
      title={t('Change view')}
      align="left"
      width="w-64"
    >
      {(close) =>
        options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={o.value === value}
            data-testid={`${testIdPrefix}-${o.value}`}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-fg hover:bg-hover"
            onClick={() => {
              onChange(o.value)
              close()
            }}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center self-start pt-0.5 text-accent">
              {o.value === value && <Check size={12} strokeWidth={3} />}
            </span>
            <span className="min-w-0">
              <span className="block">{o.label}</span>
              {o.hint && <span className="block text-[11px] text-faint">{o.hint}</span>}
            </span>
          </button>
        ))
      }
    </MenuButton>
  )
}

/** Lệnh cài Caretta (traffic live, eBPF) — hiện khi chưa có. */
export const CARETTA_INSTALL =
  'helm repo add groundcover https://helm.groundcover.com && helm install caretta groundcover/caretta -n caretta --create-namespace'

/**
 * Trạng thái traffic live trên thanh công cụ: bật / tắt lớp traffic, giải thích khi không có
 * (chưa cài Caretta, thiếu quyền) kèm cách bật — bản đồ tĩnh vẫn dùng bình thường.
 */
export function TrafficMenu({
  on,
  traffic,
  compact = false,
  onChange
}: {
  on: boolean
  traffic: TrafficState
  /** Thanh công cụ hẹp: chỉ còn chấm trạng thái / icon. */
  compact?: boolean
  onChange: (on: boolean) => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <MenuButton
      testId="k8s-map-traffic"
      active={on && traffic.status === 'live'}
      icon={
        on ? <TrafficDot status={traffic.status} /> : <Radio size={12} className="text-faint" />
      }
      label={t('Traffic')}
      title={t('Live traffic')}
      iconOnly={compact}
      width="w-80"
    >
      <MenuToggle
        on={on}
        label={t('Show live traffic')}
        hint={t(
          'Connections measured by Hubble (Cilium) or byte rates by Caretta (eBPF) — optional'
        )}
        testId="k8s-map-traffic-toggle"
        onChange={onChange}
      />
      <div className="mx-2 my-1 border-t border-line" />
      <div className="px-2 pb-1 text-[11.5px] leading-snug" data-testid="k8s-map-traffic-info">
        {!on ? (
          <span className="text-faint">{t('Off — the topology does not need it.')}</span>
        ) : traffic.status === 'live' ? (
          <span className="text-muted">
            {traffic.source === 'hubble'
              ? t('Live from Hubble (Cilium) · updated {when}', {
                  when: formatRelative(traffic.updated)
                })
              : t('Live from {n} Caretta agents · updated {when}', {
                  n: traffic.agents,
                  when: formatRelative(traffic.updated)
                })}
          </span>
        ) : traffic.status === 'connecting' ? (
          <span className="text-muted">{t('Measuring traffic…')}</span>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-muted">
              {t('Not available — {reason}.', {
                reason: traffic.reason ?? t('Caretta is not installed')
              })}
            </span>
            <span className="text-faint">
              {t('Cilium cluster: enable Hubble Relay')}{' '}
              <code className="font-mono text-fg select-all">{HUBBLE_ENABLE}</code>
            </span>
            <span className="text-faint">
              {t('Otherwise install Caretta (no Prometheus needed):')}
            </span>
            <code className="block rounded bg-subtle px-1.5 py-1 font-mono text-[11px] break-all text-fg select-all">
              {CARETTA_INSTALL}
            </code>
            <button
              type="button"
              className="self-start rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-hover"
              onClick={() => {
                void navigator.clipboard.writeText(CARETTA_INSTALL).then(() => {
                  setCopied(true)
                })
              }}
            >
              {copied ? t('Copied') : t('Copy command')}
            </button>
          </div>
        )}
      </div>
    </MenuButton>
  )
}

/**
 * Cách gom namespace của lưới tổng quan: theo mục đích (mặc định), tiền tố tên, hay một nhãn (gợi ý
 * nhãn hay gặp; "theo nhãn…" để gõ khoá tuỳ ý).
 */
export function NamespaceGrouping({
  value,
  keys,
  onChange
}: {
  value: MapGrouping
  keys: readonly string[]
  onChange: (grouping: MapGrouping) => void
}): React.JSX.Element {
  const [custom, setCustom] = useState<string | null>(null)
  const labelKeys = [
    ...keys,
    ...(value.startsWith('label:') && !keys.includes(value.slice(6)) ? [value.slice(6)] : [])
  ]
  if (custom !== null)
    return (
      <input
        autoFocus
        type="text"
        spellCheck={false}
        placeholder={t('Label key, e.g. team')}
        aria-label={t('Group by label key')}
        data-testid="k8s-topo-grouping-custom"
        className="mx-2 mb-1 h-7 rounded-md border border-accent bg-subtle px-2 font-mono text-xs text-fg outline-none"
        value={custom}
        onChange={(e) => {
          setCustom(e.target.value)
        }}
        onBlur={() => {
          setCustom(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const key = custom.trim()
            if (key) onChange(`label:${key}`)
            setCustom(null)
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setCustom(null)
          }
        }}
      />
    )
  return (
    <select
      data-testid="k8s-topo-grouping"
      aria-label={t('Group namespaces')}
      className="mx-2 mb-1 h-7 cursor-pointer rounded-md border border-line bg-subtle px-1.5 text-xs text-fg outline-none"
      value={value}
      onChange={(e) => {
        const v = e.target.value
        if (v === '__custom') setCustom('')
        else onChange(v as MapGrouping)
      }}
    >
      <option value="purpose">{t('by purpose')}</option>
      <option value="prefix">{t('by name prefix')}</option>
      {labelKeys.map((k) => (
        <option key={k} value={`label:${k}`}>
          {t('by {key}', { key: k })}
        </option>
      ))}
      <option value="__custom">{t('by label…')}</option>
    </select>
  )
}
