import { registerRdpTabOpener } from '../stores/rdp'
import { useTabs } from '../stores/tabs'

/**
 * Host RDP "Open in: App tab" mở thành tab Remote Desktop (trình xem IronRDP). Mỗi lần mở là một
 * phiên mới — mở nhiều tab tới cùng host được (như mstsc).
 */
registerRdpTabOpener((host) => {
  useTabs.getState().addTarget(host.label, { kind: 'rdp', hostId: host.id })
})
