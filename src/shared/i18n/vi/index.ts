import { accounts } from './accounts'
import { core } from './core'
import { docker } from './docker'
import { k8s } from './k8s'
import { k8sMap } from './k8sMap'
import { main } from './main'
import { rdp } from './rdp'
import { rdpViewer } from './rdpViewer'
import { s3 } from './s3'
import { terminal } from './terminal'

/**
 * Từ điển tiếng Việt, chia theo vùng để nhiều người sửa cùng lúc không đụng nhau. Một khoá chỉ nên
 * có ở một file; trùng thì file sau đè file trước (test i18n báo các khoá trùng có bản dịch khác nhau).
 */
export const PARTS = {
  core,
  terminal,
  main,
  docker,
  k8s,
  k8sMap,
  s3,
  rdp,
  rdpViewer,
  accounts
} as const

export const vi: Readonly<Record<string, string>> = Object.assign(
  {},
  ...(Object.values(PARTS) as Record<string, string>[])
) as Record<string, string>
