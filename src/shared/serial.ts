import { z } from 'zod'

/** Tốc độ baud thường dùng (console Cisco / Juniper / HP: 9600; thiết bị mới: 115200). */
export const BAUD_RATES = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600
] as const

export const SerialSettings = z.object({
  /** COM3 (Windows), /dev/ttyUSB0 (Linux), /dev/cu.usbserial-… (macOS). */
  path: z
    .string()
    .min(1, 'Choose a serial port')
    .max(256)
    .refine((p) => !p.includes('\0') && !p.startsWith('-'), 'Invalid port name'),
  baudRate: z.number().int().min(50).max(4_000_000),
  dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]),
  parity: z.enum(['none', 'even', 'odd', 'mark', 'space']),
  stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]),
  flowControl: z.enum(['none', 'hardware', 'software'])
})
export type SerialSettings = z.infer<typeof SerialSettings>

/** 9600 8N1, không flow control — mặc định của console hầu hết thiết bị mạng. */
export const DEFAULT_SERIAL: Omit<SerialSettings, 'path'> = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flowControl: 'none'
}

/** "9600 8N1" */
export function serialSummary(s: Omit<SerialSettings, 'path'>): string {
  const parity = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }[s.parity]
  return `${s.baudRate} ${s.dataBits}${parity}${s.stopBits}`
}

export const SerialPortInfo = z.object({
  path: z.string(),
  /** Mô tả (nhà sản xuất, "USB Serial Port"…). */
  description: z.string()
})
export type SerialPortInfo = z.infer<typeof SerialPortInfo>
