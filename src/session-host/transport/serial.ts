import { t } from '@shared/i18n'
import { SerialPort } from 'serialport'
import type { SerialSettings } from '@shared/serial'
import type { Transport, TransportCallbacks } from './types'

/**
 * Cổng serial (COM trên Windows, /dev/ttyUSB* trên Linux, /dev/cu.* trên macOS) — console của
 * switch, router, thiết bị nhúng. Không có kích thước cửa sổ (thiết bị không biết), không mã hoá.
 */
export class SerialTransport implements Transport {
  private closed = false

  private constructor(
    private readonly port: SerialPort,
    callbacks: TransportCallbacks
  ) {
    port.on('data', (chunk: Buffer) => {
      callbacks.onData(chunk)
    })
    let error: string | undefined
    port.on('error', (e: Error) => {
      error = e.message
    })
    port.on('close', (e?: Error & { disconnected?: boolean }) => {
      if (this.closed) return
      this.closed = true
      // Rút cáp USB-serial → 'close' kèm disconnected = true.
      const reason = e?.disconnected
        ? t('The serial device was disconnected')
        : (error ?? e?.message)
      callbacks.onExit({
        code: reason ? null : 0,
        signal: null,
        ...(reason ? { error: reason } : {})
      })
    })
  }

  static open(settings: SerialSettings, callbacks: TransportCallbacks): Promise<SerialTransport> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({
        path: settings.path,
        baudRate: settings.baudRate,
        dataBits: settings.dataBits,
        parity: settings.parity,
        stopBits: settings.stopBits,
        rtscts: settings.flowControl === 'hardware',
        xon: settings.flowControl === 'software',
        xoff: settings.flowControl === 'software',
        autoOpen: false
      })
      port.open((error) => {
        if (error) {
          reject(new Error(friendlyOpenError(settings.path, error.message)))
          return
        }
        resolve(new SerialTransport(port, callbacks))
      })
    })
  }

  write(data: string): void {
    if (!this.closed) this.port.write(Buffer.from(data, 'utf8'))
  }

  resize(): void {
    // Thiết bị serial không có khái niệm kích thước cửa sổ.
  }

  pause(): void {
    this.port.pause()
  }

  resume(): void {
    this.port.resume()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.port.isOpen) this.port.close()
  }
}

/** Lỗi mở cổng thường gặp → câu dễ hiểu. */
export function friendlyOpenError(path: string, message: string): string {
  if (/access denied|permission denied|EACCES/i.test(message))
    return process.platform === 'linux'
      ? t(
          'Cannot open {path}: permission denied. It may be in use by another program, or your user is not in the "dialout" group.',
          { path }
        )
      : t('Cannot open {path}: permission denied. It may be in use by another program.', { path })
  if (/cannot find|no such file|ENOENT|file not found/i.test(message))
    return t('Serial port {path} was not found. Check the cable and the port name.', { path })
  if (/busy|EBUSY/i.test(message))
    return t('Serial port {path} is in use by another program.', { path })
  return t('Cannot open {path}: {error}', { path, error: message })
}
