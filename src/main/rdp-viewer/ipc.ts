import type { IpcMainInvokeEvent } from 'electron'
import { RdpCertInfo } from '@shared/rdp-viewer'
import type { HostService } from '../hosts/service'
import { handle } from '../ipc/router'
import type { SessionHostSupervisor } from '../session-host/supervisor'
import type { Db } from '../store/db'
import { RdpCertStore } from './cert-store'
import { RdpViewController } from './controller'

export interface RdpViewIpcOptions {
  db: Db
  hosts: () => HostService
  supervisor: Pick<SessionHostSupervisor, 'rdpRequest'>
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  /** Host "dùng gần nhất" thay đổi. */
  notifyChanged: () => void
}

/** IPC của trình xem Remote Desktop trong tab (rdpView:*). */
export function registerRdpViewIpc(options: RdpViewIpcOptions): RdpViewController {
  const controller = new RdpViewController({
    resolve: (hostId, touch) => options.hosts().resolveRdp(hostId, touch),
    certs: new RdpCertStore(options.db),
    probe: async (target) =>
      RdpCertInfo.parse(await options.supervisor.rdpRequest({ type: 'rdp:probe', target })),
    open: async (target, pin) => {
      const result = (await options.supervisor.rdpRequest({ type: 'rdp:open', target, pin })) as {
        proxyAddress: string
        token: string
      }
      return { proxyAddress: result.proxyAddress, token: result.token }
    }
  })
  handle('rdpView:prepare', options.isTrustedSender, (hostId) => controller.prepare(hostId))
  handle('rdpView:probe', options.isTrustedSender, (request) => controller.probe(request))
  handle('rdpView:trust', options.isTrustedSender, (hostId, fingerprint) => {
    controller.trust(hostId, fingerprint)
  })
  handle('rdpView:open', options.isTrustedSender, async (request) => {
    const result = await controller.open(request)
    options.notifyChanged()
    return result
  })
  return controller
}
