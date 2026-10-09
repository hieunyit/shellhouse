import { useRef, useState } from 'react'
import { Check, Minus, X } from 'lucide-react'
import {
  Button,
  Checkbox,
  cx,
  Field,
  Input,
  Modal,
  Notice
} from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { formatNumber, t, tn, toast } from '../../registry/renderer-kit'
import {
  containerApplies,
  containerBulkOp,
  pullRefs,
  runBulk,
  selectAllState,
  splitTargets,
  type BulkResult,
  type ContainerBulk
} from '../shared/bulk'
import type { ContainerRow, DockerOp, ImageRow, NetworkRow, VolumeRow } from '../shared/ops'
import { imageName } from '../shared/view-model'
import { stateLabel } from './ContainerDetail'

/**
 * Chọn nhiều dòng + thao tác hàng loạt của tab Docker (cùng kiểu với Bulk.tsx của Kubernetes):
 * thanh chọn (ô chọn tất cả ba trạng thái, số đã chọn, các nút), hộp xác nhận tóm tắt mục sẽ bị
 * tác động / bỏ qua, rồi chạy song song có giới hạn với tiến độ và kết quả từng mục.
 */

type Request = <T>(op: DockerOp) => Promise<T>

/** Danh từ đếm theo loại (cho nút xác nhận / thông báo xong). */
export type BulkNoun = 'container' | 'image' | 'volume' | 'network'

export function nounText(noun: BulkNoun, n: number): string {
  switch (noun) {
    case 'container':
      return tn(n, '{n} container', '{n} containers')
    case 'image':
      return tn(n, '{n} image', '{n} images')
    case 'volume':
      return tn(n, '{n} volume', '{n} volumes')
    case 'network':
      return tn(n, '{n} network', '{n} networks')
  }
}

export interface BulkButton {
  id: string
  label: string
  icon: React.ReactNode
  danger?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}

/**
 * Thanh trên bảng: ô chọn tất cả (ba trạng thái) + số dòng; chọn từ hai dòng → thành thanh thao tác
 * hàng loạt (nền accent), Esc hoặc nút Clear bỏ chọn.
 */
export function SelectionBar({
  keys,
  selected,
  total,
  noun,
  actions,
  onSelect,
  onClear
}: {
  /** Khoá các dòng đang hiện (sau lọc). */
  keys: readonly string[]
  selected: ReadonlySet<string>
  /** Tổng số mục (trước lọc). */
  total: number
  noun: BulkNoun
  actions: readonly BulkButton[]
  onSelect: (keys: ReadonlySet<string>) => void
  onClear: () => void
}): React.JSX.Element {
  const state = selectAllState(keys, selected)
  const count = keys.filter((k) => selected.has(k)).length
  const multi = count > 1
  return (
    <div
      className={cx(
        'flex h-9 shrink-0 items-center gap-1 border-b border-line px-3 text-xs',
        multi ? 'bg-accent-soft/50' : 'bg-surface'
      )}
      data-testid="docker-selection-bar"
      data-selected={count}
    >
      <input
        type="checkbox"
        className="mr-2 size-3.5 shrink-0 accent-[var(--sh-accent)] disabled:opacity-40"
        aria-label={state === 'all' ? t('Clear selection') : t('Select all rows')}
        title={state === 'all' ? t('Clear selection (Esc)') : t('Select all rows (Ctrl+A)')}
        data-testid="docker-select-all"
        disabled={keys.length === 0}
        checked={state === 'all'}
        ref={(el) => {
          if (el) el.indeterminate = state === 'some'
        }}
        onChange={() => {
          onSelect(state === 'all' ? new Set() : new Set(keys))
        }}
      />
      {count === 0 ? (
        <span className="text-faint tabular-nums" data-testid="docker-list-count">
          {keys.length === total
            ? nounText(noun, total)
            : t('{shown} of {total}', {
                shown: formatNumber(keys.length),
                total: nounText(noun, total)
              })}
        </span>
      ) : (
        <span className="mr-2 font-medium text-fg tabular-nums" data-testid="docker-bulk-count">
          {tn(count, '{n} selected', '{n} selected')}
        </span>
      )}
      {multi &&
        actions.map((a) => (
          <Button
            key={a.id}
            size="sm"
            variant={a.danger ? 'danger-ghost' : 'ghost'}
            icon={a.icon}
            disabled={a.disabled}
            title={a.title}
            data-testid={`docker-bulk-${a.id}`}
            onClick={a.onClick}
          >
            {a.label}
          </Button>
        ))}
      {count > 0 ? (
        <button
          type="button"
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg"
          title={t('Clear selection (Esc)')}
          data-testid="docker-bulk-clear"
          onClick={onClear}
        >
          <X size={12} />
          {t('Clear')}
        </button>
      ) : (
        <span className="ml-auto hidden text-[11px] text-faint @3xl:inline">
          {t('Shift-click to select a range')}
        </span>
      )}
    </div>
  )
}

