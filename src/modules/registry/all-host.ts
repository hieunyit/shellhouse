import type { HostModule } from './host-types'
import { s3Host } from '../s3/session-host'
import { dockerHost } from '../docker/session-host'
import { k8sHost } from '../k8s/session-host'
import { runbookHost } from '../runbook/session-host'

/** Module chính thức phía Session Host — import tĩnh (ADR-014 mục 3.9). */
export const HOST_MODULES: readonly HostModule[] = [s3Host, dockerHost, k8sHost, runbookHost]
