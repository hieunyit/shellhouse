import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { invokeContract, type InvokeArgs, type InvokeChannel, type InvokeResult } from '@shared/ipc'

export type Handler<C extends InvokeChannel> = (
  ...args: InvokeArgs<C>
) => InvokeResult<C> | Promise<InvokeResult<C>>

/**
 * Đăng ký handler cho một kênh IPC:
 * - chỉ nhận từ frame thuộc app (`isTrustedSender`)
 * - validate tham số bằng zod trước khi gọi handler
 */
export function handle<C extends InvokeChannel>(
  channel: C,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
  handler: Handler<C>
): void {
  const schema = invokeContract[channel].args
  ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
    if (!isTrustedSender(event)) {
      log.warn(`IPC ${channel}: rejected sender ${event.senderFrame?.url ?? 'unknown'}`)
      throw new Error('Forbidden')
    }
    const parsed = schema.safeParse(rawArgs)
    if (!parsed.success) {
      log.warn(`IPC ${channel}: invalid arguments`)
      throw new Error('Invalid arguments')
    }
    return handler(...(parsed.data as InvokeArgs<C>))
  })
}