/** Ô chọn trên một dòng (Shift+bấm = chọn một khoảng); không để dòng nhận cú bấm. */
export function RowCheck({
  checked,
  name,
  onToggle
}: {
  checked: boolean
  name: string
  onToggle: (range: boolean) => void
}): React.JSX.Element {
  return (
    <input
      type="checkbox"
      className="size-3.5 shrink-0 accent-[var(--sh-accent)]"
      aria-label={t('Select {name}', { name })}
      data-testid="docker-row-check"
      tabIndex={-1}
      checked={checked}
      onChange={() => undefined}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(e.shiftKey)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
      }}
    />
  )
}

// ——— Kế hoạch một thao tác hàng loạt ———

export interface BulkPlan {
  title: string
  description: string
  /** Nhãn hành động ("Remove") — nút xác nhận: "Remove 3 containers". */
  action: string
  noun: BulkNoun
  danger: boolean
  /** Mục sẽ chạy (khoá + nhãn + ghi chú như trạng thái). */
  targets: { key: string; label: string; note?: string }[]
  /** Mục bị bỏ qua (thao tác không áp dụng) — hiện để người dùng biết. */
  skipped: { label: string; note?: string }[]
  /** Cảnh báo thêm (container đang chạy sẽ bị force remove…). */
  warning?: string
  /** Tuỳ chọn bật / tắt (xoá cả anonymous volume, force…). */
  option?: { label: string; description?: string }
  /** Xoá mục: chạy xong thì bỏ chọn các mục đã xoá. */
  removes?: boolean
  /** Số việc cùng lúc (pull: ít hơn). */
  parallel?: number
  run: (key: string, option: boolean) => Promise<unknown>
}

function containerTitle(kind: ContainerBulk, n: number): string {
  switch (kind) {
    case 'start':
      return tn(n, 'Start {n} container?', 'Start {n} containers?')
    case 'stop':
      return tn(n, 'Stop {n} container?', 'Stop {n} containers?')
    case 'restart':
      return tn(n, 'Restart {n} container?', 'Restart {n} containers?')
    case 'pause':
      return tn(n, 'Pause {n} container?', 'Pause {n} containers?')
    case 'unpause':
      return tn(n, 'Resume {n} container?', 'Resume {n} containers?')
    case 'kill':
      return tn(n, 'Kill {n} container?', 'Kill {n} containers?')
    case 'remove':
      return tn(n, 'Remove {n} container?', 'Remove {n} containers?')
  }
}

export function containerBulkLabel(kind: ContainerBulk): string {
  switch (kind) {
    case 'start':
      return t('Start')
    case 'stop':
      return t('Stop')
    case 'restart':
      return t('Restart')
    case 'pause':
      return t('Pause')
    case 'unpause':
      return t('Resume')
    case 'kill':
      return t('Kill')
    case 'remove':
      return t('Remove')
  }
}

