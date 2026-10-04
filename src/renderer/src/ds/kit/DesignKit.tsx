import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Box,
  Copy,
  FileText,
  Filter,
  Import,
  Inbox,
  LayoutList,
  Logs,
  Network,
  Plus,
  RotateCw,
  Search,
  Server,
  SquareTerminal,
  Trash2,
  Unplug,
  X
} from 'lucide-react'
import { t, tn } from '@shared/i18n'
import {
  Badge,
  Breadcrumb,
  Button,
  Checkbox,
  Combobox,
  ConfirmDialog,
  ContextMenu,
  DataTable,
  Dialog,
  DsProvider,
  EmptyState,
  EnvLabel,
  Field,
  IconButton,
  Input,
  Inspector,
  INSPECTOR_WIDTH,
  Kbd,
  Menu,
  Meter,
  Popover,
  ProblemChip,
  ProdLine,
  PropertyList,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonRows,
  StatusChip,
  StatusDot,
  StatusText,
  Switch,
  TabPanel,
  Tabs,
  Toast,
  ToastViewport,
  Tooltip,
  type Column,
  type ConfirmRisk,
  type Density,
  type MenuEntry,
  type StatusTone,
  type ToastTone
} from '../index'
import { cx, ICON, ICON_SM } from '../utils'
import { makePods, type DemoPod } from './demo-data'

/**
 * Design kit: mọi component của design system ở mọi trạng thái, cả hai theme và hai mật độ — thay
 * Storybook (nhẹ hơn, chạy ngay trong app). Mở từ bảng lệnh khi bật "New interface (beta)".
 * Trang phủ toàn cửa sổ; phần còn lại của app bị `inert` trong lúc mở; Esc (khi không còn lớp nổi
 * nào) để đóng.
 */
