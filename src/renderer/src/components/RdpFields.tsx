import { t } from '@shared/i18n'
import type { HostSummary } from '@shared/hosts'
import { RDP_SCALES, RDP_SIZES, type RdpSettings } from '@shared/rdp'
import { Checkbox, Field, Input, Segmented, Select } from './ui'

type Path = 'direct' | 'ssh' | 'gateway'

const sizeKey = (w: number, h: number): string => `${w}x${h}`

/**
 * Phần riêng của host Remote Desktop trong form host: màn hình, chuyển hướng thiết bị, đường kết
 * nối (thẳng / qua SSH host / RD Gateway). Tên đăng nhập, domain, mật khẩu nằm ở HostForm.
 */
export function RdpFields({
  value,
  onChange,
  hosts,
  selfId,
  path,
  onPathChange
}: {
  value: RdpSettings
  onChange: (next: RdpSettings) => void
  /** Mọi host đã lưu — chọn SSH host làm tunnel. */
  hosts: readonly HostSummary[]
  /** Host đang sửa (không tự tunnel qua chính nó). */
  selfId: string | null
  path: Path
  onPathChange: (path: Path) => void
}): React.JSX.Element {
  const set = <K extends keyof RdpSettings>(key: K, v: RdpSettings[K]): void => {
    onChange({ ...value, [key]: v })
  }
  const preset = RDP_SIZES.some(([w, h]) => w === value.width && h === value.height)
    ? sizeKey(value.width, value.height)
    : 'custom'
  const sshHosts = hosts.filter((h) => h.protocol === 'ssh' && h.id !== selfId)
  const viaMissing = value.viaHostId !== null && !sshHosts.some((h) => h.id === value.viaHostId)

  return (
    <div className="flex flex-col gap-3" data-testid="rdp-fields">
      <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <span className="text-xs font-medium text-muted">{t('Open in')}</span>
        <Segmented
          value={value.openWith}
          onChange={(v) => {
            set('openWith', v)
          }}
          testIdPrefix="rdp-open"
          options={[
            { value: 'tab', label: t('App tab') },
            { value: 'native', label: t('External client') }
          ]}
        />
        <p className="text-xs text-faint">
          {value.openWith === 'tab'
            ? t(
                'Opens the remote desktop in a Shellhouse tab. Right-click the host to use the external client instead.'
              )
            : t(
                'Opens the Remote Desktop client of your system (mstsc, Windows App, FreeRDP or Remmina).'
              )}
        </p>
      </div>
      <div className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
        <span className="text-xs font-medium text-muted">{t('Display')}</span>
        <Segmented
          value={value.fullScreen ? 'full' : 'window'}
          onChange={(v) => {
            set('fullScreen', v === 'full')
          }}
          testIdPrefix="rdp-display"
          options={[
            { value: 'window', label: t('Window') },
            { value: 'full', label: t('Full screen') }
          ]}
        />
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Field label={t('Window size')}>
            <Select
              data-testid="rdp-size"
              value={preset}
              onChange={(e) => {
                const [w, h] = e.target.value.split('x').map(Number)
                if (w && h) onChange({ ...value, width: w, height: h })
              }}
            >
              {RDP_SIZES.map(([w, h]) => (
                <option key={sizeKey(w, h)} value={sizeKey(w, h)}>
                  {w} × {h}
                </option>
              ))}
              {preset === 'custom' && <option value="custom">{t('Custom')}</option>}
            </Select>
          </Field>
          <div className="flex items-center gap-1.5">
            <Input
              mono
              inputMode="numeric"
              aria-label={t('Width')}
              data-testid="rdp-width"
              className="w-20"
              value={String(value.width)}
              onChange={(e) => {
                set('width', Number(e.target.value.replace(/\D/g, '')) || 0)
              }}
            />
            <span className="text-xs text-faint">×</span>
            <Input
              mono
              inputMode="numeric"
              aria-label={t('Height')}
              data-testid="rdp-height"
              className="w-20"
              value={String(value.height)}
              onChange={(e) => {
                set('height', Number(e.target.value.replace(/\D/g, '')) || 0)
              }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Checkbox
            label={t('Use all monitors')}
            data-testid="rdp-multimon"
            disabled={!value.fullScreen}
            checked={value.fullScreen && value.multiMonitor}
            onChange={(e) => {
              set('multiMonitor', e.target.checked)
            }}
          />
          <Checkbox
            label={t('Resize with the window')}
            data-testid="rdp-dynamic"
            checked={value.dynamicResolution}
            onChange={(e) => {
              set('dynamicResolution', e.target.checked)
            }}
          />
        </div>
        <Field label={t('Scale')}>
          <Select
            data-testid="rdp-scale"
            value={value.scale === null ? '' : String(value.scale)}
            onChange={(e) => {
              const n = Number(e.target.value)
              set(
                'scale',
                (RDP_SCALES as readonly number[]).includes(n) ? (n as RdpSettings['scale']) : null
              )
            }}
          >
            <option value="">{t('Automatic (system)')}</option>
            {RDP_SCALES.map((s) => (
              <option key={s} value={String(s)}>
                {s}%
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <span className="text-xs font-medium text-muted">
          {t('Share with the remote computer')}
        </span>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Checkbox
            label={t('Clipboard')}
            data-testid="rdp-clipboard"
            checked={value.clipboard}
            onChange={(e) => {
              set('clipboard', e.target.checked)
            }}
          />
          <Checkbox
            label={t('Local drives')}
            data-testid="rdp-drives"
            checked={value.drives}
            onChange={(e) => {
              set('drives', e.target.checked)
            }}
          />
          <Checkbox
            label={t('Audio')}
            data-testid="rdp-audio"
            checked={value.audio}
            onChange={(e) => {
              set('audio', e.target.checked)
            }}
          />
          <Checkbox
            label={t('Printers')}
            data-testid="rdp-printers"
            checked={value.printers}
            onChange={(e) => {
              set('printers', e.target.checked)
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
        <span className="text-xs font-medium text-muted">{t('Connection')}</span>
        <Segmented
          value={path}
          onChange={onPathChange}
          testIdPrefix="rdp-path"
          options={[
            { value: 'direct', label: t('Direct') },
            { value: 'ssh', label: t('Through SSH host') },
            { value: 'gateway', label: t('RD Gateway') }
          ]}
        />
        {path === 'direct' && (
          <p className="text-xs text-faint">
            {t('The Remote Desktop client connects to the host directly.')}
          </p>
        )}
        {path === 'ssh' && (
          <>
            <Select
              data-testid="rdp-via"
              aria-label={t('SSH host')}
              value={value.viaHostId ?? ''}
              onChange={(e) => {
                set('viaHostId', e.target.value || null)
              }}
            >
              <option value="">{t('Choose an SSH host…')}</option>
              {viaMissing && <option value={value.viaHostId ?? ''}>{t('(deleted)')}</option>}
              {sshHosts.map((h) => (
                <option key={h.id} value={h.id} disabled={h.mode === 'system'}>
                  {h.label} ({h.hostname})
                  {h.mode === 'system' ? ` — ${t('system ssh, no port forwarding')}` : ''}
                </option>
              ))}
            </Select>
            <p className="text-xs text-faint">
              {t(
                'Shellhouse signs in to the SSH host, forwards a random local port (127.0.0.1) to this computer, points the Remote Desktop client at it, and closes the tunnel when you disconnect.'
              )}
            </p>
          </>
        )}
        {path === 'gateway' && (
          <Field
            label={t('Gateway address')}
            hint={t('Signs in to the gateway with the same credentials.')}
          >
            <Input
              mono
              spellCheck={false}
              data-testid="rdp-gateway"
              placeholder={t('e.g. {example}', { example: 'rdgw.example.com' })}
              value={value.gateway ?? ''}
              onChange={(e) => {
                set('gateway', e.target.value.trim() || null)
              }}
            />
          </Field>
        )}
      </div>
    </div>
  )
}