function containerDescription(kind: ContainerBulk): string {
  switch (kind) {
    case 'start':
      return t('The containers start again with their existing configuration.')
    case 'stop':
      return t(
        'Each container gets SIGTERM, then SIGKILL after the timeout. What they serve is unavailable until started again.'
      )
    case 'restart':
      return t(
        'Each container is stopped and started again; what it serves is briefly unavailable.'
      )
    case 'pause':
      return t('Every process in the containers is frozen until they are resumed.')
    case 'unpause':
      return t('Frozen processes continue where they stopped.')
    case 'kill':
      return t(
        'The containers are stopped at once (SIGKILL) — processes get no chance to clean up.'
      )
    case 'remove':
      return t('The containers are deleted with their writable layer. Named volumes are kept.')
  }
}

export function containerPlan(
  kind: ContainerBulk,
  items: readonly ContainerRow[],
  request: Request
): BulkPlan {
  const { targets, skipped } = splitTargets(items, (c) => containerApplies(kind, c))
  const byName = new Map(targets.map((c) => [c.name, c]))
  const live = targets.filter((c) => c.state === 'running' || c.state === 'paused').length
  return {
    title: containerTitle(kind, targets.length),
    description: containerDescription(kind),
    action: containerBulkLabel(kind),
    noun: 'container',
    // Làm gián đoạn dịch vụ → Production phải gõ cụm đếm (start / resume thì không).
    danger:
      kind === 'remove' ||
      kind === 'kill' ||
      kind === 'stop' ||
      kind === 'restart' ||
      kind === 'pause',
    removes: kind === 'remove',
    targets: targets.map((c) => ({ key: c.name, label: c.name, note: stateLabel(c.state) })),
    skipped: skipped.map((c) => ({ label: c.name, note: stateLabel(c.state) })),
    ...(kind === 'remove' && live
      ? {
          warning: tn(
            live,
            '{n} container is running and is force-removed.',
            '{n} containers are running and are force-removed.'
          )
        }
      : {}),
    ...(kind === 'remove'
      ? { option: { label: t('Also remove anonymous volumes of the container (docker rm -v)') } }
      : {}),
    run: async (key, volumes) => {
      const c = byName.get(key)
      if (c) await request(containerBulkOp(kind, c, { volumes }))
    }
  }
}

export function imageRemovePlan(items: readonly ImageRow[], request: Request): BulkPlan {
  const byName = new Map(items.map((i) => [imageName(i), i]))
  const used = items.filter((i) => i.containers > 0).length
  return {
    title: tn(items.length, 'Remove {n} image?', 'Remove {n} images?'),
    description: t('The images and their unused layers are deleted from the engine.'),
    action: t('Remove'),
    noun: 'image',
    danger: true,
    removes: true,
    targets: items.map((i) => ({
      key: imageName(i),
      label: imageName(i),
      ...(i.containers ? { note: tn(i.containers, '{n} container', '{n} containers') } : {})
    })),
    skipped: [],
    ...(used
      ? {
          warning: tn(
            used,
            '{n} image is used by containers — removing it fails unless forced (running containers always block it).',
            '{n} images are used by containers — removing them fails unless forced (running containers always block them).'
          )
        }
      : {}),
    option: {
      label: t('Force (docker rmi -f)'),
      description: t('Also removes images with several tags or used by stopped containers.')
    },
    run: async (key, force) => {
      const i = byName.get(key)
      if (i) await request({ op: 'image.remove', id: i.id, ...(force ? { force: true } : {}) })
    }
  }
}

export function imagePullPlan(
  items: readonly ImageRow[],
  pull: (ref: string) => Promise<void>
): BulkPlan {
  const refs = pullRefs(items)
  const untagged = items.filter((i) => i.tags.length === 0)
  return {
    title: tn(refs.length, 'Pull {n} image?', 'Pull {n} images?'),
    description: t(
      'Pulls the newest version of every tag from its registry. Running containers keep the old image until recreated.'
    ),
    action: t('Pull'),
    noun: 'image',
    danger: false,
    targets: refs.map((r) => ({ key: r, label: r })),
    skipped: untagged.map((i) => ({ label: imageName(i), note: t('no tag') })),
    parallel: 2,
    run: (ref) => pull(ref)
  }
}

