import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { BAUD_RATES, type SerialPortInfo, type SerialSettings } from '@shared/serial'
import { Field, IconButton, Input, Select } from './ui'

/** Cấu hình cổng serial trong form host: cổng (dò được hoặc gõ tay), tốc độ, 8N1, flow control. */
export function SerialFields({
  value,
  onChange
}: {
  value: SerialSettings
  onChange: (next: SerialSettings) => void
}): React.JSX.Element {
  const [ports, setPorts] = useState<SerialPortInfo[] | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = (): void => {
    setLoading(true)
    void window.shellhouse
      .listSerialPorts()
      .then(setPorts, () => {
        setPorts([])
      })
      .finally(() => {
        setLoading(false)
      })
  }
  useEffect(() => {
    void window.shellhouse.listSerialPorts().then(setPorts, () => {
      setPorts([])
    })
  }, [])

  const set = <K extends keyof SerialSettings>(key: K, v: SerialSettings[K]): void => {
    onChange({ ...value, [key]: v })
  }

  return (
    <div className="flex flex-col gap-3" data-testid="serial-fields">
      <Field
        label="Serial port"
        hint={
          ports?.length === 0
            ? 'No serial ports found. Plug in the USB-serial cable, then refresh — or type the name.'
            : 'Windows: COM3 · Linux: /dev/ttyUSB0 · macOS: /dev/cu.usbserial-…'
        }
      >
        <div className="flex gap-2">
          <Input
            mono
            list="serial-ports"
            spellCheck={false}
            className="min-w-0 flex-1"
            placeholder={ports?.[0]?.path ?? 'COM3'}
            data-testid="serial-path"
            value={value.path}
            onChange={(e) => {
              set('path', e.target.value.trim())
            }}
          />
          <datalist id="serial-ports">
            {ports?.map((p) => (
              <option key={p.path} value={p.path}>
                {p.description}
              </option>
            ))}
          </datalist>
          <IconButton label="Find serial ports" onClick={refresh}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </IconButton>
        </div>
      </Field>
      <div className="grid grid-cols-5 gap-2">
        <Field label="Speed (baud)" className="col-span-2">
          <Select
            data-testid="serial-baud"
            value={String(value.baudRate)}
            onChange={(e) => {
              set('baudRate', Number(e.target.value))
            }}
          >
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Data bits">
          <Select
            value={String(value.dataBits)}
            onChange={(e) => {
              set('dataBits', Number(e.target.value) as SerialSettings['dataBits'])
            }}
          >
            {[8, 7, 6, 5].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Parity">
          <Select
            value={value.parity}
            onChange={(e) => {
              set('parity', e.target.value as SerialSettings['parity'])
            }}
          >
            {(['none', 'even', 'odd', 'mark', 'space'] as const).map((p) => (
              <option key={p} value={p}>
                {p[0]?.toUpperCase()}
                {p.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Stop bits">
          <Select
            value={String(value.stopBits)}
            onChange={(e) => {
              set('stopBits', Number(e.target.value) as SerialSettings['stopBits'])
            }}
          >
            {[1, 1.5, 2].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Flow control">
        <Select
          value={value.flowControl}
          onChange={(e) => {
            set('flowControl', e.target.value as SerialSettings['flowControl'])
          }}
        >
          <option value="none">None</option>
          <option value="hardware">Hardware (RTS/CTS)</option>
          <option value="software">Software (XON/XOFF)</option>
        </Select>
      </Field>
    </div>
  )
}