export function DesignKit({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [layout, setLayout] = useState<'both' | 'dark' | 'light'>('both')
  const [density, setDensity] = useState<Density>('comfortable')
  const rootRef = useRef<HTMLDivElement>(null)
  const latestClose = useRef(onClose)
  useEffect(() => {
    latestClose.current = onClose
  })

  useEffect(() => {
    const app = document.getElementById('root')
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (app) app.inert = true
    rootRef.current?.focus()
    // Pha nổi bọt: menu / dialog / popover của Radix xử lý Esc trước (pha bắt, preventDefault).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      latestClose.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (app) app.inert = false
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  const panes: ('dark' | 'light')[] = layout === 'both' ? ['dark', 'light'] : [layout]
  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('Design kit')}
      tabIndex={-1}
      data-testid="design-kit"
      // Một theme: cả trang (kể cả thanh trên) theo theme đó; "Dark + Light": theo theme của app.
      {...(layout === 'both' ? {} : { 'data-theme': layout })}
      className="fixed inset-0 z-50 flex flex-col bg-ds-bg font-sans text-ds-base tracking-[-0.011em] text-ds-fg outline-none"
    >
      <DsProvider density={density}>
        <header
          data-ds-density={density}
          className="sh-titlebar sh-titlebar-lead sh-titlebar-trail flex h-11 shrink-0 items-center gap-3 border-b border-ds-border px-4"
        >
          <h1 className="text-ds-md font-semibold">
            {t('Design kit')}{' '}
            <span className="font-normal text-ds-fg-3">{t('· Shellhouse design system')}</span>
          </h1>
          <span className="flex-1" />
          <SegmentedControl
            label={t('Themes')}
            size="sm"
            value={layout}
            onValueChange={setLayout}
            testIdPrefix="kit-layout"
            options={[
              { value: 'both', label: t('Dark + Light') },
              { value: 'dark', label: t('Dark') },
              { value: 'light', label: t('Light') }
            ]}
          />
          <SegmentedControl
            label={t('Density')}
            size="sm"
            value={density}
            onValueChange={setDensity}
            testIdPrefix="kit-density"
            options={[
              { value: 'comfortable', label: t('Comfortable') },
              { value: 'compact', label: t('Compact') }
            ]}
          />
          <IconButton label={t('Close')} shortcut="Esc" data-testid="kit-close" onClick={onClose}>
            <X {...ICON} aria-hidden />
          </IconButton>
        </header>
      </DsProvider>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="kit-scroll">
        <div className={cx('grid', panes.length === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
          {panes.map((theme) => (
            <Pane key={theme} theme={theme} density={density} />
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}

function Pane({
  theme,
  density
}: {
  theme: 'dark' | 'light'
  density: Density
}): React.JSX.Element {
  const [portal, setPortal] = useState<HTMLElement | null>(null)
  return (
    <section
      data-theme={theme}
      data-ds-density={density}
      data-testid={`kit-pane-${theme}`}
      aria-label={theme === 'dark' ? t('Dark theme') : t('Light theme')}
      style={{ colorScheme: theme }}
      className="min-w-0 border-r border-ds-border bg-ds-surface-0 px-7 pt-6 pb-16 text-ds-fg last:border-r-0"
    >
      <DsProvider portal={portal} density={density}>
        <h2 className="mb-5 text-ds-sm font-medium tracking-[0.04em] text-ds-fg-3 uppercase">
          {theme === 'dark' ? t('Dark theme') : t('Light theme')}
        </h2>
        <KitContent theme={theme} />
      </DsProvider>
      {/* Lớp nổi (menu, dialog…) portal vào đây để theo theme của cột. */}
      <div ref={setPortal} />
    </section>
  )
}

function Section({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-10">
      <h3 className="text-ds-md font-semibold">{title}</h3>
      {description && <p className="mt-0.5 mb-3 text-ds-sm text-ds-fg-2">{description}</p>}
      <div className={description ? '' : 'mt-3'}>{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="w-24 shrink-0 text-ds-xs text-ds-fg-3">{label}</span>
      {children}
    </div>
  )
}

const TOKEN_GROUPS: readonly { name: () => string; tokens: readonly string[] }[] = [
  {
    name: () => t('Surfaces'),
    tokens: [
      '--ds-bg',
      '--ds-surface-0',
      '--ds-surface-1',
      '--ds-surface-2',
      '--ds-surface-3',
      '--ds-popover'
    ]
  },
  { name: () => t('Borders'), tokens: ['--ds-border-subtle', '--ds-border', '--ds-border-strong'] },
  { name: () => t('Text'), tokens: ['--ds-fg', '--ds-fg-2', '--ds-fg-3', '--ds-fg-disabled'] },
  {
    name: () => t('Accent'),
    tokens: [
      '--ds-accent',
      '--ds-accent-hover',
      '--ds-accent-text',
      '--ds-accent-soft',
      '--ds-accent-contrast'
    ]
  },
  {
    name: () => t('Status'),
    tokens: [
      '--ds-success',
      '--ds-success-soft',
      '--ds-info',
      '--ds-info-soft',
      '--ds-warning',
      '--ds-warning-soft',
      '--ds-danger',
      '--ds-danger-soft',
      '--ds-danger-solid',
      '--ds-status-off'
    ]
  },
  {
    name: () => t('Environment · chart'),
    tokens: [
      '--ds-env-prod',
      '--ds-env-staging',
      '--ds-env-dev',
      '--ds-env-test',
      '--ds-chart',
      '--ds-chart-2'
    ]
  }
]

function KitContent({ theme }: { theme: 'dark' | 'light' }): React.JSX.Element {
  return (
    <>
      <Section
        title={t('Color tokens')}
        description={t(
          'Semantic only: green healthy, amber pending, red failing, blue info, gray stopped. Teal is reserved for actions, focus and selection.'
        )}
      >
        {TOKEN_GROUPS.map((g) => (
          <div key={g.tokens[0]} className="mb-3">
            <div className="mb-1.5 text-ds-sm font-medium text-ds-fg-2">{g.name()}</div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
              {g.tokens.map((token) => (
                <div key={token} className="overflow-hidden rounded-ds-lg border border-ds-border">
                  <div
                    className="h-8 border-b border-ds-border-subtle"
                    style={{ background: `var(${token})` }}
                  />
                  <div className="truncate px-2 py-1 font-mono text-[10.5px] tracking-normal text-ds-fg-3">
                    {token.slice(5)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section
        title={t('Typography')}
        description={t('Inter, six sizes. 13px is the app default.')}
      >
        {(
          [
            ['xl', 'text-ds-xl font-semibold tracking-[-0.018em]', 'Accounts'],
            ['lg', 'text-ds-lg font-semibold', t('Delete Deployment web?')],
            ['md', 'text-ds-md font-semibold', 'web-7d9f8c6b5-h8sdl'],
            ['base', 'text-ds-base', t('Shared credentials reused across hosts.')],
            ['sm', 'text-ds-sm font-medium text-ds-fg-2', 'Namespace · Ready · Restarts'],
            ['xs', 'text-ds-xs font-medium text-ds-fg-2', 'PROD · 2 transfers · 45%']
          ] as const
        ).map(([name, cls, sample]) => (
          <div
            key={name}
            className="flex items-baseline gap-4 border-b border-ds-border-subtle py-1.5"
          >
            <code className="w-16 shrink-0 font-mono text-ds-xs tracking-normal text-ds-fg-3">
              {name}
            </code>
            <span className={cls}>{sample}</span>
          </div>
        ))}
        <div className="flex items-baseline gap-4 py-1.5">
          <code className="w-16 shrink-0 font-mono text-ds-xs tracking-normal text-ds-fg-3">
            mono
          </code>
          <span className="font-mono text-ds-sm tracking-normal">
            deploy@prod-web-01:~$ kubectl get pods
          </span>
        </div>
      </Section>

      <Section
        title={t('Spacing · radius · elevation')}
        description={t('4px grid. Shadows only on popovers and dialogs.')}
      >
        <div className="mb-3 flex items-end gap-2.5">
          {[2, 4, 6, 8, 12, 16, 24, 32, 48].map((n) => (
            <div key={n} className="flex flex-col items-center gap-1">
              <div
                className="rounded-[2px] border border-ds-border-strong bg-ds-surface-2"
                style={{ width: n, height: n }}
              />
              <span className="font-mono text-[10px] text-ds-fg-3">{n}</span>
            </div>
          ))}
        </div>
        <div className="mb-3 flex gap-2">
          {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((r) => (
            <div
              key={r}
              className="flex h-10 w-14 items-center justify-center border border-ds-border-strong bg-ds-surface-2 text-ds-xs text-ds-fg-3"
              style={{ borderRadius: `var(--ds-r-${r})` }}
            >
              {r}
            </div>
          ))}
        </div>
        <div className="flex gap-3">
          <div className="flex h-14 w-32 items-center justify-center rounded-ds-lg bg-ds-popover text-ds-xs text-ds-fg-2 shadow-ds-popover">
            popover
          </div>
          <div className="flex h-14 w-32 items-center justify-center rounded-ds-xl bg-ds-surface-0 text-ds-xs text-ds-fg-2 shadow-ds-dialog">
            dialog
          </div>
        </div>
      </Section>

      <ButtonsSection />
      <InputsSection />
      <ControlsSection />
      <StatusSection />
      <OverlaysSection theme={theme} />
      <FeedbackSection />
      <LayoutSection />
      <TableSection theme={theme} />
    </>
  )
}

function ButtonsSection(): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  return (
    <Section
      title={t('Button')}
      description={t(
        'Heights follow density. One primary per view; danger only to confirm destructive actions.'
      )}
    >
      <Row label={t('Variants')}>
        <Button variant="primary" icon={<Plus {...ICON} aria-hidden />}>
          {t('New host')}
        </Button>
        <Button icon={<Import {...ICON} aria-hidden />}>{t('Import')}</Button>
        <Button variant="ghost" icon={<Filter {...ICON} aria-hidden />}>
          {t('Filter')}
        </Button>
        <Button variant="danger" icon={<Trash2 {...ICON} aria-hidden />}>
          {t('Delete')}
        </Button>
      </Row>
      <Row label={t('Disabled')}>
        <Button variant="primary" disabled>
          {t('New host')}
        </Button>
        <Button disabled>{t('Import')}</Button>
        <Button variant="danger" disabled>
          {t('Delete')}
        </Button>
      </Row>
      <Row label={t('Sizes')}>
        <Button size="sm" icon={<Logs {...ICON_SM} aria-hidden />}>
          {t('Logs')}
        </Button>
        <Button>{t('Medium')}</Button>
        <Button size="lg">{t('Large')}</Button>
      </Row>
      <Row label={t('Shortcut · loading')}>
        <Button variant="primary" shortcut="N" icon={<Plus {...ICON} aria-hidden />}>
          {t('New')}
        </Button>
        <Button variant="ghost" shortcut="Ctrl K" icon={<Search {...ICON_SM} aria-hidden />}>
          {t('Search…')}
        </Button>
        <Button
          loading={loading}
          data-testid="kit-loading-button"
          onClick={() => {
            setLoading(true)
            setTimeout(() => {
              setLoading(false)
            }, 1500)
          }}
        >
          {t('Refresh')}
        </Button>
      </Row>
      <Row label={t('Icon buttons')}>
        <IconButton label={t('Copy')} shortcut="Ctrl C" data-testid="kit-icon-button">
          <Copy {...ICON} aria-hidden />
        </IconButton>
        <IconButton label={t('Refresh')} variant="secondary">
          <RotateCw {...ICON} aria-hidden />
        </IconButton>
        <IconButton label={t('Open terminal')} size="sm">
          <SquareTerminal {...ICON_SM} aria-hidden />
        </IconButton>
        <IconButton label={t('Delete')} disabled>
          <Trash2 {...ICON} aria-hidden />
        </IconButton>
      </Row>
    </Section>
  )
}

function InputsSection(): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [host, setHost] = useState('deploy@10.10.1.11')
  const [region, setRegion] = useState<string | undefined>('ap-southeast-1')
  const [context, setContext] = useState<string | undefined>(undefined)
  const regions = ['us-east-1', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'].map((r) => ({
    value: r,
    label: r
  }))
  const contexts = Array.from({ length: 40 }, (_, i) => ({
    value: `ctx-${String(i)}`,
    label: i === 0 ? 'prod-eks' : `cluster-${String(i).padStart(2, '0')}`,
    hint: i % 3 === 0 ? 'EKS' : 'k3s'
  }))
  return (
    <Section
      title={t('Input · Select · Combobox')}
      description={t(
        'Filters show the “/” shortcut. Errors: red border and a message with an icon.'
      )}
    >
      <Row label={t('Default')}>
        <SearchInput
          value={filter}
          onValueChange={setFilter}
          placeholder={t('Filter…')}
          aria-label={t('Filter')}
          className="w-56"
          data-testid="kit-search"
        />
        <Input
          aria-label={t('Host')}
          value={host}
          mono
          onChange={(e) => {
            setHost(e.target.value)
          }}
          className="w-48"
        />
      </Row>
      <Row label={t('States')}>
        <Input aria-label={t('Name')} value="prod-web-0" invalid readOnly className="w-40" />
        <Input aria-label={t('Disabled')} placeholder={t('Disabled')} disabled className="w-36" />
        <Select
          label={t('Region')}
          value={region}
          onValueChange={setRegion}
          options={regions}
          data-testid="kit-select"
        />
      </Row>
      <div className="mb-3 grid max-w-md grid-cols-2 gap-3">
        <Field label={t('Port')} hint={t('Default: 22')}>
          <Input defaultValue="22" mono />
        </Field>
        <Field label={t('Hostname')} error={t('Enter a hostname')}>
          <Input defaultValue="" />
        </Field>
      </div>
      <Row label={t('Combobox')}>
        <Combobox
          label={t('Context')}
          value={context}
          onValueChange={setContext}
          options={contexts}
          placeholder={t('Choose a context…')}
          className="w-60"
          data-testid="kit-combobox"
        />
      </Row>
    </Section>
  )
}

function ControlsSection(): React.JSX.Element {
  const [a, setA] = useState(false)
  const [b, setB] = useState(true)
  const [sw, setSw] = useState(true)
  const [view, setView] = useState<'containers' | 'compose'>('containers')
  const [mode, setMode] = useState<'table' | 'graph'>('table')
  const [tab, setTab] = useState<'overview' | 'events' | 'logs' | 'yaml'>('overview')
  return (
    <Section
      title={t('Checkbox · Switch · Segmented · Tabs')}
      description={t('Native semantics, keyboard operable; arrows move within groups.')}
    >
      <Row label={t('Checkbox')}>
        <Checkbox checked={a} onCheckedChange={setA} label={t('Off')} />
        <Checkbox checked={b} onCheckedChange={setB} label={t('On')} />
        <Checkbox checked="indeterminate" onCheckedChange={() => undefined} label={t('Mixed')} />
        <Checkbox
          checked={false}
          onCheckedChange={() => undefined}
          label={t('Disabled')}
          disabled
        />
      </Row>
      <Row label={t('Switch')}>
        <Switch
          checked={sw}
          onCheckedChange={setSw}
          aria-label={t('Live updates')}
          data-testid="kit-switch"
        />
        <Switch
          checked={!sw}
          onCheckedChange={(v) => {
            setSw(!v)
          }}
          aria-label={t('Wrap lines')}
        />
        <Switch
          checked={false}
          onCheckedChange={() => undefined}
          aria-label={t('Disabled')}
          disabled
        />
      </Row>
      <div className="mb-3 max-w-md">
        <Switch
          checked={sw}
          onCheckedChange={setSw}
          label={t('Live updates')}
          description={t('Refresh the list every few seconds.')}
        />
      </div>
      <Row label={t('Segmented')}>
        <SegmentedControl
          label={t('View')}
          value={view}
          onValueChange={setView}
          testIdPrefix="kit-view"
          options={[
            {
              value: 'containers',
              label: 'Containers',
              icon: <LayoutList {...ICON_SM} aria-hidden />
            },
            { value: 'compose', label: 'Compose', icon: <Box {...ICON_SM} aria-hidden /> }
          ]}
        />
        <SegmentedControl
          label={t('Layout')}
          value={mode}
          onValueChange={setMode}
          options={[
            {
              value: 'table',
              label: t('Table'),
              iconOnly: true,
              icon: <LayoutList {...ICON_SM} aria-hidden />
            },
            {
              value: 'graph',
              label: t('Graph'),
              iconOnly: true,
              icon: <Network {...ICON_SM} aria-hidden />
            }
          ]}
        />
      </Row>
      <div className="overflow-hidden rounded-ds-lg border border-ds-border">
        <Tabs
          label={t('Pod details')}
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'overview', label: 'Overview' },
            { value: 'events', label: 'Events', count: 7, countTone: 'warning' },
            { value: 'logs', label: 'Logs' },
            { value: 'yaml', label: 'YAML' }
          ]}
        >
          <TabPanel value="overview" className="p-4 text-ds-fg-2">
            {t('Overview of the selected resource.')}
          </TabPanel>
          <TabPanel value="events" className="p-4 text-ds-fg-2">
            {tn(7, '{n} event', '{n} events')}
          </TabPanel>
          <TabPanel value="logs" className="p-4 font-mono text-ds-sm text-ds-fg-2">
            GET /healthz 200 3ms
          </TabPanel>
          <TabPanel value="yaml" className="p-4 font-mono text-ds-sm text-ds-fg-2">
            apiVersion: v1
          </TabPanel>
        </Tabs>
      </div>
    </Section>
  )
}

function StatusSection(): React.JSX.Element {
  const tones: readonly [StatusTone, string][] = [
    ['ok', 'Running'],
    ['progress', 'Updating'],
    ['off', 'Completed'],
    ['warning', 'Pending'],
    ['danger', 'CrashLoopBackOff']
  ]
  return (
    <Section
      title={t('Status · Badge · Environment')}
      description={t(
        'Color carries meaning: dot and text in tables, a tinted chip in the Inspector header. One status indicator per row; every chip has the same shape.'
      )}
    >
      <Row label={t('Status')}>
        {tones.map(([tone, text]) => (
          <StatusText key={tone} tone={tone}>
            {text}
          </StatusText>
        ))}
      </Row>
      <Row label={t('Dot')}>
        {tones.map(([tone, text]) => (
          <StatusDot key={tone} tone={tone} label={text} />
        ))}
      </Row>
      <Row label={t('Chip')}>
        {tones.map(([tone, text]) => (
          <StatusChip key={tone} tone={tone}>
            {text}
          </StatusChip>
        ))}
      </Row>
      <Row label={t('Problem chip')}>
        <ProblemChip>CrashLoop</ProblemChip>
        <ProblemChip tone="warning">{t('No endpoints')}</ProblemChip>
      </Row>
      <Row label={t('Badge')}>
        <Badge>12</Badge>
        <Badge>{t('Key')}</Badge>
        <Badge variant="outline">2/3 ready</Badge>
        <Badge tone="warning">{tn(1, '{n} pending', '{n} pending')}</Badge>
        <Badge tone="danger">{tn(3, '{n} failing', '{n} failing')}</Badge>
      </Row>
      <Row label={t('Environment')}>
        <EnvLabel env="prod" />
        <EnvLabel env="staging" />
        <EnvLabel env="dev" />
        <EnvLabel env="test" />
        <span className="inline-flex items-center gap-1.5 text-ds-fg-2">
          prod-web-01 <EnvLabel env="prod" dot />
        </span>
      </Row>
      <Row label={t('Meter')}>
        <Meter value={0.4} label="CPU" valueText="190m" />
        <Meter value={0.5} label={t('Memory')} valueText="128Mi" series={2} />
        <Meter value={0.8} label="CPU" valueText="405m" />
        <Meter value={0.97} label={t('Memory')} valueText="251Mi" />
      </Row>
      <Row label={t('Keys')}>
        <Kbd keys="Ctrl K" />
        <Kbd keys="/" />
        <Kbd keys="Esc" />
        <Kbd keys={['⇧', 'R']} />
      </Row>
    </Section>
  )
}

function OverlaysSection({ theme }: { theme: 'dark' | 'light' }): React.JSX.Element {
  const [risk, setRisk] = useState<ConfirmRisk | null>(null)
  const [dialog, setDialog] = useState(false)
  const [showNode, setShowNode] = useState(true)
  const [last, setLast] = useState('')
  const entries: MenuEntry[] = [
    { kind: 'label', id: 'l', label: 'Pod' },
    {
      id: 'logs',
      label: t('Logs'),
      icon: <Logs {...ICON_SM} aria-hidden />,
      shortcut: 'L',
      onSelect: () => {
        setLast('logs')
      }
    },
    {
      id: 'shell',
      label: t('Open shell'),
      icon: <SquareTerminal {...ICON_SM} aria-hidden />,
      shortcut: 'S',
      onSelect: () => {
        setLast('shell')
      }
    },
    {
      id: 'restart',
      label: t('Restart'),
      icon: <RotateCw {...ICON_SM} aria-hidden />,
      onSelect: () => {
        setLast('restart')
      }
    },
    {
      kind: 'checkbox',
      id: 'node',
      label: t('Show node'),
      checked: showNode,
      onCheckedChange: setShowNode
    },
    {
      id: 'scale',
      label: t('Scale…'),
      icon: <Box {...ICON_SM} aria-hidden />,
      disabled: true,
      hint: t('No controller'),
      onSelect: () => undefined
    },
    { kind: 'separator', id: 's' },
    {
      id: 'delete',
      label: t('Delete Pod…'),
      icon: <Trash2 {...ICON_SM} aria-hidden />,
      danger: true,
      shortcut: 'Ctrl ⌫',
      onSelect: () => {
        setRisk('production')
      }
    }
  ]
  return (
    <Section
      title={t('Menu · Tooltip · Popover · Dialog')}
      description={t('Keyboard: arrows, type to jump, Enter to run, Esc closes and returns focus.')}
    >
      <Row label={t('Menu')}>
        <Menu
          label={t('Pod actions')}
          entries={entries}
          trigger={
            <Button data-testid={`kit-menu-${theme}`} icon={<FileText {...ICON_SM} aria-hidden />}>
              {t('Actions')}
            </Button>
          }
        />
        <ContextMenu entries={entries} label={t('Pod actions')}>
          <div
            tabIndex={0}
            data-testid={`kit-context-${theme}`}
            className="flex h-ds-ctl items-center rounded-ds-md border border-dashed border-ds-border-strong px-3 text-ds-sm text-ds-fg-2 outline-none focus-visible:shadow-ds-focus"
          >
            {t('Right-click here')}
          </div>
        </ContextMenu>
        {last && (
          <span className="text-ds-sm text-ds-fg-3" data-testid={`kit-menu-last-${theme}`}>
            {t('Ran: {name}', { name: last })}
          </span>
        )}
      </Row>
      <Row label={t('Tooltip')}>
        <Tooltip content={t('Toggle inspector')} shortcut="]">
          <Button variant="ghost">{t('Hover or focus me')}</Button>
        </Tooltip>
        <Popover
          label={t('Filter')}
          trigger={<Button icon={<Filter {...ICON_SM} aria-hidden />}>{t('Popover')}</Button>}
        >
          <div className="flex flex-col gap-2">
            <div className="text-ds-sm font-medium text-ds-fg-2">{t('Filter by status')}</div>
            <Checkbox checked onCheckedChange={() => undefined} label="Running" />
            <Checkbox checked={false} onCheckedChange={() => undefined} label="Pending" />
          </div>
        </Popover>
      </Row>
      <Row label={t('Dialog')}>
        <Button
          data-testid={`kit-dialog-${theme}`}
          onClick={() => {
            setDialog(true)
          }}
        >
          {t('Dialog')}
        </Button>
        <Button
          data-testid={`kit-confirm-normal-${theme}`}
          onClick={() => {
            setRisk('normal')
          }}
        >
          {t('Confirm')}
        </Button>
        <Button
          data-testid={`kit-confirm-danger-${theme}`}
          onClick={() => {
            setRisk('danger')
          }}
        >
          {t('Danger confirm')}
        </Button>
        <Button
          data-testid={`kit-confirm-prod-${theme}`}
          onClick={() => {
            setRisk('production')
          }}
        >
          {t('Production confirm')}
        </Button>
      </Row>
      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title={t('Rename host')}
        description={t('The new name shows in the sidebar and tabs.')}
        data-testid="kit-dialog"
        footer={
          <>
            <Button
              onClick={() => {
                setDialog(false)
              }}
            >
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setDialog(false)
              }}
            >
              {t('Save')}
            </Button>
          </>
        }
      >
        <Field label={t('Name')}>
          <Input defaultValue="prod-web-01" autoFocus />
        </Field>
      </Dialog>
      <ConfirmDialog
        open={risk !== null}
        onOpenChange={(open) => {
          if (!open) setRisk(null)
        }}
        risk={risk ?? 'normal'}
        data-testid="kit-confirm"
        title={
          risk === 'normal'
            ? t('Restart web?')
            : risk === 'danger'
              ? t('Delete container api-staging?')
              : t('Delete Deployment web?')
        }
        description={risk === 'normal' ? t('Pods are replaced one by one.') : undefined}
        impact={
          risk === 'production' ? (
            <ul className="m-0 list-none rounded-ds-md border border-ds-border-subtle p-0 text-ds-sm">
              {['Deployment web', 'ReplicaSet web-7d9f8c6b5', tn(3, '{n} pod', '{n} pods')].map(
                (x) => (
                  <li
                    key={x}
                    className="border-b border-ds-border-subtle px-3 py-1.5 last:border-b-0"
                  >
                    {x}
                  </li>
                )
              )}
            </ul>
          ) : undefined
        }
        confirmLabel={risk === 'normal' ? t('Restart') : t('Delete')}
        confirmText={risk === 'production' ? 'web' : undefined}
        onConfirm={() => {
          setLast(risk === 'normal' ? 'restart' : 'delete')
        }}
      />
    </Section>
  )
}

function FeedbackSection(): React.JSX.Element {
  const [toasts, setToasts] = useState<{ id: number; tone: ToastTone }[]>([])
  const nextId = useRef(1)
  const add = (tone: ToastTone): void => {
    const id = nextId.current++
    setToasts((list) => [...list, { id, tone }])
  }
  const remove = (id: number): void => {
    setToasts((list) => list.filter((x) => x.id !== id))
  }
  return (
    <Section
      title={t('Toast · PropertyList · Empty · Skeleton')}
      description={t(
        'Toast icons follow meaning: success green, info blue, warning amber, error red.'
      )}
    >
      <div className="mb-3 flex flex-col gap-2">
        <Toast
          title={t('Restarting web')}
          description={t('Rolling restart started · 0/3 updated')}
          tone="success"
          action={{ label: t('Undo'), onClick: () => undefined }}
          onClose={() => undefined}
          duration={0}
        />
        <Toast
          title={t('Pulling {name}', { name: 'registry.shop.vn/api:5.2.1' })}
          description={t('Continues in the background · see Transfers')}
          tone="info"
          onClose={() => undefined}
          duration={0}
        />
        <Toast
          title={t('Connection lost')}
          description={t('prod-web-01 · retrying in 5s')}
          tone="danger"
          action={{ label: t('Retry now'), onClick: () => undefined }}
          onClose={() => undefined}
        />
      </div>
      <Row label={t('Live')}>
        <Button
          size="sm"
          data-testid="kit-toast"
          onClick={() => {
            add('success')
          }}
        >
          {t('Show toast')}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            add('warning')
          }}
        >
          {t('Warning toast')}
        </Button>
      </Row>
      <ToastViewport>
        {toasts.map((x) => (
          <Toast
            key={x.id}
            tone={x.tone}
            title={x.tone === 'warning' ? t('Password is 215 days old') : t('Copied to clipboard')}
            onClose={() => {
              remove(x.id)
            }}
          />
        ))}
      </ToastViewport>
      <div className="mb-4 max-w-md rounded-ds-lg border border-ds-border px-4 py-2">
        <PropertyList
          items={[
            { label: t('Status'), value: <StatusText tone="danger">CrashLoopBackOff</StatusText> },
            { label: 'Node', value: 'pool-a-7xk2', copy: 'pool-a-7xk2' },
            { label: 'Pod IP', value: '10.244.3.18', mono: true, copy: '10.244.3.18' },
            { label: t('Age'), value: '3h' }
          ]}
        />
      </div>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <div className="rounded-ds-lg border border-ds-border">
          <EmptyState
            icon={<Inbox {...ICON} aria-hidden />}
            title={t('No hosts yet')}
            description={t('Add a host to connect over SSH.')}
            actions={
              <Button size="sm" variant="primary">
                {t('New host')}
              </Button>
            }
          />
        </div>
        <div className="rounded-ds-lg border border-ds-border">
          <EmptyState
            icon={<Search {...ICON} aria-hidden />}
            title={t('No Pods match “{query}”', { query: 'api' })}
            description={t('Try a different name or clear filters.')}
            actions={<Button size="sm">{t('Clear filters')}</Button>}
          />
        </div>
        <div className="rounded-ds-lg border border-ds-border">
          <EmptyState
            tone="danger"
            icon={<Unplug {...ICON} aria-hidden />}
            title={t('Can’t reach prod-cluster')}
            description={t('TLS handshake timeout after 10s.')}
            actions={<Button size="sm">{t('Retry')}</Button>}
          />
        </div>
      </div>
      <div className="max-w-md rounded-ds-lg border border-ds-border">
        <div className="flex flex-col gap-2 p-3">
          <Skeleton width="60%" />
          <Skeleton width="40%" />
        </div>
        <SkeletonRows rows={3} />
      </div>
    </Section>
  )
}

function LayoutSection(): React.JSX.Element {
  return (
    <Section
      title={t('Breadcrumb · production marker')}
      description={t(
        'PROD: a thin red line at the top of the content and one small label in the header.'
      )}
    >
      <div className="overflow-hidden rounded-ds-lg border border-ds-border">
        <ProdLine />
        <div className="flex h-ds-header items-center px-3">
          <Breadcrumb
            env="prod"
            items={[
              { id: 'k8s', label: 'Kubernetes', onSelect: () => undefined },
              { id: 'ctx', label: 'prod-eks', onSelect: () => undefined },
              { id: 'ns', label: 'shop', onSelect: () => undefined },
              { id: 'pods', label: 'Pods' }
            ]}
          />
        </div>
      </div>
      <div className="mt-2 flex h-ds-header items-center rounded-ds-lg border border-ds-border px-3">
        <Breadcrumb
          env="staging"
          items={[
            {
              id: 'hosts',
              label: t('Hosts'),
              icon: <Server {...ICON_SM} aria-hidden />,
              onSelect: () => undefined
            },
            { id: 'h', label: 'api-staging-02' }
          ]}
        />
      </div>
    </Section>
  )
}

function TableSection({ theme }: { theme: 'dark' | 'light' }): React.JSX.Element {
  const pods = useMemo(() => makePods(2000), [])
  const [open, setOpen] = useState<DemoPod | null>(null)
  const [width, setWidth] = useState<number>(INSPECTOR_WIDTH.min)
  const [query, setQuery] = useState('')
  const [confirm, setConfirm] = useState<string[] | null>(null)
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? pods.filter((p) => p.name.includes(q) || p.namespace.includes(q)) : pods
  }, [pods, query])
  const columns = useMemo<Column<DemoPod>[]>(
    () => [
      {
        id: 'name',
        header: t('Name'),
        hideable: false,
        minWidth: 180,
        sortValue: (p) => p.name,
        cell: (p) => <span className="font-medium">{p.name}</span>
      },
      {
        id: 'namespace',
        header: 'Namespace',
        width: 120,
        sortValue: (p) => p.namespace,
        cell: (p) => <span className="text-ds-fg-2">{p.namespace}</span>
      },
      {
        id: 'status',
        header: t('Status'),
        width: 170,
        sortValue: (p) => p.severity,
        cell: (p) => (
          // Bảng: chấm + chữ màu (một chỉ báo mỗi hàng); chip chỉ ở header Inspector.
          <StatusText tone={p.tone}>{p.status}</StatusText>
        )
      },
      {
        id: 'restarts',
        header: t('Restarts'),
        width: 90,
        align: 'end',
        sortValue: (p) => p.restarts,
        // Số đếm tô theo nghĩa: > 5 đỏ, 1–5 vàng, 0 xám mờ.
        cell: (p) => (
          <span
            className={cx(
              p.restarts > 5
                ? 'font-medium text-ds-danger'
                : p.restarts > 0
                  ? 'text-ds-warning'
                  : 'text-ds-fg-3'
            )}
          >
            {p.restarts}
          </span>
        )
      },
      {
        id: 'cpu',
        header: 'CPU',
        width: 110,
        sortValue: (p) => p.cpu,
        cell: (p) => (
          <Meter value={p.cpu} label="CPU" valueText={`${String(Math.round(p.cpu * 500))}m`} />
        )
      },
      {
        id: 'node',
        header: 'Node',
        width: 130,
        defaultHidden: true,
        sortValue: (p) => p.node,
        cell: (p) => <span className="text-ds-fg-2">{p.node}</span>
      },
      {
        id: 'age',
        header: t('Age'),
        width: 70,
        align: 'end',
        sortValue: (p) => p.ageMinutes,
        cell: (p) => <span className="text-ds-fg-3">{p.age}</span>
      }
    ],
    []
  )
  return (
    <Section
      title={t('DataTable · Inspector')}
      description={t(
        '2,000 virtualized rows. Click a header to sort, drag edges to resize, x / Shift+click to select, j/k to move, Enter to open.'
      )}
    >
      <div className="flex h-105 overflow-hidden rounded-ds-lg border border-ds-border">
        <DataTable
          className="min-w-0 flex-1"
          data-testid={`kit-table-${theme}`}
          label={t('Pods')}
          rows={rows}
          columns={columns}
          getRowId={(p) => p.name}
          persistKey={`design-kit-pods-${theme}`}
          initialSort={{ columnId: 'name', direction: 'asc' }}
          selectable
          activeId={open?.name ?? null}
          onOpen={setOpen}
          toolbar={
            <>
              <SearchInput
                value={query}
                onValueChange={setQuery}
                placeholder={t('Filter pods…')}
                aria-label={t('Filter pods')}
                className="w-56"
              />
              <span className="text-ds-sm text-ds-fg-3">
                {tn(rows.length, '{n} pod', '{n} pods')}
              </span>
            </>
          }
          bulkActions={(ids) => (
            <>
              <Button size="sm" variant="ghost" icon={<RotateCw {...ICON_SM} aria-hidden />}>
                {t('Restart')}
              </Button>
              <Button size="sm" variant="ghost" icon={<Copy {...ICON_SM} aria-hidden />}>
                {t('Copy names')}
              </Button>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                className="hover:text-ds-danger"
                data-testid="kit-bulk-delete"
                icon={<Trash2 {...ICON_SM} aria-hidden />}
                onClick={() => {
                  setConfirm(ids)
                }}
              >
                {t('Delete…')}
              </Button>
            </>
          )}
          empty={
            <EmptyState
              icon={<Search {...ICON} aria-hidden />}
              title={t('No Pods match “{query}”', { query })}
              actions={
                <Button
                  size="sm"
                  onClick={() => {
                    setQuery('')
                  }}
                >
                  {t('Clear filters')}
                </Button>
              }
            />
          }
        />
        {open && (
          <Inspector
            title={open.name}
            subtitle={`Pod · ${open.namespace} · ${open.age}`}
            icon={<Box {...ICON} aria-hidden />}
            badges={
              <>
                <StatusChip tone={open.tone}>{open.status}</StatusChip>
                <span className="text-ds-sm text-ds-fg-3">
                  {tn(open.restarts, '{n} restart', '{n} restarts')}
                </span>
              </>
            }
            width={width}
            onWidthChange={setWidth}
            onClose={() => {
              setOpen(null)
            }}
            data-testid={`kit-inspector-${theme}`}
            actions={
              <>
                <Button size="sm" icon={<Logs {...ICON_SM} aria-hidden />}>
                  {t('Logs')}
                </Button>
                <Button size="sm" icon={<SquareTerminal {...ICON_SM} aria-hidden />}>
                  {t('Shell')}
                </Button>
              </>
            }
          >
            <div className="px-4 py-2">
              <PropertyList
                items={[
                  { label: 'Node', value: open.node, copy: open.node },
                  { label: 'Namespace', value: open.namespace },
                  { label: t('Age'), value: open.age }
                ]}
              />
            </div>
          </Inspector>
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => {
          if (!o) setConfirm(null)
        }}
        risk="production"
        title={tn(confirm?.length ?? 0, 'Delete {n} pod?', 'Delete {n} pods?')}
        confirmLabel={t('Delete')}
        confirmText={tn(confirm?.length ?? 0, '{n} pod', '{n} pods')}
        onConfirm={() => undefined}
      />
    </Section>
  )
}