export function volumeRemovePlan(items: readonly VolumeRow[], request: Request): BulkPlan {
  return {
    title: tn(items.length, 'Remove {n} volume?', 'Remove {n} volumes?'),
    description: t(
      'The volumes are deleted with all the data in them. This cannot be undone. Volumes used by a container cannot be removed.'
    ),
    action: t('Remove'),
    noun: 'volume',
    danger: true,
    removes: true,
    targets: items.map((v) => ({
      key: v.name,
      label: v.name,
      ...(v.project ? { note: v.project } : {})
    })),
    skipped: [],
    run: (name) => request({ op: 'volume.remove', name })
  }
}

export function networkRemovePlan(items: readonly NetworkRow[], request: Request): BulkPlan {
  const { targets, skipped } = splitTargets(items, (n) => !n.builtin)
  const byName = new Map(targets.map((n) => [n.name, n]))
  return {
    title: tn(targets.length, 'Remove {n} network?', 'Remove {n} networks?'),
    description: t('Containers can no longer reach each other over these networks.'),
    action: t('Remove'),
    noun: 'network',
    danger: true,
    removes: true,
    targets: targets.map((n) => ({ key: n.name, label: n.name, note: n.driver })),
    skipped: skipped.map((n) => ({ label: n.name, note: t('built-in') })),
    run: async (name) => {
      const n = byName.get(name)
      if (n) await request({ op: 'network.remove', id: n.id })
    }
  }
}

