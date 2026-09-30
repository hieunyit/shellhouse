import type { HostModule } from './host-types'
import { s3Host } from '../s3/session-host'

/** Module chính thức phía Session Host — import tĩnh (ADR-014 mục 3.9). */
export const HOST_MODULES: readonly HostModule[] = [s3Host]
