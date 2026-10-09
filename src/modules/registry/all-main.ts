import type { MainModule } from './main-types'
import { s3Main } from '../s3/main'
import { dockerMain } from '../docker/main'
import { k8sMain } from '../k8s/main'
import { runbookMain } from '../runbook/main'

/**
 * Module chính thức — import tĩnh (ADR-014 mục 3.9): không nạp code từ đĩa lúc chạy. Thứ tự ở đây
 * là thứ tự mặc định trên thanh bên.
 */
export const MAIN_MODULES: readonly MainModule[] = [s3Main, dockerMain, k8sMain, runbookMain]