/** Hộp xác nhận + tiến độ + kết quả của một thao tác hàng loạt. */
export function BulkDialog({
  plan,
  production = false,
  onClose,
  onFinished
}: {
  plan: BulkPlan
  /** Môi trường đòi gõ lại tên (Production): thao tác nguy hiểm phải gõ cụm đếm ("3 containers"). */
  production?: boolean
  onClose: () => void
  /** Chạy xong (kể cả có lỗi): khoá các mục thành công / lỗi. */
  onFinished: (results: BulkResult[]) => void
}): React.JSX.Element {
  const [option, setOption] = useState(false)
  const [typed, setTyped] = useState('')
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm')
  const [results, setResults] = useState<BulkResult[]>([])
  const cancelled = useRef(false)
  const n = plan.targets.length
  const need = production && plan.danger && n > 0 ? nounText(plan.noun, n) : undefined
  const failed = results.filter((r) => !r.ok)
  const shown = plan.targets.slice(0, 12)
  const labelOf = new Map(plan.targets.map((x) => [x.key, x.label]))

  const run = (): void => {
    if (phase !== 'confirm' || n === 0 || (need !== undefined && typed !== need)) return
    setPhase('running')
    cancelled.current = false
    void runBulk(plan.targets, {
      key: (x) => x.key,
      run: (x) => plan.run(x.key, option),
      parallel: plan.parallel ?? 4,
      isCancelled: () => cancelled.current,
      errorText: cleanError,
      onResult: (r) => {
        setResults((prev) => [...prev, r])
      }
    }).then((all) => {
      onFinished(all)
      if (all.every((r) => r.ok)) {
        toast.success(
          t('{action}: {what} done', { action: plan.action, what: nounText(plan.noun, all.length) })
        )
        onClose()
      } else setPhase('done')
    })
  }

  const close = (): void => {
    // Đang chạy: dừng các mục chưa bắt đầu (mục đang gửi vẫn chạy xong).
    cancelled.current = true
    onClose()
  }
  const progress = results.length / Math.max(1, n)
  return (
    <Modal
      title={plan.title}
      description={plan.description}
      onClose={close}
      testId="docker-bulk-dialog"
      footer={
        phase === 'confirm' ? (
          <>
            {/* Thao tác nguy hiểm: focus ở Cancel — Enter vội không xoá nhầm. */}
            <Button variant="ghost" autoFocus={plan.danger} onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button
              variant={plan.danger ? 'danger' : 'primary'}
              autoFocus={!plan.danger}
              disabled={n === 0 || (need !== undefined && typed !== need)}
              data-testid="docker-bulk-ok"
              onClick={run}
            >
              {t('{action} {what}', { action: plan.action, what: nounText(plan.noun, n) })}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            disabled={phase === 'running'}
            data-testid="docker-bulk-close"
            onClick={onClose}
          >
            {t('Close')}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 text-xs">
        {phase === 'confirm' && (
          <>
            {n > 0 ? (
              <div
                className="max-h-48 overflow-auto rounded-md border border-line bg-subtle px-2 py-1.5 font-mono text-[11px]"
                data-testid="docker-bulk-targets"
              >
                {shown.map((x) => (
                  <div key={x.key} className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-fg">{x.label}</span>
                    {x.note && <span className="shrink-0 font-sans text-faint">{x.note}</span>}
                  </div>
                ))}
                {n > shown.length && (
                  <div className="font-sans text-faint">
                    {tn(n - shown.length, 'and {n} more', 'and {n} more')}
                  </div>
                )}
              </div>
            ) : (
              <Notice tone="info">{t('Nothing selected can take this action.')}</Notice>
            )}
            {plan.skipped.length > 0 && (
              <div className="text-muted" data-testid="docker-bulk-skipped">
                <Minus size={11} className="mr-1 inline align-[-1px] text-faint" />
                {tn(
                  plan.skipped.length,
                  '{n} selected item is skipped — the action does not apply to it:',
                  '{n} selected items are skipped — the action does not apply to them:'
                )}{' '}
                <span className="font-mono text-[11px] text-faint">
                  {plan.skipped
                    .slice(0, 6)
                    .map((s) => (s.note ? `${s.label} (${s.note})` : s.label))
                    .join(', ')}
                  {plan.skipped.length > 6 ? '…' : ''}
                </span>
              </div>
            )}
            {plan.warning && <Notice tone="warning">{plan.warning}</Notice>}
            {need !== undefined && (
              <Field label={t('Type {name} to confirm', { name: need })}>
                <Input
                  autoFocus
                  mono
                  value={typed}
                  data-testid="docker-bulk-typed"
                  onPaste={(e) => {
                    e.preventDefault()
                  }}
                  onChange={(e) => {
                    setTyped(e.target.value)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && typed === need) run()
                  }}
                />
              </Field>
            )}
            {plan.option && n > 0 && (
              <Checkbox
                label={plan.option.label}
                description={plan.option.description}
                checked={option}
                data-testid="docker-bulk-option"
                onChange={(e) => {
                  setOption(e.target.checked)
                }}
              />
            )}
          </>
        )}
        {phase !== 'confirm' && (
          <>
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
                <div
                  className={cx(
                    'h-full rounded-full transition-[width]',
                    failed.length ? 'bg-warning' : 'bg-info'
                  )}
                  style={{ width: `${String(Math.round(progress * 100))}%` }}
                />
              </div>
              <span className="text-faint tabular-nums" data-testid="docker-bulk-progress">
                {formatNumber(results.length)}/{formatNumber(n)}
              </span>
            </div>
            {phase === 'done' && (
              <Notice tone="warning">
                {t('{ok} succeeded, {failed} failed.', {
                  ok: formatNumber(results.length - failed.length),
                  failed: formatNumber(failed.length)
                })}
              </Notice>
            )}
            <div className="max-h-56 overflow-auto" data-testid="docker-bulk-results">
              {results.map((r) => (
                <div
                  key={r.key}
                  className="flex items-start gap-1.5 py-0.5"
                  data-testid="docker-bulk-result"
                  data-ok={r.ok}
                >
                  {r.ok ? (
                    <Check size={12} className="mt-0.5 shrink-0 text-success" />
                  ) : (
                    <X size={12} className="mt-0.5 shrink-0 text-danger" />
                  )}
                  <span className="shrink-0 font-mono text-[11px] text-fg">
                    {labelOf.get(r.key) ?? r.key}
                  </span>
                  {r.skipped ? (
                    <span className="text-faint">{t('Skipped')}</span>
                  ) : (
                    r.error && <span className="min-w-0 break-words text-danger">{r.error}</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
